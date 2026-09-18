'use strict';

const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
const master = ctx.createGain();
master.connect(ctx.destination);

let tracks = [];
// O relogio da musica e' o do AudioContext, nao o de um elemento <audio>.
// Os blocos de PCM sao agendados por ele, entao as faixas nao derivam entre si.
const relogio = { base: 0, t0: 0, tocando: false };

function posicao() {
  if (!relogio.tocando) return relogio.base;
  return Math.min(duration, relogio.base + (ctx.currentTime - relogio.t0));
}
let duration = 0;
let workletReady = false;
let scrubbing = false;

const el = (id) => document.getElementById(id);

// Clipe: acende em 0 dBFS e segura aceso, como a luz vermelha de uma mesa.
const CLIPE_NIVEL = 0.99;
const CLIPE_SEGURA = 1500;   // ms
let clipeMasterAte = 0;

// Saida paralela para gravar a mixagem. Fica pendurada no master, entao grava
// exatamente o que se ouve — com fader, mute, solo, EQ, gate e compressor.
const gravacao = ctx.createMediaStreamDestination();
master.connect(gravacao);

// ---------------------------------------------------------------------------
// Os dois efeitos: delay no bus 1, reverb no bus 2
//
// Envio classico de console: cada canal manda um tanto para o bus, o bus
// processa, e o fader do bus decide quanto do efeito volta para o LR. O envio
// sai DEPOIS do fader do canal, que e' o normal para efeito — baixar o canal
// leva o efeito junto, em vez de deixar so o rastro tocando.
// ---------------------------------------------------------------------------
const FX_TEMPO_MAX = 1.5;      // s, o maximo do delay
const FX_CAUDA_MAX = 6;        // s, a cauda mais longa do reverb

function construirEfeitos(contexto, destino) {
  // --- delay, com realimentacao e um corte de agudo a cada repeticao, que e'
  // o que faz a cauda soar natural em vez de metalica.
  const entradaDelay = contexto.createGain();
  const linha = contexto.createDelay(FX_TEMPO_MAX);
  const realimenta = contexto.createGain();
  const corte = contexto.createBiquadFilter();
  corte.type = 'lowpass';
  corte.frequency.value = 3200;
  const faderDelay = contexto.createGain();

  entradaDelay.connect(linha);
  linha.connect(corte).connect(realimenta).connect(linha);
  linha.connect(faderDelay).connect(destino);

  // --- reverb por convolucao. A resposta impulsiva e' gerada aqui mesmo:
  // ruido que decai exponencialmente. Nao e' uma sala medida, mas soa como
  // sala e nao custa arquivo nenhum.
  const entradaReverb = contexto.createGain();
  const convolucao = contexto.createConvolver();
  const faderReverb = contexto.createGain();
  entradaReverb.connect(convolucao).connect(faderReverb).connect(destino);

  return { entradaDelay, linha, realimenta, faderDelay, entradaReverb, convolucao, faderReverb };
}

function gerarCauda(contexto, segundos) {
  const n = Math.max(1, Math.floor(contexto.sampleRate * segundos));
  const buf = contexto.createBuffer(2, n, contexto.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      // O expoente 2.2 tira o "chiado" do fim que um decaimento reto deixa.
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.2);
    }
  }
  return buf;
}

const fx = construirEfeitos(ctx, master);
// Estado dos efeitos, para nao regerar a cauda a cada mensagem.
let caudaAtual = -1;

function aplicarFx(lista) {
  if (!lista || lista.length < 2) return;
  const agora = ctx.currentTime;

  // Delay: par 01 = tempo, par 02 = realimentacao.
  const tempo = Math.max(0.02, lista[0].par[0] * FX_TEMPO_MAX);
  fx.linha.delayTime.setTargetAtTime(tempo, agora, 0.05);
  // Ate 0.85: acima disso a realimentacao cresce sozinha e nao para mais.
  fx.realimenta.gain.setTargetAtTime(Math.min(0.85, lista[0].par[1]), agora, 0.05);

  // Reverb: par 01 = tamanho da cauda.
  const segundos = Math.max(0.3, lista[1].par[0] * FX_CAUDA_MAX);
  if (Math.abs(segundos - caudaAtual) > 0.05) {
    caudaAtual = segundos;
    fx.convolucao.buffer = gerarCauda(ctx, segundos);
  }
}

function aplicarBuses(buses) {
  if (!buses || buses.length < 2) return;
  const agora = ctx.currentTime;
  // O fader do bus e' o quanto do efeito volta para o LR.
  fx.faderDelay.gain.setTargetAtTime(buses[0].on ? faderToGain(buses[0].fader) : 0, agora, 0.02);
  fx.faderReverb.gain.setTargetAtTime(buses[1].on ? faderToGain(buses[1].fader) : 0, agora, 0.02);
}

function aplicarEnvios(t, sends, sendsOn) {
  if (!t.envio) return;
  const agora = ctx.currentTime;
  for (let i = 0; i < 2; i++) {
    const nivel = sends && sends[i] !== undefined ? sends[i] : 0;
    const ligado = !sendsOn || sendsOn[i] === undefined || sendsOn[i] === 1;
    t.envio[i].gain.setTargetAtTime(ligado ? faderToGain(nivel) : 0, agora, 0.02);
  }
}

const sondaMaster = ctx.createAnalyser();
sondaMaster.fftSize = 1024;
master.connect(sondaMaster);
const dadosMaster = new Float32Array(sondaMaster.fftSize);

// ---------------------------------------------------------------------------
// WebSocket com o servidor OSC
// ---------------------------------------------------------------------------
let ws;

function connect() {
  ws = new WebSocket(`ws://${location.host}`);

  ws.onopen = () => {
    el('wsdot').classList.add('up');
    el('wsstate').textContent = 'conectado';
  };

  ws.onclose = () => {
    el('wsdot').classList.remove('up');
    el('wsstate').textContent = 'offline';
    setTimeout(connect, 1500);
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'snapshot') {
      msg.state.channels.forEach((c, i) => applyChannel(i, c));
      aplicarSolos(msg.state.channels.map((c) => c.solo));
      aplicarFx(msg.state.fx);
      aplicarBuses(msg.state.buses);
      main.fader = msg.state.main.fader;
      main.on = msg.state.main.on;
      refreshMaster();
      return;
    }
    if (msg.type === 'param') handleParam(msg);
    if (msg.type === 'pasta') receberPasta(msg);
  };
}

