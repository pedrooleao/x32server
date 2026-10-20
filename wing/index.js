'use strict';

// A mesa aparecendo na rede como uma Behringer WING.
//
//   UDP 2222  descoberta ("WING?") e saida dos medidores
//   TCP 2222  protocolo nativo — o que o WING Edit usa
//   UDP 2223  OSC da WING, para quem preferir (TouchOSC, Companion...)
//
// Roda ao lado da X32, nao no lugar dela: as portas sao outras, e o Mixing
// Station continua conectando na 10023 como sempre.

const dgram = require('dgram');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');

const osc = require('../osc');
const {
  ArvoreWing, TIPO, FADER_MIN, normalizarValor, paraCru, deCru, textoDoValor, eFloat,
} = require('./arvore');
const P = require('./protocolo');
const { Ponte } = require('./ponte');

const PORTA_NATIVA = 2222;
const PORTA_OSC = 2223;

// O WING Edit confere a versao da mesa e recusa a que for mais velha que ele
// ("Incompatible Mixer Firmware"). O esquema veio de uma mesa em 3.0.5, mas a
// arvore pouco muda entre versoes: o operador escolhe no menu a versao do WING
// Edit que tem. De partida vai a do WING Edit mais novo que ja vimos (3.3.3, num
// Windows): com 3.0.5 ele recusava logo na descoberta.
const VERSOES = ['3.0.5', '3.0.6', '3.1.0', '3.1.1', '3.2.0', '3.3.0', '3.3.1', '3.3.2', '3.3.3', '3.4.0'];
const FIRMWARE_PADRAO = '3.3.3';

// Como a mesa escreve a versao: "3.0.5-0-g0c2b9d4a:release". O WING Edit le o
// trecho antes do "-g" e mostra "3.0.5-0".
function textoDoFirmware(v) {
  return /[-:]/.test(v) ? v : `${v}-0-g0c2b9d4a:release`;
}
const MODELO = process.env.MESA_WING_MODELO || 'wing-compact';
const SERIAL = process.env.MESA_WING_SERIAL || 'MESAPLAYBACK01';

// Janela de cada inscricao de medidor: o cliente renova a cada 3 s, a mesa
// derruba a inscricao que passa de 5 s sem renovar.
const VALIDADE_MEDIDOR = 5000;

// Quanto o registro de conexoes pode crescer. Ele existe para alguem mandar o
// arquivo quando o WING Edit nao conectar: o comeco de cada conexao e' o que
// importa, nao uma hora de fader.
const REGISTRO_MAX = 4 * 1024 * 1024;
const REGISTRO_POR_CONEXAO = 512 * 1024;

