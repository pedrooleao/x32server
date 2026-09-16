'use strict';

const dgram = require('dgram');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');

const osc = require('./osc');
const { MixerState, CH_COUNT, faderToGain } = require('./mixer-state');

const OSC_PORT = 10023;      // porta do X32
const HTTP_PORT = 8080;
const CONSOLE_NAME = process.env.MESA_NAME || 'Mesa-Playback';
const FIRMWARE = '4.06';
const MODEL = 'X32';

const state = new MixerState();

// ---------------------------------------------------------------------------
// Clientes OSC inscritos (/xremote vale 10 s e e' renovado pelo app)
// ---------------------------------------------------------------------------
const remotes = new Map(); // "ip:port" -> { address, port, expires, meters }

function remoteKey(rinfo) {
  return `${rinfo.address}:${rinfo.port}`;
}

function touchRemote(rinfo, patch = {}) {
  const key = remoteKey(rinfo);
  const existing = remotes.get(key) || { address: rinfo.address, port: rinfo.port, meters: new Map() };
  remotes.set(key, { ...existing, ...patch, expires: Date.now() + 10000 });
  return remotes.get(key);
}

function pruneRemotes() {
  const now = Date.now();
  for (const [key, r] of remotes) {
    if (r.expires < now) remotes.delete(key);
  }
}
setInterval(pruneRemotes, 2000);

// ---------------------------------------------------------------------------
// Socket OSC
// ---------------------------------------------------------------------------
const udp = dgram.createSocket('udp4');

function send(rinfo, address, args) {
  const buf = osc.encode(address, args);
  udp.send(buf, 0, buf.length, rinfo.port, rinfo.address);
}

function broadcast(address, args, exceptKey) {
  for (const [key, r] of remotes) {
    if (key === exceptKey) continue;
    send(r, address, args);
  }
}

function localIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

// O /showdump nao despeja o estado da mesa: ele devolve os dados de Cue, Scene
// e Snippet do show atual, em mensagens "node". Sem nenhuma cue, cena ou
// snippet gravada, a mesa responde apenas a linha de cabecalho do showfile.
function sendShowdump(rinfo) {
  const header =
    `/-show/showfile/show "${CONSOLE_NAME}" 0 0 0 0 0 0 0 0 0 0`;
  send(rinfo, 'node', [{ type: 's', value: header }]);
  if (process.env.MESA_DEBUG) console.log('-> showdump:', header);
}