function handleParam({ address, value, gain, channel: msgState, solos, buses, fx: fxEstado }) {
  // Buses 1 e 2 sao os retornos de efeito; /fx/... e' o ajuste dos efeitos.
  if (buses) aplicarBuses(buses);
  if (fxEstado) aplicarFx(fxEstado);
  if (/^\/(bus|fx)\//.test(address)) return;
  // Ganho de preamp: chega sem numero de canal. O servidor ja resolveu de qual
  // canal e', pelo foco, e manda o bloco do canal em msgState.
  if (/^\/headamp\/\d{1,3}\/gain$/.test(address)) {
    const t = msgState && tracks[msgState.num - 1];
    if (t) applyTrim(t, msgState.ha, msgState.trim);
    return;
  }

  // Solo: o servidor manda o quadro inteiro, porque um solo mexe em todos.
  if (/^\/-stat\/solosw\/\d{1,2}$/.test(address)) {
    if (solos) aplicarSolos(solos);
    return;
  }

  const chMatch = address.match(/^\/ch\/(\d{2})\/(.+)$/);
  if (chMatch) {
    const t = tracks[parseInt(chMatch[1], 10) - 1];
    if (!t) return;
    const key = chMatch[2];
    if (key === 'mix/fader') {
      t.fader = value;
      rampGain(t);
      paintStrip(tracks.indexOf(t));
    } else if (key === 'mix/on') {
      t.on = value ? 1 : 0;
      rampGain(t);
      paintStrip(tracks.indexOf(t));
    } else if (key === 'mix/pan') {
      t.pan.pan.setTargetAtTime((value - 0.5) * 2, ctx.currentTime, 0.02);
    } else if (key === 'preamp/trim') {
      applyTrim(t, msgState && msgState.ha, value);
    } else if (key.startsWith('preamp/hp')) {
      if (msgState) applyHp(t, msgState.hp);
    } else if (/^mix\/\d{2}\/(level|on)$/.test(key)) {
      if (msgState) aplicarEnvios(t, msgState.sends, msgState.sendsOn);
    } else if (msgState) {
      if (key.startsWith('eq')) applyEqAll(t, msgState.eq);
      if (key.startsWith('gate')) applyGate(t, msgState.gate);
      if (key.startsWith('dyn')) applyDyn(t, msgState.dyn);
    }
    return;
  }
  if (address === '/main/st/mix/fader') {
    main.fader = value;
    refreshMaster();
  }
  if (address === '/main/st/mix/on') {
    main.on = value ? 1 : 0;
    refreshMaster();
  }
}

function applyChannel(i, c) {
  const t = tracks[i];
  if (!t) return;
  t.fader = c.fader;
  t.on = c.on;
  t.solo = c.solo || 0;
  rampGain(t);
  applyTrim(t, c.ha, c.trim);
  applyHp(t, c.hp);
  aplicarEnvios(t, c.sends, c.sendsOn);
  if (c.eq) applyEqAll(t, c.eq);
  if (c.gate) applyGate(t, c.gate);
  if (c.dyn) applyDyn(t, c.dyn);
  paintStrip(i);
}

// Fader e mute do LR sao guardados juntos: antes o mute lia o fader como 0.75
// fixo, entao desmutar jogava o volume geral para 0 dB em vez de devolver o
// valor que estava no fader.
const main = { fader: 0.75, on: 1 };

function refreshMaster() {
  master.gain.setTargetAtTime(main.on ? faderToGain(main.fader) : 0, ctx.currentTime, 0.02);
}

// ---------------------------------------------------------------------------
// Curvas e conversoes do X32
// ---------------------------------------------------------------------------
// Curva do X32 em quatro trechos que se encontram sem degrau. Tem que bater com
// a copia em mixer-state.js: 1.0 = +10 dB, 0.75 = 0 dB, 0.5 = -10 dB,
// 0.25 = -30 dB, 0.0625 = -60 dB, 0 = -oo.
function faderToDb(f) {
  if (f <= 0) return -Infinity;
  if (f < 0.0625) return f * 480 - 90;
  if (f < 0.25) return f * 160 - 70;
  if (f < 0.5) return f * 80 - 50;
  return f * 40 - 30;
}
function faderToGain(f) {
  const db = faderToDb(f);
  return isFinite(db) ? Math.pow(10, db / 20) : 0;
}
// Um canal se ouve quando esta ativo E (ninguem em solo OU ele em solo).
//
// Numa X32 de verdade o solo vai para o barramento de monitoracao, nao para o
// LR: soloar nao muda o som da casa. Aqui so existe uma saida estereo, entao
// fazemos "solo in place" — que e' tambem o que o aluno espera ao apertar solo,
// e a propria X32 oferece como opcao no menu de monitoracao.
//
// O mute continua mandando: soloar um canal mudo nao o traz de volta. E' a regra
// mais simples de explicar em aula — mute silencia, solo isola.
function soloAtivo() {
  return tracks.some((t) => t.solo);
}

function audivel(t) {
  if (!t.on) return false;
  return soloAtivo() ? !!t.solo : true;
}

function rampGain(t) {
  t.gain.gain.setTargetAtTime(audivel(t) ? faderToGain(t.fader) : 0, ctx.currentTime, 0.015);
}

// Mexer no solo de UM canal muda quem se ouve em todos: liga o solo do canal 3
// e os outros 31 calam. Por isso o recalculo e' geral, nao do canal tocado.
function aplicarSolos(lista) {
  tracks.forEach((t, i) => {
    t.solo = lista && lista[i] ? 1 : 0;
  });
  tracks.forEach((t, i) => {
    rampGain(t);
    paintStrip(i);
  });
}

const RATIOS = [1.1, 1.3, 1.5, 2, 2.5, 3, 4, 5, 7, 10, 20, 100];
const normFreq = (n) => 20 * Math.pow(1000, n);
const normQ = (n) => 10 * Math.pow(0.03, n);
const normEqGain = (n) => n * 30 - 15;
const normDynThr = (n) => n * 60 - 60;
const normGateThr = (n) => n * 80 - 80;
const normRange = (n) => 3 + n * 57;
const normMs = (n) => n * 0.12;
const normHold = (n) => n * 2;
const normRelease = (n) => (5 * Math.pow(800, n)) / 1000;
const normMakeup = (n) => Math.pow(10, (n * 24) / 20);

const EQ_TYPE_MAP = {
  0: 'highpass',
  1: 'lowshelf',
  2: 'peaking',
  3: 'peaking',
  4: 'highshelf',
  5: 'lowpass',
};

function applyEqAll(t, eq) {
  t.eqOn = eq.on;
  eq.bands.forEach((band, i) => {
    t.eqTypes[i] = band.type;
    const f = t.eq[i];
    if (!f) return;
    const now = ctx.currentTime;
    const active = t.eqOn === 1;
    const tipo = active ? EQ_TYPE_MAP[band.type] || 'peaking' : 'peaking';
    f.type = tipo;
    f.frequency.setTargetAtTime(normFreq(band.f), now, 0.02);

    // Num LCut/HCut o Q do biquad nao e' largura de banda: e' ressonancia. O
    // botao de Q da banda nao vale para cortes na X32, e usar o valor da banda
    // punha um pico de ate +10 dB bem em cima da frequencia de corte — o filtro
    // levantava o grave em vez de tirar.
    //
    // Cuidado com a unidade: so para highpass e lowpass a Web Audio le o Q em
    // DECIBEIS (alpha = sin(w0) / (2 * 10^(Q/20))). Butterworth e' Q linear
    // 0.7071, o que da 20*log10(0.7071) = -3.01 aqui. Pondo 0.7071 direto sai um
    // Q linear de 1.085 e volta uma corcunda de +1.7 dB logo acima do corte.
    const corte = tipo === 'highpass' || tipo === 'lowpass';
    f.Q.setTargetAtTime(corte ? -3.0103 : Math.max(0.0001, normQ(band.q)), now, 0.02);
    f.gain.setTargetAtTime(active ? normEqGain(band.g) : 0, now, 0.02);
  });
}

// Nivel de entrada do canal: ganho de preamp (-12 a +60 dB, 1/6 no zero) mais
// trim digital (-18 a +18 dB, 0.5 no zero). Sao dois parametros distintos na
// X32 e somam em dB. Ficam na frente de tudo, como na mesa real, entao mexer
// neles tambem muda o quanto o gate abre e o quanto o compressor trabalha.
function applyTrim(t, ha, trim) {
  const dbHa = ha === undefined || ha === null ? 0 : ha * 72 - 12;
  const dbTrim = trim === undefined || trim === null ? 0 : trim * 36 - 18;
  t.trim.gain.setTargetAtTime(Math.pow(10, (dbHa + dbTrim) / 20), ctx.currentTime, 0.02);
}

// Modos da secao de gate na X32, na ordem do OSC:
//   0 EXP2   1 EXP3   2 EXP4   3 GATE   4 DUCK
// O ratio do expansor e' 2, 3 ou 4; o GATE fecha ate o range. O DUCK precisa de
// uma fonte externa para abaixar o canal (locucao sobre musica) e nao e'
// emulado: com ele ligado, o canal passa limpo.
const GATE_RATIO = [2, 3, 4, 1, 0];

// Low Cut do preamp. Vem depois do ganho e ANTES do gate, como na X32 — e' o
// que faz o gate parar de disparar com pisada de palco e ronco de microfone.
//
// A X32 oferece 12, 18 e 24 dB/oitava. Com dois biquads da' para fazer 12 (uma
// secao Butterworth) e 24 (duas secoes, Q 0.5412 e 1.3066) exatos. O 18 e'
// ordem impar e nao sai de biquads: fica igual ao 24, mais ingreme que na mesa.
// Em dB, que e' como a Web Audio le o Q nos filtros de corte.
const HP_Q1 = [-3.0103, -5.3298, -5.3298];   // 12, 18, 24
const HP_Q2 = [null, 2.3227, 2.3227];
const HP_FREQ_MIN = 20;
const HP_FREQ_MAX = 400;

function applyHp(t, hp) {
  if (!t.hp1) return;
  const now = ctx.currentTime;
  const ligado = hp && hp.on === 1;
  const slope = Math.min(2, Math.max(0, (hp && hp.slope) | 0));
  // A faixa do Low Cut e' 20 a 400 Hz, nao os 20 Hz a 20 kHz do EQ.
  const hz = HP_FREQ_MIN * Math.pow(HP_FREQ_MAX / HP_FREQ_MIN, hp ? hp.f : 0);

  // Desligado, o par vira peaking com ganho 0: transparente, sem reconectar.
  t.hp1.type = ligado ? 'highpass' : 'peaking';
  t.hp2.type = ligado && HP_Q2[slope] !== null ? 'highpass' : 'peaking';
  t.hp1.gain.setTargetAtTime(0, now, 0.02);
  t.hp2.gain.setTargetAtTime(0, now, 0.02);
  t.hp1.frequency.setTargetAtTime(hz, now, 0.02);
  t.hp2.frequency.setTargetAtTime(hz, now, 0.02);
  t.hp1.Q.setTargetAtTime(ligado ? HP_Q1[slope] : 0, now, 0.02);
  t.hp2.Q.setTargetAtTime(ligado && HP_Q2[slope] !== null ? HP_Q2[slope] : 0, now, 0.02);
}

function applyGate(t, g) {
  if (!t.gate) return;   // sem AudioWorklet o canal passa limpo
  const p = t.gate.parameters;
  const now = ctx.currentTime;
  const ratio = GATE_RATIO[g.mode] !== undefined ? GATE_RATIO[g.mode] : 1;
  // ratio 0 = DUCK, que nao emulamos: passa limpo.
  p.get('bypass').setValueAtTime(g.on && ratio > 0 ? 0 : 1, now);
  p.get('ratio').setValueAtTime(Math.max(1, ratio), now);
  p.get('threshold').setTargetAtTime(normGateThr(g.thr), now, 0.02);
  p.get('range').setTargetAtTime(normRange(g.range), now, 0.02);
  p.get('attack').setTargetAtTime(Math.max(0.0002, normMs(g.attack)), now, 0.02);
  p.get('hold').setTargetAtTime(normHold(g.hold), now, 0.02);
  p.get('release').setTargetAtTime(Math.max(0.005, normRelease(g.release)), now, 0.02);
}

// O DynamicsCompressorNode do navegador aplica um makeup automatico proprio, que
// a X32 nao tem: com threshold baixo o canal ficava mais ALTO ao comprimir, o
// contrario de uma mesa de verdade. A formula desse ganho e' interna do Chrome,
// entao nao adivinhamos: medimos. Rodamos o mesmo compressor num contexto
// offline com um tom 30 dB abaixo do menor threshold possivel — nivel em que ele
// nao deveria mexer em nada — e o que sobrar de ganho e' o makeup automatico.
const makeupMedido = new Map();

async function ganhoAutomaticoDoComp(threshold, knee, ratio) {
  const chave = `${threshold.toFixed(2)}|${knee.toFixed(2)}|${ratio}`;
  if (makeupMedido.has(chave)) return makeupMedido.get(chave);

  const sr = 44100;
  const off = new OfflineAudioContext(1, Math.round(sr * 0.4), sr);
  const amp = Math.pow(10, -90 / 20);
  const osc = off.createOscillator();
  osc.frequency.value = 220;
  const nivel = off.createGain();
  nivel.gain.value = amp;
  const comp = off.createDynamicsCompressor();
  comp.threshold.value = threshold;
  comp.knee.value = knee;
  comp.ratio.value = ratio;
  comp.attack.value = 0.003;
  comp.release.value = 0.25;
  osc.connect(nivel).connect(comp).connect(off.destination);
  osc.start();

  const buf = await off.startRendering();
  const dados = buf.getChannelData(0);
  let soma = 0;
  let n = 0;
  for (let i = Math.floor(dados.length / 2); i < dados.length; i++) {
    soma += dados[i] * dados[i];
    n++;
  }
  const medido = Math.sqrt(soma / n) / (amp / Math.SQRT2);
  const ganho = isFinite(medido) && medido > 0.01 ? medido : 1;
  makeupMedido.set(chave, ganho);
  return ganho;
}

// Posicao da dinamica em relacao ao EQ. Na X32 e' escolha do operador
// (/ch/NN/dyn/pos: PRE ou POST) e muda o som: comprimir antes do EQ significa
// que o compressor nao "ouve" o que o EQ fez; depois, ele reage ao grave que
// voce acabou de levantar.
//
// A mesa declarava PRE e o audio sempre fazia POST.
function religarDinamica(t, pos) {
  const post = pos === 1;
  if (t.dynPost === post) return;
  t.dynPost = post;

  const entrada = t.gate || t.hp2;   // quem alimenta o bloco de processamento
  for (const no of [entrada, t.eq[3], t.makeup]) {
    try { no.disconnect(); } catch (e) { /* ainda nao ligado */ }
  }

  // O medidor e' pre-fader: sai de quem fecha o processamento, que muda junto.
  try { t.analyser.disconnect(); } catch (e) { /* nada ligado nele */ }

  if (post) {
    entrada.connect(t.eq[0]);
    t.eq[3].connect(t.comp);
    t.makeup.connect(t.gain);
    t.makeup.connect(t.analyser);
  } else {
    entrada.connect(t.comp);
    t.makeup.connect(t.eq[0]);
    t.eq[3].connect(t.gain);
    t.eq[3].connect(t.analyser);
  }
}

function applyDyn(t, d) {
  religarDinamica(t, d.pos);
  const now = ctx.currentTime;
  const on = d.on === 1 && d.mode === 0;
  const thr = on ? normDynThr(d.thr) : 0;
  const ratio = on ? Math.min(20, RATIOS[d.ratio] || 3) : 1;
  const knee = on ? d.knee * 12 : 0;

  t.comp.threshold.setTargetAtTime(thr, now, 0.02);
  t.comp.ratio.setTargetAtTime(ratio, now, 0.02);
  t.comp.knee.setTargetAtTime(knee, now, 0.02);
  t.comp.attack.setTargetAtTime(Math.max(0.0005, normMs(d.attack)), now, 0.02);
  t.comp.release.setTargetAtTime(Math.min(1, Math.max(0.01, normRelease(d.release))), now, 0.02);

  // Marca a versao deste ajuste: a medicao e' assincrona e um giro rapido do
  // botao pode gerar varias, que voltariam fora de ordem.
  const marca = ++t.dynSeq;

  if (!on) {
    t.makeup.gain.setTargetAtTime(1, now, 0.02);
    return;
  }

  const desejado = normMakeup(d.mgain);
  ganhoAutomaticoDoComp(thr, knee, ratio).then((automatico) => {
    if (t.dynSeq !== marca) return;
    t.makeup.gain.setTargetAtTime(desejado / automatico, ctx.currentTime, 0.02);
  });
}

// ---------------------------------------------------------------------------
// Carregar stems por streaming
//
// Nada de decodeAudioData: 17 stems de 12 minutos dariam varios GB de RAM.
// Cada faixa vira um <audio> que o navegador vai lendo aos poucos.
// ---------------------------------------------------------------------------
// Desmonta tudo para trocar de musica sem recarregar a pagina. Importante
// desligar os nos e revogar as URLs: sao dezenas de MB por faixa, e o
// MediaElementSource segura o elemento de audio enquanto estiver conectado.
function limparFaixas() {
  for (const t of tracks) {
    if (t.pcm) window.Pcm.calar(t.pcm);
    if (t.audio) { try { t.audio.pause(); } catch (e) { /* elemento ja descartado */ } }
    for (const no of [t.src, t.trim, t.hp1, t.hp2, t.gate, ...t.eq, t.comp, t.makeup, t.gain, t.pan, ...(t.envio || []), t.analyser]) {
      if (no) { try { no.disconnect(); } catch (e) { /* ja desconectado */ } }
    }
    if (t.audio) {
      t.audio.removeAttribute('src');
      t.audio.load();
    }
    if (t.revogar) URL.revokeObjectURL(t.url);
  }

  tracks = [];
  relogio.base = 0;
  relogio.tocando = false;
  duration = 0;

  el('strips').innerHTML = '';
  el('deck').querySelectorAll('.aviso').forEach((n) => n.remove());
  el('deck').classList.add('hidden');
  el('loader').classList.remove('hidden');
  setLoaderText('Escolha a pasta com os stems da música. Cada arquivo vira um canal, na ordem alfabética.');
  el('playbtn').textContent = 'Tocar';
  el('time').textContent = '0:00 / 0:00';
  el('fill').style.width = '0%';

  // Sem zerar o valor, escolher a MESMA pasta de novo nao dispara o change.
  el('picker').value = '';
  sendTape(0);
}

el('trocar').addEventListener('click', () => {
  pause();
  limparFaixas();
  jaAutocarregou = true;   // trocar e' um pedido explicito: nao recarregue sozinho
});

const EXT_AUDIO = /\.(wav|aiff?|mp3|m4a|flac|ogg|opus)$/i;

// A mesa lembra a ultima pasta usada e avisa ao conectar. Carregamos sozinho
// so na primeira vez que a pagina abre — depois disso o usuario esta no meio de
// alguma coisa, e recarregar por baixo dele seria pior que nao lembrar.
let pastaLembrada = null;
let jaAutocarregou = false;

function receberPasta(msg) {
  pastaLembrada = msg.pasta ? msg : null;

  // O seletor nativo so existe embrulhado no Electron; no navegador comum fica
  // o seletor de arquivos de sempre.
  el('btpasta').classList.toggle('hidden', !msg.nativo);
  el('filebtn').classList.toggle('hidden', !!msg.nativo);

  const aviso = el('pastaatual');
  if (msg.pasta) {
    aviso.textContent = `Última pasta: ${msg.nome} (${msg.arquivos.length} faixas)`;
    aviso.classList.remove('hidden');
  } else {
    aviso.classList.add('hidden');
  }

  if (!msg.pasta || !msg.arquivos.length) return;

  // Pedido explicito: o usuario acabou de escolher a pasta no dialogo. Carrega
  // sempre, trocando o que estiver tocando.
  //
  // O 'jaAutocarregou' existe para nao recarregar por baixo de quem esta no meio
  // de uma aula — mas ele estava barrando tambem a escolha do usuario, e a pasta
  // nova so entrava na segunda tentativa, por outro caminho.
  if (msg.escolhida) {
    jaAutocarregou = true;
    if (tracks.length) {
      pause();
      limparFaixas();
    }
    carregarPastaLembrada();
    return;
  }

  // Aviso de abertura: carrega uma vez so, e so se nao houver nada carregado.
  if (!jaAutocarregou && tracks.length === 0) {
    jaAutocarregou = true;
    carregarPastaLembrada();
  }
}

// Reparte os stems entre as portas que a mesa abriu.
//
// O navegador abre no maximo 6 conexoes por origem, e origem inclui a PORTA.
// Um <audio> tocando segura a conexao dele o tempo todo, entao com 18 stems
// numa porta so, 12 ficavam sem conexao: relogio andando, buffer parado em 3 s
// e o canal saindo mudo. Espalhados por 7 portas, cada uma fica com 5.
//
// Se a mesa nao conseguiu abrir porta nenhuma, cai no caminho antigo — mesma
// porta para todo mundo, que e' o que sempre funcionou com poucas faixas.
function origemDoStem(i, portas, porOrigem) {
  if (!portas || portas.length < 2) return '';
  const porta = portas[Math.min(Math.floor(i / porOrigem), portas.length - 1)];
  if (String(porta) === location.port) return '';
  return `${location.protocol}//${location.hostname}:${porta}`;
}

function carregarPastaLembrada() {
  if (!pastaLembrada || !pastaLembrada.arquivos.length) return;
  const portas = pastaLembrada.portas;
  const porOrigem = pastaLembrada.porOrigem || 5;
  carregar(
    pastaLembrada.arquivos.map((nome, i) => {
      const base = origemDoStem(i, portas, porOrigem);
      return {
        nome,
        base,
        // O arquivo inteiro, para quem precisar dele de uma vez: as faixas
        // comprimidas, que continuam no <audio>, e a exportacao acelerada.
        url: `${base}/stems/${encodeURIComponent(nome)}`,
        revogar: false,
      };
    })
  );
}

// ---------------------------------------------------------------------------
// Exportar a mixagem
//
// E' captura em TEMPO REAL, nao renderizacao acelerada. Para renderizar rapido
// seria preciso ter os stems inteiros decodificados na memoria ao mesmo tempo —
// cerca de 4 GB numa musica de 12 minutos — e um OfflineAudioContext nem aceita
// MediaElementSource. Entao a musica toca uma vez, do inicio ao fim, e o que sai
// no master e' gravado.
// ---------------------------------------------------------------------------
const FORMATOS = [
  { mime: 'audio/mp4;codecs=mp4a.40.2', ext: 'm4a' },   // abre em qualquer lugar
  { mime: 'audio/webm;codecs=opus', ext: 'webm' },
  { mime: 'audio/webm', ext: 'webm' },
];

let gravador = null;
let exportando = false;

// --- exportacao acelerada ---------------------------------------------------
//
// O gargalo nunca foi o processamento: era o codificador, que grava em tempo
// real. Aqui renderizamos cada canal offline (cerca de 200x mais rapido) e
// codificamos com WebCodecs.
//
// Canal por canal, e nao todos juntos, por causa de memoria: 17 stems de 12 min
// decodificados ao mesmo tempo dao uns 4,3 GB. Um de cada vez, somando num
// acumulador, o pico fica em torno de 750 MB.
//
// Somar depois da' o mesmo resultado que somar durante: as cadeias de canal sao
// independentes ate o barramento, e o fader do LR e' so um ganho no fim.

function copiarBiquad(origem, destino) {
  destino.type = origem.type;
  destino.frequency.value = origem.frequency.value;
  destino.Q.value = origem.Q.value;
  destino.gain.value = origem.gain.value;
}

async function renderizarCanal(off, t, amostras) {
  const buf = await off.decodeAudioData(await (await fetch(t.url)).arrayBuffer());

  const src = off.createBufferSource();
  src.buffer = buf;

  const trim = off.createGain();
  trim.gain.value = t.trim.gain.value;

  const hp1 = off.createBiquadFilter();
  const hp2 = off.createBiquadFilter();
  copiarBiquad(t.hp1, hp1);
  copiarBiquad(t.hp2, hp2);

  let gate = null;
  if (t.gate && workletReady) {
    gate = new AudioWorkletNode(off, 'gate-processor', { channelCount: 2, channelCountMode: 'explicit' });
    for (const nome of ['bypass', 'threshold', 'range', 'attack', 'hold', 'release', 'ratio']) {
      gate.parameters.get(nome).value = t.gate.parameters.get(nome).value;
    }
  }

  const eq = t.eq.map((f) => {
    const n = off.createBiquadFilter();
    copiarBiquad(f, n);
    return n;
  });

  const comp = off.createDynamicsCompressor();
  for (const nome of ['threshold', 'knee', 'ratio', 'attack', 'release']) {
    comp[nome].value = t.comp[nome].value;
  }

  const makeup = off.createGain();
  makeup.gain.value = t.makeup.gain.value;
  const fader = off.createGain();
  fader.gain.value = t.gain.gain.value;      // ja inclui mute e solo
  const pan = off.createStereoPanner();
  pan.pan.value = t.pan.pan.value;

  // Os efeitos entram aqui tambem, senao a mixagem exportada sai seca.
  //
  // Cada canal leva a sua propria copia do delay e do reverb, em vez de um par
  // compartilhado. Da' no mesmo: delay e convolucao sao lineares, entao somar
  // depois de processar e' igual a processar a soma. E e' o que permite
  // renderizar um canal de cada vez, que e' o que segura a memoria.
  const efeitos = construirEfeitos(off, off.destination);
  efeitos.linha.delayTime.value = fx.linha.delayTime.value;
  efeitos.realimenta.gain.value = fx.realimenta.gain.value;
  efeitos.convolucao.buffer = fx.convolucao.buffer;
  efeitos.faderDelay.gain.value = fx.faderDelay.gain.value;
  efeitos.faderReverb.gain.value = fx.faderReverb.gain.value;

  const envio = [off.createGain(), off.createGain()];
  envio[0].gain.value = t.envio[0].gain.value;
  envio[1].gain.value = t.envio[1].gain.value;
  fader.connect(envio[0]).connect(efeitos.entradaDelay);
  fader.connect(envio[1]).connect(efeitos.entradaReverb);

  src.connect(trim).connect(hp1).connect(hp2);
  const entrada = gate ? (hp2.connect(gate), gate) : hp2;

  // Respeita o PRE/POST do compressor, como na cadeia ao vivo.
  if (t.dynPost) {
    entrada.connect(eq[0]);
    eq[0].connect(eq[1]).connect(eq[2]).connect(eq[3]).connect(comp);
    comp.connect(makeup).connect(fader);
  } else {
    entrada.connect(comp);
    comp.connect(makeup).connect(eq[0]);
    eq[0].connect(eq[1]).connect(eq[2]).connect(eq[3]).connect(fader);
  }
  fader.connect(pan).connect(off.destination);

  src.start();
  const saida = await off.startRendering();
  return saida;
}

async function exportarRapido() {
  const taxa = ctx.sampleRate;
  const amostras = Math.ceil(duration * taxa);
  const soma = [new Float32Array(amostras), new Float32Array(amostras)];

  // Canal calado por mute ou por solo alheio nao precisa ser renderizado.
  const audiveis = tracks.filter((t) => t.gain.gain.value > 0.00002);
  let feitos = 0;

  for (const t of audiveis) {
    if (!exportando) return null;                 // cancelado
    el('expestado').textContent = `Processando ${t.name} — ${feitos + 1} de ${audiveis.length}`;
    el('expbarra').style.width = `${(feitos / audiveis.length) * 90}%`;

    const off = new OfflineAudioContext(2, amostras, taxa);
    if (workletReady) await off.audioWorklet.addModule('gate-processor.js');
    const saida = await renderizarCanal(off, t, amostras);

    for (let c = 0; c < 2; c++) {
      const dados = saida.getChannelData(Math.min(c, saida.numberOfChannels - 1));
      const alvo = soma[c];
      for (let i = 0; i < dados.length; i++) alvo[i] += dados[i];
    }
    feitos++;
    await new Promise((r) => setTimeout(r, 0));   // deixa a tela respirar
  }

  // O fader do LR e' um ganho: aplicar no fim da' o mesmo que aplicar durante.
  const lr = master.gain.value;
  if (lr !== 1) {
    for (const canal of soma) for (let i = 0; i < canal.length; i++) canal[i] *= lr;
  }

  el('expestado').textContent = 'Codificando…';
  el('expbarra').style.width = '95%';
  return codificarAac(soma, taxa);
}

// Codifica em AAC e monta um .m4a. Nao ADTS: quadros ADTS tocam, mas o formato
// nao guarda duracao, e o player estima pela taxa de bits — uma musica de 90 s
// aparecia como 224 s, com a barra de tempo errada.
async function codificarAac(soma, taxa) {
  const quadros = [];
  let configAudio = null;
  const TAXA_BITS = 192000;

  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      // O AudioSpecificConfig vem junto do primeiro quadro e e' o que descreve
      // o fluxo dentro do recipiente.
      if (!configAudio && meta && meta.decoderConfig && meta.decoderConfig.description) {
        configAudio = new Uint8Array(meta.decoderConfig.description);
      }
      const b = new Uint8Array(chunk.byteLength);
      chunk.copyTo(b);
      quadros.push(b);
    },
    error: (e) => console.error('codificador:', e),
  });
  encoder.configure({
    codec: 'mp4a.40.2',
    sampleRate: taxa,
    numberOfChannels: 2,
    bitrate: TAXA_BITS,
    aac: { format: 'aac' },
  });

  const BLOCO = 1024 * 16;
  const intercalado = new Float32Array(BLOCO * 2);
  for (let inicio = 0; inicio < soma[0].length; inicio += BLOCO) {
    const n = Math.min(BLOCO, soma[0].length - inicio);
    for (let i = 0; i < n; i++) {
      intercalado[i * 2] = soma[0][inicio + i];
      intercalado[i * 2 + 1] = soma[1][inicio + i];
    }
    encoder.encode(new AudioData({
      format: 'f32',
      sampleRate: taxa,
      numberOfFrames: n,
      numberOfChannels: 2,
      timestamp: Math.round((inicio / taxa) * 1e6),
      data: intercalado.slice(0, n * 2),
    }));
  }
  await encoder.flush();
  encoder.close();

  if (!configAudio) throw new Error('o codificador nao devolveu a descricao do fluxo');
  return montarM4a(quadros, configAudio, taxa, 2, TAXA_BITS);
}