function iniciarWing(o) {
  const {
    nome, ip, lerX32, escreverX32, aoTransporte, medidores, pastaRegistro, aoFalhar,
  } = o;
  let versao = process.env.MESA_WING_FIRMWARE || o.firmware || FIRMWARE_PADRAO;
  let FIRMWARE = textoDoFirmware(versao);
  const depurar = !!(process.env.MESA_DEBUG || process.env.MESA_WING_DEBUG);

  const arvore = new ArvoreWing();
  const clientes = new Set();       // conexoes TCP do protocolo nativo
  const assinantesOsc = new Map();  // "ip:porta" -> { endereco, porta, expira, forma }

  // -------------------------------------------------------------------------
  // Registro
  // -------------------------------------------------------------------------
  const arqRegistro = path.join(pastaRegistro, 'wing-registro.txt');
  let tamRegistro = 0;
  try {
    fs.writeFileSync(arqRegistro, `Mesa de Playback como WING — ${new Date().toISOString()}\n` +
      `firmware ${FIRMWARE}, modelo ${MODELO}\n\n`);
  } catch {
    // Sem onde escrever, segue sem registro.
  }
  // Gravado aos lotes: durante a sincronizacao o WING Edit faz milhares de
  // pedidos, e escrever linha a linha no disco atrasaria as respostas.
  let paraGravar = [];
  function registrar(linha) {
    if (depurar) console.log(`[wing] ${linha}`);
    if (tamRegistro > REGISTRO_MAX) return;
    tamRegistro += linha.length + 1;
    paraGravar.push(linha);
  }
  const relogioRegistro = setInterval(() => {
    if (!paraGravar.length) return;
    const texto = paraGravar.join('\n') + '\n';
    paraGravar = [];
    fs.appendFile(arqRegistro, texto, () => {});
  }, 500);
  relogioRegistro.unref();
  process.on('exit', () => {
    if (paraGravar.length) {
      try { fs.appendFileSync(arqRegistro, paraGravar.join('\n') + '\n'); } catch { /* idem */ }
    }
  });

  // -------------------------------------------------------------------------
  // Valores
  // -------------------------------------------------------------------------
  function definirFixo(caminho, valor) {
    const no = arvore.noPorLogico(caminho);
    if (no) arvore.gravar(no, normalizarValor(no.def, valor));
  }
  definirFixo('/$syscfg/consolename', nome);
  definirFixo('/$syscfg/$firmware', FIRMWARE);
  definirFixo('/$syscfg/$serial', SERIAL);
  definirFixo('/$syscfg/$cnsmdl', MODELO);
  definirFixo('/$syscfg/$hwversion', '1');
  // Cada canal na sua entrada local, como numa mesa recem ligada.
  for (let n = 1; n <= 40; n++) {
    definirFixo(`/ch/${n}/in/conn/grp`, 'LCL');
    definirFixo(`/ch/${n}/in/conn/in`, n);
  }

  /**
   * Grava e avisa todo mundo que estava olhando. `origem` e' quem escreveu: ele
   * nao recebe o proprio valor de volta, a nao ser que a mesa o tenha mudado
   * (fora da faixa, opcao inexistente).
   */
  function definir(no, valor, origem, pedido) {
    const mudados = arvore.gravar(no, valor);
    for (const m of mudados) avisar(m, m === no ? origem : null);
    if (origem && pedido !== undefined && !igualAoPedido(valor, pedido)) origem.enviarValor(no);
    return mudados;
  }

  function igualAoPedido(valor, pedido) {
    if (typeof valor === 'number' && typeof pedido === 'number') return Math.abs(valor - pedido) < 1e-4;
    return valor === pedido;
  }

  function avisar(no, exceto) {
    for (const c of clientes) if (c !== exceto) c.enviarValor(no);
    avisarOsc(no, exceto);
  }

  const ponte = new Ponte({
    lerX32,
    escreverX32,
    aoTransporte,
    lerWing: (caminho) => {
      const no = arvore.noPorLogico(caminho);
      return no && no.def ? arvore.valor(no) : undefined;
    },
    escreverWing: (caminho, valor) => {
      const no = arvore.noPorLogico(caminho);
      if (!no || !no.def || no.def.tipo === TIPO.NO) return;
      const v = normalizarValor(no.def, valor);
      if (v !== undefined) definir(no, v, null);
    },
  });
  ponte.inicializar();

  /** Escrita vinda de um cliente da WING (nativo ou OSC). */
  function escreverDoCliente(no, valor, origem, pedido) {
    if (!no || !no.def || no.def.tipo === TIPO.NO) return;
    if (no.def.soLeitura) {
      origem.enviarValor(no);
      return;
    }
    if (valor === undefined) {
      origem.enviarValor(no);
      return;
    }
    definir(no, valor, origem, pedido);
    ponte.wingEscreveu(no.logico);
    // O comando do player e' um gatilho: volta a IDLE, como na mesa.
    if (no.logico === '/play/$action' && valor !== 'IDLE') definir(no, 'IDLE', null);
  }

  // -------------------------------------------------------------------------
  // UDP 2222: descoberta e medidores
  // -------------------------------------------------------------------------
  const udp = dgram.createSocket('udp4');

  function descricao(quem) {
    return `WING,${ipPara(quem)},${nome},${MODELO},${SERIAL},${FIRMWARE}`;
  }

  // O WING Edit conecta no IP que a descoberta devolve. Num computador com
  // cabo e Wi-Fi ao mesmo tempo, o "primeiro IP" pode ser o da rede errada:
  // devolvemos o da interface que esta na mesma rede de quem perguntou.
  function ipPara(quem) {
    const alvo = quem ? quem.split('.').map(Number) : null;
    if (alvo && alvo.length === 4) {
      for (const lista of Object.values(os.networkInterfaces())) {
        for (const ni of lista || []) {
          if (ni.family !== 'IPv4' || !ni.netmask) continue;
          const a = ni.address.split('.').map(Number);
          const m = ni.netmask.split('.').map(Number);
          if (a.every((x, i) => (x & m[i]) === (alvo[i] & m[i]))) return ni.address;
        }
      }
    }
    return ip();
  }

  udp.on('message', (msg, rinfo) => {
    const texto = msg.toString('latin1');
    if (texto.startsWith('WING?')) {
      const r = Buffer.from(descricao(rinfo.address));
      udp.send(r, 0, r.length, rinfo.port, rinfo.address);
      registrar(`descoberta de ${rinfo.address}:${rinfo.port} -> ${r.toString()}`);
      return;
    }
    registrar(`udp 2222 de ${rinfo.address}:${rinfo.port}, ${msg.length} bytes: ${msg.subarray(0, 64).toString('hex')}`);
  });

  udp.on('error', (err) => aoFalhar(`UDP ${PORTA_NATIVA}`, err));
  udp.bind(PORTA_NATIVA, () => {
    try {
      udp.setBroadcast(true);
    } catch {
      // nao e' preciso para responder
    }
  });

  // -------------------------------------------------------------------------
  // TCP 2222: protocolo nativo
  // -------------------------------------------------------------------------
  class Conexao {
    constructor(sock) {
      this.sock = sock;
      this.nome = `${sock.remoteAddress}:${sock.remotePort}`;
      this.endereco = sock.remoteAddress.replace(/^::ffff:/, '');
      this.escritor = new P.Escritor();
      this.atual = new Map();     // canal -> no' em que o cliente esta
      this.canalDados = 1;        // onde mandar os avisos de mudanca
      this.desconhecidos = new Map();
      this.medidores = new Map(); // inscricao -> { porta, itens, expira }
      this.portaMedidor = 0;
      this.inscricao = null;
      this.coletando = null;
      this.registrados = 0;
      this.leitor = new P.Leitor((canal, tok) => this.token(canal, tok));
      this.agendado = false;

      sock.setNoDelay(true);
      sock.on('data', (d) => {
        if (this.registrados < REGISTRO_POR_CONEXAO) {
          this.registrados += d.length;
          registrar(`${this.nome} <- ${d.toString('hex')}`);
        }
        this.leitor.receber(d);
      });
      sock.on('error', () => {});
      sock.on('close', () => {
        clientes.delete(this);
        registrar(`${this.nome} desconectou`);
      });
      clientes.add(this);
      registrar(`${this.nome} conectou`);
    }

    no(canal) {
      return this.atual.get(canal) || arvore.raiz;
    }

    descrever(no) {
      if (no.desconhecido) return `id ${no.id} (desconhecido)`;
      return no === arvore.raiz ? 'raiz' : `${no.logico}`;
    }

    token(canal, t) {
      if (this.registrados < REGISTRO_POR_CONEXAO && t.tipo !== 'valor') {
        let extra = t.valor !== undefined ? ` ${t.valor}` : t.codigo !== undefined ? ` 0x${t.codigo.toString(16)}` : '';
        if (t.tipo === 'medidor') extra += ` indice ${t.indice}`;
        registrar(`${this.nome} canal ${canal}: ${t.tipo}${extra}`);
      }
      if (canal === 3) {
        this.tokenMedidor(t);
        return;
      }
      this.canalDados = canal;
      const atual = this.no(canal);

      switch (t.tipo) {
        case 'id': {
          const no = arvore.noPorId(t.valor) || this.fantasma(t.valor);
          this.atual.set(canal, no);
          if (this.registrados < REGISTRO_POR_CONEXAO) registrar(`${this.nome}   = ${this.descrever(no)}`);
          return;
        }
        case 'raiz':
          this.atual.set(canal, arvore.raiz);
          return;
        case 'sobe':
          this.atual.set(canal, atual.pai || arvore.raiz);
          return;
        case 'indice':
        case 'nome': {
          if (atual.desconhecido) return;
          const filho = t.tipo === 'indice' ? arvore.filhoPorIndice(atual, t.valor) : arvore.filhoPorNome(atual, t.valor);
          if (filho) this.atual.set(canal, filho);
          else registrar(`${this.nome}   filho ${t.valor} nao existe em ${this.descrever(atual)}`);
          return;
        }
        case 'pedeDados':
          this.responderDados(canal, atual);
          return;
        case 'pedeDefinicao':
          this.responderDefinicao(canal, atual);
          return;
        case 'valor':
          this.receberValor(canal, atual, t);
          return;
        case 'clique':
          this.clique(atual);
          return;
        case 'passo':
          this.passo(atual, t.valor);
          return;
        default:
          return;
      }
    }

    // Um id que o esquema nao conhece — de um firmware mais novo, talvez.
    // Guardamos o que vier para nao quebrar quem le de volta.
    fantasma(id) {
      if (!this.desconhecidos.has(id)) this.desconhecidos.set(id, { id, desconhecido: true, pai: null, valor: undefined });
      return this.desconhecidos.get(id);
    }

    receberValor(canal, no, t) {
      if (this.registrados < REGISTRO_POR_CONEXAO) {
        registrar(`${this.nome} canal ${canal}: valor ${t.forma} ${JSON.stringify(t.valor)} em ${this.descrever(no)}`);
      }
      if (no.desconhecido) {
        no.valor = t;
        return;
      }
      if (!no.def || no.def.tipo === TIPO.NO) return;
      const def = no.def;
      let v;
      if (t.forma === 'cru') v = deCru(def, t.valor);
      else if (t.forma === 'int' && def.tipo === TIPO.ENUM_FLOAT) v = def.itens[t.valor];
      else v = normalizarValor(def, t.valor);
      // Fora da faixa: a mesa grava o limite e devolve o que gravou.
      escreverDoCliente(no, v, this, t.forma === 'cru' ? v : t.valor);
    }

    clique(no) {
      if (!no.def || no.def.tipo === TIPO.NO) return;
      const def = no.def;
      const v = arvore.valor(no);
      if (def.tipo === TIPO.INTEIRO) escreverDoCliente(no, v >= def.max ? def.min : v + 1, this);
      else if (def.tipo === TIPO.ENUM || def.tipo === TIPO.ENUM_FLOAT) {
        const i = def.itens.indexOf(v);
        escreverDoCliente(no, def.itens[(i + 1) % def.itens.length], this);
      }
    }

    passo(no, n) {
      if (!no.def || no.def.tipo === TIPO.NO) return;
      const def = no.def;
      const v = arvore.valor(no);
      let novo;
      if (def.tipo === TIPO.INTEIRO) novo = v + n;
      else if (def.tipo === TIPO.ENUM || def.tipo === TIPO.ENUM_FLOAT) {
        const i = Math.max(0, Math.min(def.itens.length - 1, def.itens.indexOf(v) + n));
        novo = def.itens[i];
      } else {
        const passos = def.passos > 1 ? def.passos - 1 : 200;
        novo = deCru(def, paraCru(def, v) + n / passos);
      }
      escreverDoCliente(no, normalizarValor(def, novo), this);
    }

    bytesDoValor(no) {
      const v = no.desconhecido ? no.valor : arvore.valor(no);
      if (no.desconhecido) {
        if (!v) return null;
        if (v.forma === 'texto') return P.tokenTexto(v.valor);
        if (v.forma === 'int') return P.tokenInteiro(v.valor);
        return P.tokenFloat(v.valor);
      }
      if (v === undefined || v === null) return null;
      const def = no.def;
      if (def.tipo === TIPO.TEXTO || def.tipo === TIPO.ENUM) return P.tokenTexto(v);
      if (eFloat(def)) return P.tokenFloat(v);
      return P.tokenInteiro(v);
    }

    responderDados(canal, no) {
      const lista = [];
      if (no.desconhecido || (no.def && no.def.tipo !== TIPO.NO)) lista.push(no);
      else lista.push(...arvore.folhas(no));
      for (const f of lista) {
        const b = this.bytesDoValor(f);
        if (b) this.escritor.dados(canal, [...P.tokenId(f.id), ...b]);
      }
      this.escritor.dados(canal, P.FIM);
      this.enviar();
    }

    // Folha: a propria definicao. No': a dos filhos que existem agora — e' o
    // que o libwing usa para varrer a arvore.
    responderDefinicao(canal, no) {
      if (!no.desconhecido) {
        const lista = no.def && no.def.tipo !== TIPO.NO ? [no] : arvore.filhosDe(no);
        for (const f of lista) this.escritor.dados(canal, P.tokenDefinicao(f.def.cru));
      }
      this.escritor.dados(canal, P.FIM);
      this.enviar();
    }

    enviarValor(no) {
      const b = this.bytesDoValor(no);
      if (!b) return;
      this.escritor.dados(this.canalDados, [...P.tokenId(no.id), ...b]);
      this.enviar();
    }

    // Junta o que sair na mesma volta do laco num pacote so: uma troca de
    // modelo muda uma dezena de parametros de uma vez.
    enviar() {
      if (this.agendado) return;
      this.agendado = true;
      setImmediate(() => {
        this.agendado = false;
        const b = this.escritor.tirar();
        if (b.length && !this.sock.destroyed) this.sock.write(b);
      });
    }

    tokenMedidor(t) {
      switch (t.tipo) {
        case 'porta':
          this.portaMedidor = t.valor;
          return;
        case 'inscricao': {
          this.inscricao = t.valor;
          const atual = this.medidores.get(t.valor) || { porta: 0, itens: [] };
          if (this.portaMedidor) atual.porta = this.portaMedidor;
          atual.expira = Date.now() + VALIDADE_MEDIDOR;
          this.medidores.set(t.valor, atual);
          return;
        }
        case 'inicio':
          this.coletando = [];
          return;
        case 'medidor':
          if (this.coletando) this.coletando.push(t);
          return;
        case 'fim': {
          if (!this.coletando) return;
          const alvo = this.medidores.get(this.inscricao);
          if (alvo) alvo.itens = this.coletando;
          this.coletando = null;
          return;
        }
        default:
          return;
      }
    }
  }

  const tcp = net.createServer((sock) => new Conexao(sock));
  tcp.on('error', (err) => aoFalhar(`TCP ${PORTA_NATIVA}`, err));
  tcp.listen(PORTA_NATIVA);

  // -------------------------------------------------------------------------
  // Medidores: int16 em 1/256 dB, 20 vezes por segundo
  // -------------------------------------------------------------------------
  const SILENCIO = -32768;
  const palavra = (db) => (isFinite(db) ? Math.max(-32768, Math.min(32767, Math.round(db * 256))) : SILENCIO);
  const emDb = (lin) => (lin > 0 ? 20 * Math.log10(lin) : -Infinity);

  function faderDb(caminho) {
    const no = arvore.noPorLogico(caminho);
    const v = no ? arvore.valor(no) : 0;
    return v <= FADER_MIN ? -Infinity : v;
  }
  function mudo(caminho) {
    const no = arvore.noPorLogico(caminho);
    return no ? !!arvore.valor(no) : false;
  }

  function palavrasDo(item, niveis, gr, saidas) {
    const c = item.codigo;
    const i = item.indice;
    // Canal: entrada L/R, saida L/R, chave e ganho do gate, chave e ganho da
    // dinamica. A versao "2" (AB) acrescenta LED do gate, estado da dinamica e
    // ganho do automix.
    if (c === 0xa0 || c === 0xab) {
      const ent = emDb(niveis[i] || 0);
      const sai = saidas[i];
      const lista = [palavra(ent), palavra(ent), palavra(sai), palavra(sai), palavra(ent), 0, palavra(ent), palavra(emDb(gr[i] || 1))];
      if (c === 0xab) lista.push(0, 0, 0);
      return lista;
    }
    if (c === 0xa3 || c === 0xae) {
      // Main 1: a soma do que sai dos canais, pelo fader do main. Nao e' a soma
      // exata — o player nao mede o master —, mas mexe junto com a musica.
      let soma = 0;
      for (const s of saidas) if (isFinite(s)) soma += Math.pow(10, s / 10);
      const pre = soma > 0 ? 10 * Math.log10(soma) : -Infinity;
      const sai = i === 0 && !mudo('/main/1/mute') ? pre + faderDb('/main/1/fdr') : -Infinity;
      const lista = [palavra(pre), palavra(pre), palavra(sai), palavra(sai), SILENCIO, 0, SILENCIO, 0];
      if (c === 0xae) lista.push(0, 0, 0);
      return lista;
    }
    if (c === 0xa1 || c === 0xa2 || c === 0xa4) return [SILENCIO, SILENCIO, SILENCIO, SILENCIO, SILENCIO, 0, SILENCIO, 0];
    if (c >= 0xac && c <= 0xaf) return [SILENCIO, SILENCIO, SILENCIO, SILENCIO, SILENCIO, 0, SILENCIO, 0, 0, 0, 0];
    if (c === 0xa5) return [SILENCIO, SILENCIO, SILENCIO, SILENCIO];
    if (c === 0xa6) return [SILENCIO, SILENCIO, SILENCIO, SILENCIO, 0, 0, 0, 0, 0, 0];
    if (c === 0xa9) return [SILENCIO, SILENCIO, SILENCIO, SILENCIO, SILENCIO, SILENCIO];
    if (c === 0xaa) return new Array(120).fill(SILENCIO);
    return [SILENCIO];   // fonte (A7) e saida (A8): uma palavra por pedido
  }

  const relogioMedidor = setInterval(() => {
    if (clientes.size === 0) return;
    const agora = Date.now();
    let preparado = null;
    for (const c of clientes) {
      for (const [id, m] of c.medidores) {
        if (m.expira < agora) {
          c.medidores.delete(id);
          continue;
        }
        if (!m.porta || !m.itens.length) continue;
        if (!preparado) {
          const { niveis, gr } = medidores();
          const saidas = [];
          for (let n = 1; n <= 40; n++) {
            const ent = emDb(niveis[n - 1] || 0);
            saidas.push(mudo(`/ch/${n}/mute`) ? -Infinity : ent + faderDb(`/ch/${n}/fdr`));
          }
          preparado = { niveis, gr, saidas };
        }
        const palavras = [];
        for (const item of m.itens) palavras.push(...palavrasDo(item, preparado.niveis, preparado.gr, preparado.saidas));
        const b = Buffer.alloc(4 + palavras.length * 2);
        b.writeUInt32BE(id >>> 0, 0);
        palavras.forEach((p, k) => b.writeInt16BE(p, 4 + k * 2));
        udp.send(b, 0, b.length, m.porta, c.endereco);
      }
    }
  }, 50);

  // -------------------------------------------------------------------------
  // UDP 2223: OSC da WING
  // -------------------------------------------------------------------------
  const udpOsc = dgram.createSocket('udp4');

  function argsDoValor(no, completo) {
    const def = no.def;
    const v = arvore.valor(no);
    if (def.tipo === TIPO.TEXTO || (def.tipo === TIPO.ENUM && !completo)) return [{ type: 's', value: String(v ?? '') }];
    if (!completo) return [{ type: eFloat(def) ? 'f' : 'i', value: Number(v) || 0 }];
    // Leitura completa: texto, posicao 0..1 e valor real, como na mesa.
    const real = eFloat(def) ? { type: 'f', value: Number(v) } : { type: 'i', value: def.tipo === TIPO.ENUM ? Math.max(0, def.itens.indexOf(v)) : Number(v) | 0 };
    return [{ type: 's', value: textoDoValor(def, v) }, { type: 'f', value: paraCru(def, v) }, real];
  }

  function clienteOsc(rinfo) {
    return {
      enviarValor: (no) => {
        const b = osc.encode(no.logico, argsDoValor(no, true));
        udpOsc.send(b, 0, b.length, rinfo.port, rinfo.address);
      },
    };
  }

  function avisarOsc(no, exceto) {
    if (assinantesOsc.size === 0 || !no.def) return;
    const agora = Date.now();
    for (const [chave, a] of assinantesOsc) {
      if (a.expira < agora) {
        assinantesOsc.delete(chave);
        continue;
      }
      if (exceto && exceto.chave === chave) continue;
      const b = osc.encode(no.logico, argsDoValor(no, a.forma === 's'));
      udpOsc.send(b, 0, b.length, a.porta, a.endereco);
    }
  }

  udpOsc.on('message', (msg, rinfo) => {
    const pacote = osc.decode(msg);
    if (!pacote) return;
    const { address, args } = pacote;
    const chave = `${rinfo.address}:${rinfo.port}`;
    const responder = (endereco, a) => {
      const b = osc.encode(endereco, a);
      udpOsc.send(b, 0, b.length, rinfo.port, rinfo.address);
    };

    if (address === '/?') {
      responder('/?', [{ type: 's', value: descricao(rinfo.address) }]);
      return;
    }
    if (address === '/*s' || address === '/*S' || address === '/*') {
      assinantesOsc.set(chave, {
        endereco: rinfo.address, porta: rinfo.port, expira: Date.now() + 10000,
        forma: address === '/*S' ? 'S' : 's',
      });
      return;
    }

    const no = arvore.noPorLogico(address.replace(/\/$/, ''));
    if (!no) {
      registrar(`osc ${address} nao existe`);
      return;
    }
    if (args.length === 0) {
      if (no.def && no.def.tipo !== TIPO.NO) responder(address, argsDoValor(no, true));
      else responder(address, [{ type: 's', value: arvore.filhosDe(no).map((f) => f.def.nome || f.def.indice).join(',') }]);
      return;
    }
    if (!no.def || no.def.tipo === TIPO.NO) return;
    let v = args[0];
    // -1 num liga/desliga e' "inverter o que esta".
    if (no.def.tipo === TIPO.INTEIRO && v === -1 && no.def.min === 0 && no.def.max === 1) v = arvore.valor(no) ? 0 : 1;
    escreverDoCliente(no, normalizarValor(no.def, v), { ...clienteOsc(rinfo), chave }, v);
  });

  udpOsc.on('error', (err) => aoFalhar(`UDP ${PORTA_OSC}`, err));
  udpOsc.bind(PORTA_OSC);

  return {
    arvore,
    arquivoRegistro: arqRegistro,
    versoes: VERSOES,
    get firmware() {
      return versao;
    },
    /** Passa a dizer outra versao. O WING Edit precisa reconectar para ver. */
    definirFirmware(v) {
      versao = v;
      FIRMWARE = textoDoFirmware(v);
      const no = arvore.noPorLogico('/$syscfg/$firmware');
      if (no) definir(no, FIRMWARE, null);
      registrar(`firmware agora e' ${FIRMWARE}`);
    },
    portaNativa: PORTA_NATIVA,
    portaOsc: PORTA_OSC,
    /** Alguem (Mixing Station, o player) mudou este endereco da X32. */
    x32Mudou(endereco) {
      ponte.x32Escreveu(endereco);
    },
    parar() {
      clearInterval(relogioMedidor);
      clearInterval(relogioRegistro);
      for (const c of clientes) c.sock.destroy();
      tcp.close();
      udp.close();
      udpOsc.close();
    },
  };
}

module.exports = { iniciarWing, PORTA_NATIVA, PORTA_OSC, VERSOES };
