'use strict';

const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
const master = ctx.createGain();
master.connect(ctx.destination);

let tracks = [];
let leader = null;      // elemento <audio> que serve de relogio
let duration = 0;
let workletReady = false;
let scrubbing = false;

const el = (id) => document.getElementById(id);

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
      main.fader = msg.state.main.fader;
      main.on = msg.state.main.on;
      refreshMaster();
      return;
    }
    if (msg.type === 'param') handleParam(msg);
  };
}

function handleParam({ address, value, gain, channel: msgState, solos }) {
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

function applyGate(t, g) {
  if (!t.gate) return;   // sem AudioWorklet o canal passa limpo
  const p = t.gate.parameters;
  const now = ctx.currentTime;
  p.get('bypass').setValueAtTime(g.on ? 0 : 1, now);
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

function applyDyn(t, d) {
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
    try { t.audio.pause(); } catch (e) { /* elemento ja descartado */ }
    for (const no of [t.src, t.trim, t.gate, ...t.eq, t.comp, t.makeup, t.gain, t.pan, t.analyser]) {
      if (no) { try { no.disconnect(); } catch (e) { /* ja desconectado */ } }
    }
    t.audio.removeAttribute('src');
    t.audio.load();
    URL.revokeObjectURL(t.url);
  }

  tracks = [];
  leader = null;
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
});

el('picker').addEventListener('change', async (ev) => {
  const files = [...ev.target.files]
    .filter((f) => /\.(wav|aiff?|mp3|m4a|flac|ogg|opus)$/i.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 32);

  if (files.length === 0) {
    setLoaderText('Nenhum arquivo de áudio nessa pasta. Use WAV, AIFF, MP3, M4A, FLAC ou OGG.');
    return;
  }

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

  for (const file of files) {
    const audio = new Audio();
    // Guardamos a URL para poder revogar depois: sao dezenas de MB por faixa, e
    // sem revogar elas ficam presas na memoria ao trocar de musica.
    const url = URL.createObjectURL(file);
    audio.src = url;
    audio.preload = 'auto';
    audio.crossOrigin = 'anonymous';

    try {
      await new Promise((resolve, reject) => {
        audio.addEventListener('loadedmetadata', resolve, { once: true });
        audio.addEventListener('error', () => reject(audio.error), { once: true });
        setTimeout(() => reject(new Error('tempo esgotado')), 15000);
      });
    } catch (err) {
      falhas.push(file.name);
      URL.revokeObjectURL(url);
      console.error('Não abriu', file.name, err);
      // Sem isto a tela fica parada no aviso inicial enquanto os arquivos falham
      // um a um, e parece travamento.
      setLoaderText(`${tracks.length} de ${files.length} — não abriu: ${file.name}`);
      continue;
    }

    const src = ctx.createMediaElementSource(audio);
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
    const makeup = ctx.createGain();
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;

    src.connect(trim);
    if (gate) trim.connect(gate).connect(eq[0]);
    else trim.connect(eq[0]);
    eq[0].connect(eq[1]).connect(eq[2]).connect(eq[3]);
    eq[3].connect(comp).connect(makeup).connect(gain).connect(pan).connect(master);

    // Medidor PRE-FADER, como na X32: sai depois do ganho, gate, EQ e comp, mas
    // antes do fader e do mute. E' o que deixa ajustar ganho pelo medidor com o
    // fader onde estiver. Saindo de `gain` (o fader), o medidor seguia o fader e
    // dava a impressao de que o fader era o botao de ganho.
    makeup.connect(analyser);
    gain.gain.value = faderToGain(0.75);

    tracks.push({
      name: file.name.replace(/\.[^.]+$/, '').slice(0, 12),
      audio,
      url,
      src,
      trim,
      gate,
      eq,
      comp,
      makeup,
      gain,
      pan,
      analyser,
      data: new Float32Array(analyser.fftSize),
      on: 1,
      solo: 0,
      fader: 0.75,
      dynSeq: 0,
      eqTypes: [1, 2, 2, 4],
      eqOn: 1,
    });

    duration = Math.max(duration, audio.duration || 0);
    setLoaderText(`Preparando ${tracks.length} de ${files.length}…`);
  }

  if (tracks.length === 0) {
    setLoaderText(`Nenhuma faixa pôde ser aberta: ${falhas.join(', ')}.`);
    return;
  }

  leader = tracks[0].audio;
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
});

function setLoaderText(txt) {
  el('loader').querySelector('p').textContent = txt;
}

// ---------------------------------------------------------------------------
// Transporte
// ---------------------------------------------------------------------------
function playing() {
  return leader && !leader.paused;
}

async function play() {
  await ctx.resume();
  // Alinha todos antes de soltar, senao cada um arranca de onde parou.
  const pos = leader.currentTime;
  for (const t of tracks) t.audio.currentTime = pos;
  await Promise.all(tracks.map((t) => t.audio.play()));
  el('playbtn').textContent = 'Pausar';
  sendTape(2);
}

function pause() {
  for (const t of tracks) t.audio.pause();
  el('playbtn').textContent = 'Tocar';
  sendTape(1);
}

function seek(pos) {
  const clamped = Math.max(0, Math.min(pos, duration));
  for (const t of tracks) t.audio.currentTime = clamped;
  paintTime();
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
el('back10').addEventListener('click', () => seek(leader.currentTime - 10));
el('fwd10').addEventListener('click', () => seek(leader.currentTime + 10));

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
  if (e.code === 'ArrowLeft') seek(leader.currentTime - 5);
  if (e.code === 'ArrowRight') seek(leader.currentTime + 5);
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
  if (!leader) return;
  const pos = leader.currentTime;
  el('time').textContent = `${fmt(pos)} / ${fmt(duration)}`;
  if (duration) el('fill').style.width = `${(pos / duration) * 100}%`;
}

// ---------------------------------------------------------------------------
// Loop: medidores, relogio e correcao de deriva entre as faixas
// ---------------------------------------------------------------------------
setInterval(() => {
  if (tracks.length === 0) return;

  const values = tracks.map((t) => {
    t.analyser.getFloatTimeDomainData(t.data);
    let sum = 0;
    for (let i = 0; i < t.data.length; i++) sum += t.data[i] * t.data[i];
    return Math.min(1, Math.sqrt(sum / t.data.length) * 2.2);
  });

  values.forEach((v, i) => {
    const b = el('strips').querySelector(`[data-meter="${i}"]`);
    if (b) b.style.width = `${Math.round(v * 100)}%`;
  });

  // Reducao do compressor como multiplicador, que e' a convencao do X32:
  // 1 = sem reducao. comp.reduction vem em dB negativos.
  const gr = tracks.map((t) => Math.pow(10, (t.comp.reduction || 0) / 20));

  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'meters', values, gr }));
  if (!scrubbing) paintTime();

  // Elementos <audio> derivam alguns ms entre si. Acima de 40 ms ja se ouve
  // flam na bateria, entao realinhamos pelo relogio da primeira faixa.
  if (playing()) {
    const ref = leader.currentTime;
    for (const t of tracks) {
      if (t.audio === leader) continue;
      if (Math.abs(t.audio.currentTime - ref) > 0.04) t.audio.currentTime = ref;
    }
  }
}, 50);

el('ip').textContent = location.hostname;
connect();