function formatoDisponivel() {
  return FORMATOS.find((f) => MediaRecorder.isTypeSupported(f.mime)) || null;
}

function nomeDaMix() {
  const base = pastaLembrada && pastaLembrada.nome ? pastaLembrada.nome : 'mixagem';
  const d = new Date();
  const carimbo = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${base} — mix ${carimbo}`.replace(/[\\/:*?"<>|]/g, '-');
}

async function exportarMix() {
  if (!tracks.length || gravador || exportando) return;

  // Caminho rapido, quando o navegador sabe codificar sozinho.
  if (typeof AudioEncoder !== 'undefined') {
    exportando = true;
    el('exportar').classList.add('hidden');
    el('expcaixa').classList.remove('hidden');
    el('expestado').textContent = 'Preparando…';
    try {
      const t0 = performance.now();
      const blob = await exportarRapido();
      if (blob) {
        baixar(blob, `${nomeDaMix()}.m4a`);
        console.log(`exportado em ${Math.round((performance.now() - t0) / 1000)} s`);
      }
    } catch (err) {
      console.error('Exportacao rapida falhou, gravando em tempo real:', err);
      exportando = false;
      el('expcaixa').classList.add('hidden');
      el('exportar').classList.remove('hidden');
      return exportarTempoReal();
    }
    exportando = false;
    el('expcaixa').classList.add('hidden');
    el('exportar').classList.remove('hidden');
    el('expbarra').style.width = '0%';
    return;
  }

  return exportarTempoReal();
}

// Reserva: grava a saida enquanto a musica toca. So entra em cena se o
// navegador nao tiver codificador proprio, ou se o caminho rapido falhar.
async function exportarTempoReal() {
  if (!tracks.length || gravador) return;

  const formato = formatoDisponivel();
  if (!formato) {
    el('expestado').textContent = 'Este navegador não sabe gravar áudio.';
    return;
  }

  const pedacos = [];
  gravador = new MediaRecorder(gravacao.stream, {
    mimeType: formato.mime,
    audioBitsPerSecond: 256000,
  });
  gravador.ondataavailable = (e) => { if (e.data.size) pedacos.push(e.data); };

  const terminou = new Promise((r) => { gravador.onstop = r; });

  el('exportar').classList.add('hidden');
  el('expcaixa').classList.remove('hidden');
  el('expestado').textContent = 'Preparando…';

  seek(0);
  await play();
  gravador.start(1000);

  // Acompanha ate o fim da musica. Nao da para confiar so no evento 'ended':
  // sao 17 elementos e o primeiro a acabar nao e' necessariamente o relogio.
  await new Promise((resolve) => {
    const vigia = setInterval(() => {
      if (!gravador) { clearInterval(vigia); resolve(); return; }
      const pos = posicao();
      const falta = Math.max(0, duration - pos);
      el('expbarra').style.width = `${Math.min(100, (pos / duration) * 100)}%`;
      el('expestado').textContent =
        `Gravando em tempo real — ${fmt(pos)} de ${fmt(duration)}, faltam ${fmt(falta)}`;
      if (pos >= duration - 0.15 || !playing()) { clearInterval(vigia); resolve(); }
    }, 250);
  });

  if (!gravador) return;            // cancelado no meio
  gravador.stop();
  await terminou;
  gravador = null;
  pause();

  el('expestado').textContent = 'Salvando…';
  const blob = new Blob(pedacos, { type: formato.mime });
  baixar(blob, `${nomeDaMix()}.${formato.ext}`);

  el('expcaixa').classList.add('hidden');
  el('exportar').classList.remove('hidden');
  el('expbarra').style.width = '0%';
}

function baixar(blob, nome) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

el('exportar').addEventListener('click', exportarMix);

el('expcancelar').addEventListener('click', () => {
  exportando = false;                 // interrompe o caminho rapido
  if (!gravador) {
    el('expcaixa').classList.add('hidden');
    el('exportar').classList.remove('hidden');
    el('expbarra').style.width = '0%';
    return;
  }
  const g = gravador;
  gravador = null;                  // sinaliza o cancelamento para a vigia
  try { g.stop(); } catch (e) { /* ja parado */ }
  pause();
  el('expcaixa').classList.add('hidden');
  el('exportar').classList.remove('hidden');
  el('expbarra').style.width = '0%';
});

el('btpasta').addEventListener('click', () => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'escolherPasta' }));
});

// Pasta escolhida a mao pelo seletor de arquivos do navegador.
el('picker').addEventListener('change', (ev) => {
  const files = [...ev.target.files]
    .filter((f) => EXT_AUDIO.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 32);

  if (files.length === 0) {
    setLoaderText('Nenhum arquivo de áudio nessa pasta. Use WAV, AIFF, MP3, M4A, FLAC ou OGG.');
    return;
  }

  carregar(files.map((f) => ({ nome: f.name, url: URL.createObjectURL(f), revogar: true })));
});

// Carrega uma lista de faixas. Cada item tem um nome e uma URL — que pode ser
// de um arquivo escolhido a mao (blob) ou da pasta lembrada, servida pela mesa.
// Nos dois casos o <audio> le aos poucos; nada e' carregado inteiro na memoria.
async function carregar(itens) {
  const files = itens;
  setLoaderText(`Preparando ${files.length} faixas…`);

  // O AudioWorklet so existe em contexto seguro: https ou localhost. Aberta pelo
  // IP da rede (http://192.168.x.x), a pagina nao tem ctx.audioWorklet e antes
  // isso derrubava o carregamento inteiro, deixando o aviso "Preparando..." na
  // tela para sempre. Agora seguimos sem gate; o resto da mesa funciona igual.
  if (!workletReady && ctx.audioWorklet) {
    try {
      await ctx.audioWorklet.addModule('gate-processor.js');
      workletReady = true;
    } catch (err) {
      console.error('Gate indisponivel:', err);
    }
  }

  tracks = [];
  duration = 0;
  const falhas = [];

  // ABRE TODOS OS ARQUIVOS DE UMA VEZ.
  //
  // Antes era um de cada vez, cada um esperando o anterior terminar. Com 17
  // stems isso somava a espera de 17 aberturas em fila — e como a tela so
  // avancava quando um arquivo dava certo, uma sequencia de falhas parecia
  // travamento. Abrindo em paralelo, o tempo total vira o do arquivo mais lento.
  //
  // A ordem dos canais nao depende da ordem de chegada: o Promise.all devolve
  // na ordem em que foi pedido, que e' a alfabetica.
  let prontos = 0;
  const abertos = await Promise.all(
    files.map(async (file) => {
      // Caminho preferido: a mesa corta o arquivo em blocos e o player so
      // guarda os proximos segundos. E' o que faz 18 stems de 24 bits caberem.
      if (file.base !== undefined) {
        const pcm = await window.Pcm.abrirPcm(file.base, file.nome);
        if (pcm) {
          prontos++;
          setLoaderText(`Abrindo ${prontos} de ${files.length}…`);
          return { file, pcm, url: file.url };
        }
      }

      // Comprimido (MP3, M4A, FLAC, OGG) ou pasta escolhida a mao: <audio>.
      // Sao poucos MB por faixa, longe do orcamento de memoria de midia.
      const audio = new Audio();
      const url = file.url;
      // Stem vindo de porta vizinha e' cross-origin: sem isso a Web Audio trata
      // o audio como "sujo" e o canal sai mudo, sem erro nenhum na tela.
      if (/^https?:/.test(url) && !url.startsWith(location.origin)) {
        audio.crossOrigin = 'anonymous';
      }
      audio.src = url;
      audio.preload = 'auto';

      try {
        await new Promise((resolve, reject) => {
          audio.addEventListener('loadedmetadata', resolve, { once: true });
          audio.addEventListener('error', () => reject(audio.error), { once: true });
          setTimeout(() => reject(new Error('tempo esgotado')), 15000);
        });
      } catch (err) {
        if (file.revogar) URL.revokeObjectURL(url);
        console.error('Não abriu', file.nome, err);
        return { file, erro: true };
      }

      prontos++;
      setLoaderText(`Abrindo ${prontos} de ${files.length}…`);
      return { file, audio, url };
    })
  );

  setLoaderText(`Montando os canais…`);

  for (const aberto of abertos) {
    const { file, audio, pcm, url } = aberto;
    if (aberto.erro) {
      falhas.push(file.nome);
      continue;
    }

    // Nos dois casos a cadeia e' a mesma daqui para frente. Com blocos, `src`
    // e' so o ponto onde cada pedaco entra.
    const src = audio ? ctx.createMediaElementSource(audio) : ctx.createGain();
    const gate = workletReady
      ? new AudioWorkletNode(ctx, 'gate-processor', {
          channelCount: 2,
          channelCountMode: 'explicit',
        })
      : null;
    const eq = [0, 1, 2, 3].map(() => {
      const f = ctx.createBiquadFilter();
      f.type = 'peaking';
      f.gain.value = 0;
      return f;
    });
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = 0;
    comp.ratio.value = 1;
    comp.knee.value = 0;

    const trim = ctx.createGain();   // ganho de entrada, antes do gate
    const hp1 = ctx.createBiquadFilter();
    const hp2 = ctx.createBiquadFilter();
    for (const f of [hp1, hp2]) { f.type = 'peaking'; f.gain.value = 0; }
    const makeup = ctx.createGain();
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner();
    // Um envio por efeito. Saem DEPOIS do fader, que e' o normal para efeito.
    const envio = [ctx.createGain(), ctx.createGain()];
    for (const e of envio) e.gain.value = 0;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;

    src.connect(trim).connect(hp1).connect(hp2);
    if (gate) hp2.connect(gate).connect(eq[0]);
    else hp2.connect(eq[0]);
    eq[0].connect(eq[1]).connect(eq[2]).connect(eq[3]);
    comp.connect(makeup);
    gain.connect(pan).connect(master);
    gain.connect(envio[0]).connect(fx.entradaDelay);
    gain.connect(envio[1]).connect(fx.entradaReverb);
    // A ligacao entre gate, EQ e compressor depende do PRE/POST e e' feita por
    // religarDinamica, chamada logo abaixo com o estado da mesa.

    // Medidor PRE-FADER, como na X32: sai depois do ganho, gate, EQ e comp, mas
    // antes do fader e do mute. E' o que deixa ajustar ganho pelo medidor com o
    // fader onde estiver. Saindo de `gain` (o fader), o medidor seguia o fader e
    // dava a impressao de que o fader era o botao de ganho.
    // Quem alimenta o medidor muda com o PRE/POST, entao quem liga e'
    // religarDinamica.
    gain.gain.value = faderToGain(0.75);

    const faixa = {
      name: file.nome.replace(/\.[^.]+$/, '').slice(0, 12),
      audio: audio || null,
      pcm: pcm || null,
      url,
      revogar: file.revogar,
      src,
      trim,
      hp1,
      hp2,
      gate,
      eq,
      comp,
      makeup,
      gain,
      pan,
      envio,
      analyser,
      data: new Float32Array(analyser.fftSize),
      on: 1,
      solo: 0,
      dynPost: null,   // ainda nao ligado: religarDinamica monta a cadeia
      fader: 0.75,
      dynSeq: 0,
      eqTypes: [1, 2, 2, 4],
      eqOn: 1,
    };
    tracks.push(faixa);
    // Monta a cadeia. PRE e' o padrao que a mesa declara; o snapshot que chega
    // logo depois religa se a mesa estiver em POST.
    religarDinamica(faixa, 0);

    duration = Math.max(duration, (pcm ? pcm.duracao : audio.duration) || 0);
    setLoaderText(`Montando canal ${tracks.length} de ${files.length}…`);
  }

  if (tracks.length === 0) {
    setLoaderText(`Nenhuma faixa pôde ser aberta: ${falhas.join(', ')}.`);
    return;
  }

  relogio.base = 0;
  relogio.tocando = false;
  buildStrips();
  el('loader').classList.add('hidden');
  el('deck').classList.remove('hidden');

  if (falhas.length) {
    const aviso = document.createElement('p');
    aviso.className = 'hint aviso';
    aviso.textContent = `Não abriram: ${falhas.join(', ')}.`;
    el('deck').prepend(aviso);
  }

  if (!workletReady) {
    const aviso = document.createElement('p');
    aviso.className = 'hint aviso';
    aviso.textContent =
      'Gate desligado: esta página foi aberta por um endereço sem contexto seguro. ' +
      'Abra em http://localhost:8080 no próprio Mac para ter o gate.';
    el('deck').prepend(aviso);
  }

  if (ws && ws.readyState === 1) {
    // Preenche ate 32 com vazio: trocando uma musica de 17 faixas por uma de 8,
    // os canais 9 a 17 ficariam com o nome da musica anterior no Mixing Station.
    const nomes = tracks.map((t) => t.name);
    while (nomes.length < 32) nomes.push('');
    ws.send(JSON.stringify({ type: 'names', names: nomes }));
    // O snapshot da mesa chega ao conectar, quando ainda nao existe faixa
    // nenhuma para receber os valores. Sem pedir de novo aqui, uma mesa que ja
    // estava ajustada (ganho, EQ, gate, comp) nao chegava ao audio: a tela do
    // Mixing Station mostrava uma coisa e se ouvia outra.
    ws.send(JSON.stringify({ type: 'pedirSnapshot' }));
  }

  paintTime();
}

function setLoaderText(txt) {
  el('loader').querySelector('p').textContent = txt;
}

// ---------------------------------------------------------------------------
// Transporte
// ---------------------------------------------------------------------------
function playing() {
  return relogio.tocando;
}

async function play() {
  if (!tracks.length) return;
  await ctx.resume();

  // Tocar com a musica ja andando e' pedido de realinhamento, nao de voltar ao
  // ponto onde este trecho comecou: guarda onde esta e joga fora o que estava
  // agendado, senao o novo agendamento convive com o antigo.
  if (relogio.tocando) {
    relogio.base = posicao();
    for (const t of tracks) if (t.pcm) window.Pcm.calar(t.pcm);
  }
  // O relogio fica parado enquanto o primeiro bloco nao chega, para que o laco
  // de 50 ms nao agende nada contra uma largada que ainda vai mudar.
  relogio.tocando = false;

  // No fim da musica, tocar recomeca do zero.
  if (relogio.base >= duration - 0.05) relogio.base = 0;
  const pos = relogio.base;

  // Busca o primeiro bloco de cada faixa ANTES de marcar a largada. Sem isso a
  // primeira faixa a ficar pronta comeca antes das outras e o arranque sai
  // desalinhado — justamente o que o relogio do AudioContext evita depois.
  await Promise.allSettled(
    tracks.filter((t) => t.pcm).map((t) => window.Pcm.primeiroBloco(ctx, t.pcm, pos))
  );

  for (const t of tracks) {
    if (t.audio) { try { t.audio.currentTime = pos; } catch (e) { /* ainda sem metadados */ } }
  }

  relogio.t0 = ctx.currentTime + 0.05;
  relogio.tocando = true;
  bombear();

  // allSettled, nao all: a promessa de play() de uma faixa que nao conseguiu
  // dado nenhum pode nunca resolver, e com Promise.all isso pendurava o botao
  // inteiro — as outras 17 tocando e a tela ainda escrito "Tocar".
  await Promise.allSettled(tracks.filter((t) => t.audio).map((t) => t.audio.play()));
  el('playbtn').textContent = 'Pausar';
  sendTape(2);
}

function pause() {
  relogio.base = posicao();
  relogio.tocando = false;
  for (const t of tracks) {
    if (t.audio) t.audio.pause();
    if (t.pcm) window.Pcm.calar(t.pcm);
  }
  el('playbtn').textContent = 'Tocar';
  sendTape(1);
}

function seek(pos) {
  const alvo = Math.max(0, Math.min(pos, duration));
  relogio.base = alvo;
  relogio.t0 = ctx.currentTime;
  for (const t of tracks) {
    if (t.pcm) window.Pcm.calar(t.pcm);          // o que estava agendado nao vale mais
    if (t.audio) { try { t.audio.currentTime = alvo; } catch (e) { /* ainda sem metadados */ } }
  }
  if (relogio.tocando) bombear();
  paintTime();
}

// Mantem cada faixa com alguns segundos agendados a frente. Roda sozinho
// enquanto a musica toca.
function bombear() {
  if (!relogio.tocando) return;
  for (const t of tracks) {
    if (!t.pcm) continue;
    window.Pcm.alimentar(ctx, t.pcm, t.src, relogio.t0, relogio.base);
  }
}

function sendTape(v) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'tape', value: v }));
}

el('playbtn').addEventListener('click', () => (playing() ? pause() : play()));
el('stopbtn').addEventListener('click', () => {
  pause();
  seek(0);
  sendTape(0);
});
el('back10').addEventListener('click', () => seek(posicao() - 10));
el('fwd10').addEventListener('click', () => seek(posicao() + 10));

// Barra de posicao: clicar ou arrastar em qualquer ponto da musica
const bar = el('bar');
function posFromEvent(e) {
  const rect = bar.getBoundingClientRect();
  const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
  return (Math.max(0, Math.min(x, rect.width)) / rect.width) * duration;
}
bar.addEventListener('pointerdown', (e) => {
  scrubbing = true;
  bar.setPointerCapture(e.pointerId);
  seek(posFromEvent(e));
});
bar.addEventListener('pointermove', (e) => {
  if (scrubbing) seek(posFromEvent(e));
});
bar.addEventListener('pointerup', () => {
  scrubbing = false;
});

// Atalhos de teclado: espaço toca/pausa, setas pulam
document.addEventListener('keydown', (e) => {
  if (tracks.length === 0) return;
  if (e.code === 'Space') {
    e.preventDefault();
    playing() ? pause() : play();
  }
  if (e.code === 'ArrowLeft') seek(posicao() - 5);
  if (e.code === 'ArrowRight') seek(posicao() + 5);
});

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------
function buildStrips() {
  const host = el('strips');
  host.innerHTML = '';
  tracks.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'strip';
    row.innerHTML = `
      <div class="num">${String(i + 1).padStart(2, '0')}</div>
      <div>
        <div class="name">${t.name}</div>
        <div class="meter"><span data-meter="${i}"></span></div>
      </div>
      <div class="clipe" data-clipe="${i}" title="Clipe"></div>
      <div class="db" data-db="${i}"></div>
      <div class="state on" data-state="${i}">ativo</div>`;
    host.appendChild(row);
  });
  tracks.forEach((_, i) => paintStrip(i));
}

function paintStrip(i) {
  const t = tracks[i];
  const db = el('strips').querySelector(`[data-db="${i}"]`);
  const st = el('strips').querySelector(`[data-state="${i}"]`);
  if (!db || !t) return;
  const v = faderToDb(t.fader);
  db.textContent = isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB` : '−∞';
  // Tres situacoes diferentes, e vale distinguir na tela: o canal isolado, os
  // que o solo alheio calou, e o mute de verdade.
  if (!t.on) {
    st.textContent = 'mudo';
    st.className = 'state off';
  } else if (t.solo) {
    st.textContent = 'solo';
    st.className = 'state solo';
  } else if (soloAtivo()) {
    st.textContent = 'calado';
    st.className = 'state calado';
  } else {
    st.textContent = 'ativo';
    st.className = 'state on';
  }
}