udp.on('message', (msg, rinfo) => {
  const packet = osc.decode(msg);
  if (!packet) return;
  const { address, args } = packet;
  const key = remoteKey(rinfo);

  switch (address) {
    case '/xinfo':
      touchRemote(rinfo);
      send(rinfo, '/xinfo', [
        { type: 's', value: localIp() },
        { type: 's', value: CONSOLE_NAME },
        { type: 's', value: MODEL },
        { type: 's', value: FIRMWARE },
      ]);
      return;

    case '/info':
      touchRemote(rinfo);
      send(rinfo, '/info', [
        { type: 's', value: 'V2.07' },
        { type: 's', value: CONSOLE_NAME },
        { type: 's', value: MODEL },
        { type: 's', value: FIRMWARE },
      ]);
      return;

    case '/status':
      touchRemote(rinfo);
      send(rinfo, '/status', [
        { type: 's', value: 'active' },
        { type: 's', value: localIp() },
        { type: 's', value: CONSOLE_NAME },
      ]);
      return;

    case '/xremote':
      touchRemote(rinfo);
      return;

    case '/unsubscribe':
      remotes.delete(key);
      return;

    case '/renew':
      touchRemote(rinfo);
      return;

    case '/meters': {
      // Formato: /meters ,s "/meters/N" [,i ...] — os inteiros extras dizem de
      // que canal e' o conjunto, no caso do /meters/6.
      //
      // Guardamos TODAS as inscricoes, nao so a ultima. O Mixing Station assina
      // um conjunto para a tela do mixer e outro ao abrir a tela do canal; com um
      // slot unico, abrir a tela do canal fazia os medidores do mixer congelarem.
      const target = typeof args[0] === 'string' ? args[0] : '/meters/1';
      const extras = args.slice(1).filter((a) => typeof a === 'number').map((a) => a | 0);
      const r = touchRemote(rinfo);
      r.meters.set(target, extras);

      // O /meters/6 leva o canal cuja tela esta aberta, contado do zero. E' o
      // unico lugar em que o app diz em que canal esta mexendo — ele nunca manda
      // selecao de canal e escreve o ganho sempre em /headamp/000.
      if (/\/meters\/6$/.test(target) && extras.length) {
        const foco = extras[0] + 1;
        if (foco >= 1 && foco <= CH_COUNT) r.foco = foco;
      }
      if (process.env.MESA_DEBUG) console.log('<- /meters', target, extras.join(' '));
      return;
    }

    case '/showdump': {
      touchRemote(rinfo);
      sendShowdump(rinfo);
      return;
    }

    case '/node': {
      touchRemote(rinfo);
      const pedido = String(args[0] || '');
      const line = state.node(pedido);
      // O /node responde antes do log geral, entao sem isto ele nunca aparece.
      if (process.env.MESA_GANHO && /config|routing|headamp|preamp/.test(pedido)) {
        console.log(`NODE   ${pedido}  ->  ${line || '(sem resposta)'}`);
      }
      if (line) send(rinfo, 'node', [{ type: 's', value: line }]);
      return;
    }

    default:
      break;
  }

  touchRemote(rinfo);

  if (process.env.MESA_DEBUG) console.log('<-', address, args);

  // MESA_GANHO=1 mostra so o que tem a ver com ganho de entrada, para descobrir
  // qual endereco o app de controle usa em cada canal sem o barulho do resto.
  if (process.env.MESA_GANHO && /headamp|preamp|config\/source|routing/.test(address)) {
    const valor = args.length ? JSON.stringify(args[0]) : '(leitura)';
    console.log(`GANHO  ${address}  ${valor}`);
  }

  if (args.length === 0) {
    // Leitura de parametro
    const read = state.access(address);
    if (read) send(rinfo, address, [{ type: read.type, value: read.value }]);
    return;
  }

  // Escrita de parametro.
  //
  // O Mixing Station nao descobre qual preamp pertence a qual canal e escreve o
  // ganho sempre em /headamp/000 — sem isto, mexer no ganho de qualquer canal
  // mexia no canal 1. Quando a tela de um canal esta aberta ele assina o
  // /meters/6 daquele canal, e e' esse foco que usamos para entregar o ganho no
  // lugar certo. Um cliente que enderece o preamp corretamente nao passa por
  // aqui, porque so desviamos o indice 0.
  let alvo = address;
  const ha = address.match(/^\/headamp\/(\d{1,3})\/gain$/);
  if (ha && parseInt(ha[1], 10) === 0) {
    const r = remotes.get(key);
    if (r && r.foco) {
      alvo = `/headamp/${String(r.foco - 1).padStart(3, '0')}/gain`;
      if (process.env.MESA_GANHO) console.log(`GANHO  desviado para o canal ${r.foco}: ${alvo}`);
    }
  }

  const written = state.access(alvo, args[0]);
  if (!written) return;

  broadcast(alvo, [{ type: written.type, value: written.value }], key);
  pushToBrowser(alvo, written);
});

// Quem embrulha a mesa numa janela (main.js do Electron) escuta estes eventos:
// rodando no Terminal nao ha ninguem ouvindo, e o comportamento antigo continua
// — mensagem no console e saida. Numa janela, morrer calado seria o app sumindo
// sem explicacao.
const eventos = new EventEmitter();
module.exports = eventos;

