'use strict';

// Teste da WING: fala com uma mesa que ja esteja no ar como um cliente do
// protocolo nativo falaria — o mesmo dialogo do libwing — e confere que a
// ponte com a X32 funciona nos dois sentidos.
//
//   node server.js &
//   node scripts/teste-wing.js
//
// O decodificador daqui e' escrito do lado do CLIENTE, de proposito separado
// do wing/protocolo.js: se os dois concordassem num erro, o teste passaria.

const dgram = require('dgram');
const net = require('net');
const path = require('path');

const osc = require(path.join(__dirname, '..', 'osc.js'));

const HOST = process.env.MESA_HOST || '127.0.0.1';
const NATIVA = 2222;
const OSC_WING = 2223;
const OSC_X32 = 10023;

const falhas = [];
const ok = (t) => console.log(`  ok    ${t}`);
const falhou = (t, d) => { falhas.push(t); console.log(`  FALHA ${t}${d ? ' — ' + d : ''}`); };
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Ids do esquema (firmware 3.0.5), conferidos no propmap do libwing.
const ID = {
  firmware: null,           // achado navegando, para testar a navegacao tambem
  ch1fdr: 950957506,
  ch1mute: -183539208,
  ch1gateMdl: 1174189065,
  ch1gateSlot1: -1952441044,  // thr no GATE, thr no E88, att no WAVE
};

// ---------------------------------------------------------------------------
// Cliente do protocolo nativo
// ---------------------------------------------------------------------------
class Cliente {
  constructor(sock) {
    this.sock = sock;
    this.fila = Buffer.alloc(0);
    this.pos = 0;
    this.esc = false;
    this.pipe = null;
    this.canal = -1;
    this.eventos = [];
    this.esperando = [];
    this.noAtual = 0;
    sock.on('data', (d) => {
      this.fila = Buffer.concat([this.fila.subarray(this.pos), d]);
      this.pos = 0;
      this.decodificar();
    });
  }

  static conectar() {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: HOST, port: NATIVA });
      s.once('connect', () => {
        s.write(Buffer.from([0xdf, 0xd1]));
        resolve(new Cliente(s));
      });
      s.once('error', reject);
    });
  }

  // Um byte ja sem o escape, como o decode_next do libwing.
  proximo() {
    if (this.pipe !== null) {
      const b = this.pipe;
      this.pipe = null;
      return b;
    }
    while (this.pos < this.fila.length) {
      const b = this.fila[this.pos++];
      if (!this.esc) {
        if (b === 0xdf) { this.esc = true; continue; }
        return b;
      }
      this.esc = false;
      if (b === 0xdf || b === 0xde) return 0xdf;
      if (b >= 0xd0 && b < 0xde) { this.canal = b - 0xd0; continue; }
      this.pipe = b;
      return 0xdf;
    }
    return undefined;
  }

  // Le um token inteiro ou devolve tudo para a fila e espera mais bytes.
  decodificar() {
    for (;;) {
      const copia = { pos: this.pos, esc: this.esc, pipe: this.pipe, canal: this.canal, noAtual: this.noAtual };
      const ev = this.lerToken();
      if (ev === undefined) {
        Object.assign(this, copia);
        return;
      }
      if (ev === null) continue;
      this.eventos.push(ev);
      const w = this.esperando.filter((x) => x.teste(ev));
      for (const x of w) {
        this.esperando.splice(this.esperando.indexOf(x), 1);
        x.resolve(ev);
      }
    }
  }

  lerToken() {
    const ler = (n) => {
      const b = [];
      for (let i = 0; i < n; i++) {
        const x = this.proximo();
        if (x === undefined) return undefined;
        b.push(x);
      }
      return Buffer.from(b);
    };
    const c = this.proximo();
    if (c === undefined) return undefined;
    if (c <= 0x3f) return { tipo: 'dado', id: this.noAtual, valor: c };
    if (c <= 0x7f) return null;
    if (c <= 0xcf) {
      const b = ler(c - (c <= 0xbf ? 0x80 : 0xc0) + 1);
      return b && { tipo: 'dado', id: this.noAtual, valor: b.toString('utf8') };
    }
    switch (c) {
      case 0xd0: return { tipo: 'dado', id: this.noAtual, valor: '' };
      case 0xd1: {
        const n = ler(1);
        if (!n) return undefined;
        const b = ler(n[0] + 1);
        return b && { tipo: 'dado', id: this.noAtual, valor: b.toString('utf8') };
      }
      case 0xd3: { const b = ler(2); return b && { tipo: 'dado', id: this.noAtual, valor: b.readInt16BE(0) }; }
      case 0xd4: { const b = ler(4); return b && { tipo: 'dado', id: this.noAtual, valor: b.readInt32BE(0) }; }
      case 0xd5:
      case 0xd6: { const b = ler(4); return b && { tipo: 'dado', id: this.noAtual, valor: b.readFloatBE(0) }; }
      case 0xd7: {
        const b = ler(4);
        if (!b) return undefined;
        this.noAtual = b.readInt32BE(0);
        return null;
      }
      case 0xde: return { tipo: 'fim' };
      case 0xdf: {
        const t = ler(2);
        if (!t) return undefined;
        const raw = ler(t.readUInt16BE(0));
        if (!raw) return undefined;
        const nl = raw[10];
        return {
          tipo: 'def',
          pai: raw.readInt32BE(0),
          id: raw.readInt32BE(4),
          indice: raw.readUInt16BE(8),
          nome: raw.toString('utf8', 11, 11 + nl),
        };
      }
      default: return null;
    }
  }

  esperar(teste, ms = 3000) {
    const ja = this.eventos.find(teste);
    if (ja) return Promise.resolve(ja);
    return new Promise((resolve) => {
      const x = { teste, resolve };
      this.esperando.push(x);
      setTimeout(() => {
        const i = this.esperando.indexOf(x);
        if (i >= 0) { this.esperando.splice(i, 1); resolve(null); }
      }, ms);
    });
  }

  /** Manda e junta tudo ate o DE que fecha a resposta. */
  async pedir(bytes, ms = 5000) {
    this.eventos = [];
    this.sock.write(Buffer.from(bytes));
    const fim = await this.esperar((e) => e.tipo === 'fim', ms);
    if (!fim) return null;
    const lista = this.eventos.slice(0, this.eventos.indexOf(fim));
    this.eventos = this.eventos.slice(this.eventos.indexOf(fim) + 1);
    return lista;
  }

  fechar() {
    this.sock.destroy();
  }
}