function fmt(s) {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function paintTime() {
  if (!tracks.length) return;
  const pos = posicao();
  el('time').textContent = `${fmt(pos)} / ${fmt(duration)}`;
  if (duration) el('fill').style.width = `${(pos / duration) * 100}%`;
}

// ---------------------------------------------------------------------------
// Loop: medidores, relogio e correcao de deriva entre as faixas
// ---------------------------------------------------------------------------
setInterval(() => {
  if (tracks.length === 0) return;

  // Medidor de PICO, nao de RMS. Mesa e' medidor de pico: e' o pico que estoura
  // o conversor, e o valor que o X32 manda no blob e' a amostra mesma, de 0 a 1.
  // Antes ia um RMS multiplicado por 2.2, que e' aproximacao — e com ela o
  // medidor nunca chegava ao topo mesmo com o canal clipando.
  const agora = performance.now();
  const values = tracks.map((t) => {
    t.analyser.getFloatTimeDomainData(t.data);
    let pico = 0;
    for (let i = 0; i < t.data.length; i++) {
      const v = t.data[i] < 0 ? -t.data[i] : t.data[i];
      if (v > pico) pico = v;
    }
    // Segura o clipe aceso por um tempo, como a luz vermelha de uma mesa: um
    // estouro de milissegundos some antes de qualquer um ver.
    if (pico >= CLIPE_NIVEL) t.clipeAte = agora + CLIPE_SEGURA;
    return Math.min(1, pico);
  });

  values.forEach((v, i) => {
    const b = el('strips').querySelector(`[data-meter="${i}"]`);
    if (b) b.style.width = `${Math.round(v * 100)}%`;
    const luz = el('strips').querySelector(`[data-clipe="${i}"]`);
    if (luz) luz.classList.toggle('aceso', tracks[i].clipeAte > agora);
  });

  // Clipe na saida principal: e' a soma de todos os canais que estoura primeiro.
  if (sondaMaster) {
    sondaMaster.getFloatTimeDomainData(dadosMaster);
    let picoLR = 0;
    for (let i = 0; i < dadosMaster.length; i++) {
      const v = dadosMaster[i] < 0 ? -dadosMaster[i] : dadosMaster[i];
      if (v > picoLR) picoLR = v;
    }
    if (picoLR >= CLIPE_NIVEL) clipeMasterAte = agora + CLIPE_SEGURA;
    el('clipelr').classList.toggle('aceso', clipeMasterAte > agora);
  }

  // Reducao do compressor como multiplicador, que e' a convencao do X32:
  // 1 = sem reducao. comp.reduction vem em dB negativos.
  const gr = tracks.map((t) => Math.pow(10, (t.comp.reduction || 0) / 20));

  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'meters', values, gr }));
  if (!scrubbing) paintTime();

  if (playing()) {
    // Agenda os proximos blocos das faixas sem compressao.
    bombear();

    if (posicao() >= duration - 0.02) {
      pause();
      relogio.base = duration;
    }

    // Faixas comprimidas continuam num <audio>, e elementos <audio> derivam
    // alguns ms do relogio. Acima de 40 ms ja se ouve flam na bateria.
    //
    // Mas escrever currentTime e' um SALTO: cancela o download em curso e
    // comeca outro. Numa faixa que ficou sem dado, a correcao chegava a cada
    // 50 ms e cancelava o proprio download que a salvaria — 47 mil pedidos
    // abortados em dois minutos e a faixa muda para sempre. Entao: dentro do
    // que ja esta em memoria corrige na hora, que sai de graca; fora dele, no
    // maximo uma vez por segundo.
    const ref = posicao();
    for (const t of tracks) {
      if (!t.audio) continue;
      if (Math.abs(t.audio.currentTime - ref) <= 0.04) continue;

      const naMemoria = t.audio.readyState >= 3 && temDado(t.audio, ref);
      if (!naMemoria && agora - (t.ultimoSalto || 0) < 1000) continue;

      t.ultimoSalto = agora;
      t.audio.currentTime = ref;
    }
  }
}, 50);

// O ponto ja esta carregado? Saltar para dentro do que esta em memoria nao
// custa pedido nenhum; saltar para fora dispara um novo download.
function temDado(audio, pos) {
  for (let i = 0; i < audio.buffered.length; i++) {
    if (pos >= audio.buffered.start(i) && pos < audio.buffered.end(i)) return true;
  }
  return false;
}

el('ip').textContent = location.hostname;
connect();