function falhar(titulo, detalhe) {
  console.error(`\n${titulo}\n${detalhe}`);
  if (eventos.listenerCount('falhou') > 0) eventos.emit('falhou', titulo, detalhe);
  else process.exit(1);
}

udp.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    falhar(
      `A porta ${OSC_PORT} já está ocupada.`,
      'Outro programa está usando a porta da mesa. Feche o X32-Edit, outro emulador, ou outra cópia deste app, e abra de novo.'
    );
  } else {
    falhar('Erro na rede da mesa.', err.message);
  }
});

udp.bind(OSC_PORT, () => {
  console.log(`Mesa "${CONSOLE_NAME}" no ar como ${MODEL} em ${localIp()}:${OSC_PORT}`);
  console.log(`No tablet: Mixing Station -> Behringer X32 -> ${localIp()} porta ${OSC_PORT}`);
  console.log('');
  // Abrir o player pelo IP da rede tira o contexto seguro e desliga o gate
  // (AudioWorklet so existe em https ou localhost), entao mandamos no localhost.
  console.log(`Player de playback, aqui no Mac: http://localhost:${HTTP_PORT}`);
  eventos.emit('pronto', { url: `http://localhost:${HTTP_PORT}`, ip: localIp(), porta: OSC_PORT });
});

// ---------------------------------------------------------------------------
// HTTP + WebSocket para o navegador (engine de audio)
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const file = url === '/' ? 'index.html' : url.replace(/^\//, '');
  const full = path.join(__dirname, 'public', file);
  if (!full.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403).end('Acesso negado');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404).end('Nao encontrado');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

// Guardamos todos os navegadores abertos, nao so o ultimo. Com um slot unico,
// abrir a pagina duas vezes fazia a aba antiga parar de receber para sempre: a
// segunda aba tomava o slot e, ao fecha-la, o slot ficava apontando para um
// socket morto enquanto a primeira seguia aberta e muda.
const browsers = new Set();

wss.on('connection', (ws) => {
  browsers.add(ws);
  ws.send(JSON.stringify({ type: 'snapshot', state: state.snapshot() }));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'names') {
      // O navegador leu a pasta de stems e nomeou os canais.
      msg.names.forEach((name, i) => {
        if (i >= CH_COUNT) return;
        state.access(`/ch/${String(i + 1).padStart(2, '0')}/config/name`, name);
        broadcast(`/ch/${String(i + 1).padStart(2, '0')}/config/name`, [{ type: 's', value: name }]);
      });
      const usados = msg.names.filter((n) => n);
      console.log(`${usados.length} stems carregados: ${usados.join(', ')}`);
    }

    if (msg.type === 'pedirSnapshot') {
      ws.send(JSON.stringify({ type: 'snapshot', state: state.snapshot() }));
    }

    if (msg.type === 'meters') {
      lastMeters = msg.values;                 // nivel 0..1 por canal
      if (Array.isArray(msg.gr)) lastGr = msg.gr;  // reducao do comp, 1 = nenhuma
    }

    if (msg.type === 'tape') {
      state.tapeState = msg.value | 0;
      broadcast('/-stat/tape/state', [{ type: 'i', value: state.tapeState }]);
    }
  });

  ws.on('close', () => {
    browsers.delete(ws);
  });
});