function id32(id) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(id, 0);
  const r = [];
  for (const x of b) { r.push(x); if (x === 0xdf) r.push(0xde); }
  return r;
}

function float32(v) {
  const b = Buffer.alloc(4);
  b.writeFloatBE(v, 0);
  const r = [];
  for (const x of b) { r.push(x); if (x === 0xdf) r.push(0xde); }
  return r;
}

function texto(s) {
  return [0x80 + s.length - 1, ...Buffer.from(s)];
}

function nome(s) {
  return [0xc0 + s.length - 1, ...Buffer.from(s)];
}

function oscPedir(porta, endereco, args = []) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const prazo = setTimeout(() => { sock.close(); resolve(null); }, 3000);
    sock.on('message', (m) => { clearTimeout(prazo); sock.close(); resolve(osc.decode(m)); });
    const b = osc.encode(endereco, args);
    sock.send(b, 0, b.length, porta, HOST);
  });
}

function oscMandar(porta, endereco, args) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const b = osc.encode(endereco, args);
    sock.send(b, 0, b.length, porta, HOST, () => { sock.close(); resolve(); });
  });
}

// ---------------------------------------------------------------------------
async function main() {
  console.log(`Testando a WING em ${HOST}`);

  // Descoberta
  const descoberta = await new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    const prazo = setTimeout(() => { s.close(); resolve(null); }, 3000);
    s.on('message', (m) => { clearTimeout(prazo); s.close(); resolve(m.toString()); });
    s.bind(0, () => s.send(Buffer.from('WING?'), NATIVA, HOST));
  });
  const campos = descoberta ? descoberta.split(',') : [];
  if (campos.length === 6 && campos[0] === 'WING') ok(`descoberta: ${descoberta}`);
  else falhou('descoberta respondeu WING,ip,nome,modelo,serie,firmware', String(descoberta));

  let c;
  try {
    c = await Cliente.conectar();
    ok('conectou na porta TCP 2222');
  } catch (err) {
    falhou('conectou na porta TCP 2222', err.message);
    return;
  }

  // Definicoes da raiz: e' por aqui que um cliente descobre a arvore.
  const raiz = await c.pedir([0xda, 0xdd]);
  const nomes = raiz ? raiz.filter((e) => e.tipo === 'def').map((e) => e.nome) : [];
  if (['ch', 'bus', 'main', '$syscfg'].every((n) => nomes.includes(n))) ok(`raiz: ${nomes.join(' ')}`);
  else falhou('raiz tem ch, bus, main e $syscfg', nomes.join(' '));

  // Navegar pelo nome ate o firmware e pedir o valor.
  const fw = await c.pedir([0xda, ...nome('$syscfg'), ...nome('$firmware'), 0xdc]);
  const vfw = fw && fw.find((e) => e.tipo === 'dado');
  if (vfw && /^\d+\.\d+/.test(vfw.valor)) ok(`navegou ate /$syscfg/$firmware: ${vfw.valor}`);
  else falhou('navegou ate /$syscfg/$firmware', JSON.stringify(fw));

  // Indice: /ch/1 e' o filho de indice 1 de /ch.
  const filhos = await c.pedir([0xda, ...nome('ch'), 0x40, 0xdd]);
  const nf = filhos ? filhos.filter((e) => e.tipo === 'def').map((e) => e.nome) : [];
  if (nf.includes('fdr') && nf.includes('eq')) ok(`/ch/1 pelo indice: ${nf.length} filhos`);
  else falhou('/ch/1 pelo indice', nf.join(' '));

  // Fader pela WING -> X32.
  c.sock.write(Buffer.from([0xd7, ...id32(ID.ch1fdr), 0xd5, ...float32(-10)]));
  await esperar(200);
  const fx32 = await oscPedir(OSC_X32, '/ch/01/mix/fader');
  if (fx32 && Math.abs(fx32.args[0] - 0.5) < 0.002) ok('fader -10 dB na WING virou 0.5 na X32');
  else falhou('fader da WING chegou na X32', fx32 && String(fx32.args[0]));

  const fdr = await c.pedir([0xd7, ...id32(ID.ch1fdr), 0xdc]);
  const vf = fdr && fdr.find((e) => e.tipo === 'dado' && e.id === ID.ch1fdr);
  if (vf && Math.abs(vf.valor + 10) < 0.01) ok('fader le de volta -10 dB');
  else falhou('fader le de volta', JSON.stringify(fdr));

  // Mute pela X32 -> aviso na WING, sem pedir nada.
  c.eventos = [];
  await oscMandar(OSC_X32, '/ch/01/mix/on', [{ type: 'i', value: 0 }]);
  const aviso = await c.esperar((e) => e.tipo === 'dado' && e.id === ID.ch1mute);
  if (aviso && aviso.valor === 1) ok('mute no Mixing Station apareceu na WING');
  else falhou('mute da X32 avisou a WING', JSON.stringify(aviso));
  await oscMandar(OSC_X32, '/ch/01/mix/on', [{ type: 'i', value: 1 }]);

  // Modelo do gate: o encaixe 1 muda de definicao.
  c.eventos = [];
  c.sock.write(Buffer.from([0xd7, ...id32(ID.ch1gateMdl), ...texto('E88')]));
  await esperar(200);
  const gate = await c.pedir([0xd7, ...id32(ID.ch1gateMdl), 0xdb, 0xdd]);
  const ng = gate ? gate.filter((e) => e.tipo === 'def').map((e) => e.nome) : [];
  if (ng.includes('hyst') && ng.includes('m40')) ok(`gate em E88: ${ng.join(' ')}`);
  else falhou('trocar o modelo do gate trocou os botoes', ng.join(' '));
  c.sock.write(Buffer.from([0xd7, ...id32(ID.ch1gateMdl), ...texto('GATE')]));
  await esperar(200);
  const thr = await c.pedir([0xd7, ...id32(ID.ch1gateSlot1), 0xdc]);
  const vthr = thr && thr.find((e) => e.tipo === 'dado');
  // Voltando ao GATE, o threshold vem do estado (-40 dB), nao do valor de
  // partida do encaixe, que e' 0 dB e calaria o canal.
  if (vthr && Math.abs(vthr.valor + 40) < 0.5) ok(`voltou ao GATE com threshold do estado: ${vthr.valor.toFixed(1)} dB`);
  else falhou('voltar ao GATE recupera o threshold', JSON.stringify(thr));

  // Despejo da arvore inteira.
  const t0 = Date.now();
  const tudo = await c.pedir([0xda, 0xdc], 20000);
  const qtd = tudo ? tudo.filter((e) => e.tipo === 'dado').length : 0;
  if (qtd > 20000) ok(`arvore inteira: ${qtd} valores em ${Date.now() - t0} ms`);
  else falhou('arvore inteira', `${qtd} valores`);

  // Medidores pelo canal 3, chegando por UDP.
  const med = dgram.createSocket('udp4');
  await new Promise((r) => med.bind(0, r));
  const porta = med.address().port;
  const pacote = new Promise((resolve) => {
    const prazo = setTimeout(() => resolve(null), 3000);
    med.on('message', (m) => { clearTimeout(prazo); resolve(m); });
  });
  c.sock.write(Buffer.from([
    0xdf, 0xd3,
    0xd3, porta >> 8, porta & 0xff,
    0xd4, 0x00, 0x07, porta >> 8, porta & 0xff,
    0xdc, 0xa0, 0x00, 0xa0, 0x01, 0xa3, 0x00, 0xde,
    0xdf, 0xd1,
  ]));
  const m = await pacote;
  med.close();
  if (m && m.length === 4 + 3 * 8 * 2 && m.readUInt16BE(0) === 7) ok(`medidores: ${m.length} bytes por UDP, id 7`);
  else falhou('medidores chegaram por UDP', m ? `${m.length} bytes` : 'nada');

  c.fechar();

  // OSC da WING.
  const info = await oscPedir(OSC_WING, '/?');
  if (info && /^WING,/.test(info.args[0])) ok(`OSC /?: ${info.args[0]}`);
  else falhou('OSC da WING respondeu /?');
  const ofdr = await oscPedir(OSC_WING, '/ch/1/fdr');
  if (ofdr && ofdr.args.length === 3 && Math.abs(ofdr.args[2] + 10) < 0.01) ok(`OSC /ch/1/fdr: ${ofdr.args[0]} dB`);
  else falhou('OSC da WING le o fader', ofdr && JSON.stringify(ofdr.args));
}

main()
  .catch((err) => falhou('o teste rodou ate o fim', err.message))
  .finally(() => {
    console.log(falhas.length ? `\n${falhas.length} falha(s)` : '\nTudo certo');
    process.exit(falhas.length ? 1 : 0);
  });