function pushToBrowser(address, written) {
  if (browsers.size === 0) return;

  // Para blocos de processamento (eq/gate/dyn) mandamos o canal inteiro:
  // e' mais barato do que reconstruir o estado no navegador parametro a parametro.
  // O ganho pode chegar por /ch/NN/preamp/trim ou por /headamp/NNN/gain, que nao
  // tem numero de canal no endereco: resolvemos os dois para o mesmo canal.
  let channel;
  const chMatch = address.match(/^\/ch\/(\d{2})\//);
  const haMatch = address.match(/^\/headamp\/(\d{1,3})\/gain$/);
  // O solo tambem chega sem numero de canal no formato de sempre: e' o
  // /-stat/solosw/NN, numerado de 01 a 80.
  const soloMatch = address.match(/^\/-stat\/solosw\/(\d{1,2})$/);
  const num = chMatch
    ? parseInt(chMatch[1], 10)
    : haMatch
      ? parseInt(haMatch[1], 10) + 1
      : soloMatch
        ? parseInt(soloMatch[1], 10)
        : null;
  if (num) {
    const c = state.channel(num);
    if (c) channel = { num, eq: c.eq, gate: c.gate, dyn: c.dyn, trim: c.trim, ha: c.gain };
  }

  // O solo muda quem se ouve em TODOS os canais, nao so no que foi tocado:
  // ligar o solo do canal 3 cala os outros 31. Entao mandamos o quadro inteiro.
  const solos = soloMatch ? state.channels.map((c) => c.solo) : undefined;

  const payload = JSON.stringify({
    type: 'param',
    address,
    channel,
    solos,
    value: written.value,
    gain: written.type === 'f' && /mix\/fader$/.test(address) ? faderToGain(written.value) : undefined,
  });

  for (const ws of browsers) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    falhar(
      `A porta ${HTTP_PORT} já está ocupada.`,
      'Outro programa está usando a porta do player. Feche a outra cópia deste app e abra de novo.'
    );
  } else {
    falhar('Erro no servidor do player.', err.message);
  }
});

server.listen(HTTP_PORT);

// ---------------------------------------------------------------------------
// Medidores: o navegador manda RMS por canal, repassamos no formato do X32
// ---------------------------------------------------------------------------
let lastMeters = new Array(CH_COUNT).fill(0);
// Reducao de ganho do compressor por canal, como MULTIPLICADOR: 1 = sem reducao.
// Atencao a essa convencao: nos campos de gate e dinamica do X32, 0 nao e'
// "parado", e' "reduzindo tudo". Mandando 0 ali, o Mixing Station desenhava as
// barrinhas de gate e comp cheias e imoveis na tela do canal.
let lastGr = new Array(CH_COUNT).fill(1);

// Blob do X32: int32 com a contagem + N floats little-endian.
function blobDeFloats(valores) {
  const buf = Buffer.alloc(4 + valores.length * 4);
  buf.writeInt32LE(valores.length, 0);
  valores.forEach((v, i) => buf.writeFloatLE(v, 4 + i * 4));
  return buf;
}

function valoresDoMedidor(target, extras) {
  const m = /\/meters\/(\d+)/.exec(target);
  const conjunto = m ? parseInt(m[1], 10) : 1;

  // /meters/6 <canal>: os 4 medidores da tira de canal, que e' o que a tela de
  // ganho do Mixing Station desenha — entrada, reducao do gate, reducao do
  // comp e pos-fader.
  if (conjunto === 6) {
    const ch = extras[0] | 0;
    if (ch < 0 || ch >= CH_COUNT) return null;
    const nivel = lastMeters[ch] || 0;
    return [nivel, 1, lastGr[ch] || 1, nivel];
  }

  // /meters/1: 96 floats — 32 entradas, 32 reducoes de gate, 32 de dinamica.
  const v = new Array(96).fill(1);
  for (let i = 0; i < 96; i++) {
    if (i < 32) v[i] = i < CH_COUNT ? lastMeters[i] || 0 : 0;
    else if (i < 64) v[i] = 1;                              // gate, sem reducao
    else v[i] = lastGr[i - 64] || 1;                        // dinamica
  }
  return v;
}

setInterval(() => {
  for (const r of remotes.values()) {
    if (!r.meters || r.meters.size === 0) continue;
    for (const [target, extras] of r.meters) {
      const valores = valoresDoMedidor(target, extras);
      if (valores) send(r, target, [{ type: 'b', value: blobDeFloats(valores) }]);
    }
  }
}, 50);

process.on('SIGINT', () => {
  console.log('\nDesligando a mesa.');
  udp.close();
  process.exit(0);
});
