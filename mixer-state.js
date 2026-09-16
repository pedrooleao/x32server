'use strict';

// Estado de uma mesa X32 simplificada: 32 canais de entrada + LR + 16 buses.
// Guardamos so o que o Mixing Station consulta com frequencia.

const CH_COUNT = 32;
const BUS_COUNT = 16;

const COLORS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]; // paleta do X32

// Nas linhas de texto do /node a cor vai pelo NOME, nao pelo numero. O indice
// segue numerico no parametro OSC /ch/NN/config/color; so o dump de node usa
// isto. O campo logo depois da cor e' a entrada fisica do canal, entao um valor
// que o app nao sabe ler ali derruba a leitura da entrada junto.
const COLOR_NAMES = [
  'OFF', 'RD', 'GN', 'YE', 'BL', 'MG', 'CY', 'WH',
  'OFFi', 'RDi', 'GNi', 'YEi', 'BLi', 'MGi', 'CYi', 'WHi',
];

function colorName(i) {
  return COLOR_NAMES[i] || 'WH';
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

// O X32 transmite tudo normalizado em 0..1. Frequencia: 20 Hz a 20 kHz em escala
// logaritmica. Q: 10 na ponta de baixo, 0.3 na de cima (invertido).
function freqNorm(hz) {
  return Math.log(hz / 20) / Math.log(1000);
}
function normFreq(n) {
  return 20 * Math.pow(1000, n);
}
function qNorm(q) {
  return Math.log(q / 10) / Math.log(0.03);
}
function normQ(n) {
  return 10 * Math.pow(0.03, n);
}

// Tabela de ratio do X32 (dyn/ratio e' um indice, nao um float).
const RATIOS = [1.1, 1.3, 1.5, 2, 2.5, 3, 4, 5, 7, 10, 20, 100];
const EQ_TYPES = ['LCut', 'LShv', 'PEQ', 'VEQ', 'HShv', 'HCut'];
// A ordem importa: e' o indice que vai no OSC. Estava ['GATE', 'EXP2', ...],
// entao o modo 0 virava GATE quando na X32 o 0 e' EXP2 — o tablet mostrava um
// modo e a mesa entendia outro.
const GATE_MODES = ['EXP2', 'EXP3', 'EXP4', 'GATE', 'DUCK'];
const GATE_GATE = 3;   // indice do GATE de verdade
const GATE_DUCK = 4;

// O Mixing Station varre o mapa inteiro de um X32 no sync inicial e desconecta
// se algum endereco ficar mudo. Como e' inviavel modelar os ~4000 parametros da
// mesa, guardamos qualquer endereco desconhecido num dicionario generico e
// respondemos sempre, inferindo o tipo pelo nome do parametro.
const TYPE_RULES = [
  [/\/(name|url|nat)$/, 's'],
  [
    /\/(fader|level|pan|thr|gain|trim|mgain|knee|mix|range|attack|hold|release|time|width|depth|speed|feedback|damp|shape|drive|det|balance|dry|wet|lvl|freq|[fgq])$/,
    'f',
  ],
];

function guessType(address) {
  for (const [re, type] of TYPE_RULES) {
    if (re.test(address)) return type;
  }
  return 'i';
}

function defaultFor(type) {
  if (type === 's') return '';
  if (type === 'f') return 0;
  return 0;
}

// Conversao fader linear (0..1, como o X32 manda no OSC) <-> dB.
// Curva do X32 em quatro trechos, que se encontram sem degrau:
//   1.0 = +10 dB   0.75 = 0 dB   0.5 = -10 dB   0.25 = -30 dB
//   0.0625 = -60 dB   0.0 = -oo
// Os multiplicadores dobram a cada trecho para baixo (40, 80, 160, 480): o fader
// fica fino em cima, onde se mixa, e grosso embaixo, onde so se manda o canal
// embora. Estavam 160/80/40/40, o que abria saltos nas fronteiras — no meio do
// curso o volume caia 20 dB de uma vez.
function faderToDb(f) {
  if (f <= 0) return -Infinity;
  if (f < 0.0625) return f * 480 - 90;
  if (f < 0.25) return f * 160 - 70;
  if (f < 0.5) return f * 80 - 50;
  return f * 40 - 30;
}

function dbToGain(db) {
  if (!isFinite(db)) return 0;
  return Math.pow(10, db / 20);
}

function faderToGain(f) {
  return dbToGain(faderToDb(f));
}

function dbLabel(f) {
  const db = faderToDb(f);
  if (!isFinite(db)) return '-oo';
  return (db >= 0 ? '+' : '') + db.toFixed(1);
}

class MixerState {
  constructor() {
    this.channels = [];
    for (let i = 1; i <= CH_COUNT; i++) {
      this.channels.push({
        index: i,
        name: '',            // vazio = X32 mostra "Ch01"
        color: COLORS[(i - 1) % COLORS.length],
        fader: 0.75,         // 0 dB
        on: 1,               // 1 = ativo, 0 = mudo
        pan: 0.5,
        solo: 0,
        // Ganho do preamp analogico: 0..1 vale -12 a +60 dB, entao 1/6 = 0 dB.
        // Guardado por fidelidade, mas NAO mexe no audio: os canais sao
        // alimentados pelo cartao, e sinal digital nao passa por preamp.
        gain: 1 / 6,
        // Trim digital: 0..1 vale -18 a +18 dB, entao 0.5 = 0 dB. E' este que
        // controla o audio, e o endereco (/ch/NN/preamp/trim) ja traz o numero
        // do canal — nao depende do mapa de preamps que o app nao monta.
        trim: 0.5,
        // Low Cut do preamp — o botao "Lowcut" da tela do canal. E' separado do
        // EQ e vem antes dele na cadeia. Inclinacao selecionavel na X32.
        hpon: 0,                 // 0 = desligado
        hpslope: 1,              // 0=12, 1=18, 2=24 dB/oitava
        hpf: freqNorm(100),      // 20 a 400 Hz
        // Qual entrada fisica alimenta o canal. 0 = nenhuma, 1..32 = Local In.
        // O Mixing Station usa isto para descobrir de qual preamp e' o botao de
        // ganho do canal: com 0 em todos, o botao nao tinha em que mexer.
        // Canal N <- Local In N <- headamp N-1 (o headamp conta do zero).
        // Entrada que alimenta o canal: 1..32 = Local In 1..32. Assim o app
        // mostra o botao de Gain com a faixa cheia (-12 a +60 dB). Ele nao
        // consegue descobrir sozinho qual preamp e' de qual canal e manda tudo
        // para o /headamp/000 — o servidor resolve isso pelo canal em foco.
        source: i,
        sends: new Array(BUS_COUNT).fill(0.0),

        // Valores normalizados 0..1, como o X32 transmite por OSC.
        eq: {
          on: 1,
          bands: [
            { type: 1, f: freqNorm(100), g: 0.5, q: qNorm(1.4) },   // LowShelf
            { type: 2, f: freqNorm(500), g: 0.5, q: qNorm(2.0) },   // PEQ
            { type: 2, f: freqNorm(2000), g: 0.5, q: qNorm(2.0) },  // PEQ
            { type: 4, f: freqNorm(8000), g: 0.5, q: qNorm(1.4) },  // HighShelf
          ],
        },
        gate: {
          on: 0,
          mode: GATE_GATE,  // 3 = GATE, o padrao sensato para um canal
          thr: 0.5,         // -40 dB
          range: 0.75,      // ~46 dB
          attack: 0.0,      // 0 ms
          hold: 0.1,
          release: 0.25,
        },
        dyn: {
          on: 0,
          mode: 0,          // 0=COMP, 1=EXP
          det: 0,
          env: 0,
          thr: 0.33,        // -20 dB
          ratio: 5,         // indice na tabela (3:1)
          knee: 0.5,
          mgain: 0,
          attack: 0.083,    // 10 ms
          hold: 0.1,
          release: 0.25,
          mix: 1,
          pos: 0,
        },
      });
    }
    this.main = { fader: 0.75, on: 1, pan: 0.5, name: 'LR' };
    this.buses = [];
    for (let i = 1; i <= BUS_COUNT; i++) {
      this.buses.push({ index: i, name: '', color: 1, fader: 0.75, on: 1 });
    }
    // Enderecos fora do modelo acima, guardados como vieram.
    this.extra = new Map();

    // Patch de entrada, em blocos de 8. O valor e' um enum de origem do bloco:
    // 0 = Local 1-8, 1 = Local 9-16, 2 = Local 17-24, 3 = Local 25-32.
    // O Mixing Station monta o mapa de preamps a partir daqui — nunca lendo
    // /ch/NN/config/source. Vindo 0 nos quatro (o padrao do catch-all), a mesa
    // dizia que os 32 canais saem das MESMAS 8 entradas, e o botao de ganho de
    // qualquer canal caia no preamp 0.
    this.extra.set('/config/routing/IN/1-8', 0);
    this.extra.set('/config/routing/IN/9-16', 1);
    this.extra.set('/config/routing/IN/17-24', 2);
    this.extra.set('/config/routing/IN/25-32', 3);

    // Transporte do "player" (mapeado no X32 como USB/tape)
    // 0=STOP 1=PAUSE 2=PLAY 3=PAUSE_REC 4=REC 5=FF 6=REW
    this.tapeState = 0;
  }

  channel(n) {
    return this.channels[n - 1] || null;
  }

  /**
   * Le ou escreve um parametro pelo endereco OSC.
   * @returns {{type:'i'|'f'|'s', value:any}|null}
   */
  access(address, newValue) {
    const write = newValue !== undefined;

    let m = address.match(/^\/ch\/(\d{2})\/(.+)$/);
    if (m) {
      const ch = this.channel(parseInt(m[1], 10));
      if (!ch) return null;
      const key = m[2];
      switch (key) {
        case 'mix/fader':
          if (write) ch.fader = clamp01(newValue);
          return { type: 'f', value: ch.fader };
        case 'mix/on':
          if (write) ch.on = newValue ? 1 : 0;
          return { type: 'i', value: ch.on };
        case 'mix/pan':
          if (write) ch.pan = clamp01(newValue);
          return { type: 'f', value: ch.pan };
        case 'config/name':
          if (write) ch.name = String(newValue).slice(0, 12);
          return { type: 's', value: ch.name };
        case 'config/color':
          if (write) ch.color = newValue | 0;
          return { type: 'i', value: ch.color };
        case 'config/source':
          if (write) ch.source = newValue | 0;
          return { type: 'i', value: ch.source };
        // Dois parametros distintos na X32, com faixas distintas. Estavam
        // caindo no mesmo campo.
        case 'preamp/hpon':
          if (write) ch.hpon = newValue ? 1 : 0;
          return { type: 'i', value: ch.hpon };
        case 'preamp/hpslope':
          if (write) ch.hpslope = newValue | 0;
          return { type: 'i', value: ch.hpslope };
        case 'preamp/hpf':
          if (write) ch.hpf = clamp01(newValue);
          return { type: 'f', value: ch.hpf };
        case 'preamp/trim':
          if (write) ch.trim = clamp01(newValue);
          return { type: 'f', value: ch.trim };
        case 'headamp/gain':
          if (write) ch.gain = clamp01(newValue);
          return { type: 'f', value: ch.gain };
        case 'eq/on':
          if (write) ch.eq.on = newValue ? 1 : 0;
          return { type: 'i', value: ch.eq.on };
        case 'gate/on':
          if (write) ch.gate.on = newValue ? 1 : 0;
          return { type: 'i', value: ch.gate.on };
        case 'dyn/on':
          if (write) ch.dyn.on = newValue ? 1 : 0;
          return { type: 'i', value: ch.dyn.on };

        default: {
          // EQ por banda: /ch/NN/eq/1/{type,f,g,q}
          const eqMatch = key.match(/^eq\/([1-4])\/(type|f|g|q)$/);
          if (eqMatch) {
            const band = ch.eq.bands[parseInt(eqMatch[1], 10) - 1];
            const field = eqMatch[2];
            if (field === 'type') {
              if (write) band.type = newValue | 0;
              return { type: 'i', value: band.type };
            }
            if (write) band[field] = clamp01(newValue);
            return { type: 'f', value: band[field] };
          }

          // Gate: /ch/NN/gate/{mode,thr,range,attack,hold,release}
          const gateMatch = key.match(/^gate\/(mode|thr|range|attack|hold|release)$/);
          if (gateMatch) {
            const field = gateMatch[1];
            if (field === 'mode') {
              if (write) ch.gate.mode = newValue | 0;
              return { type: 'i', value: ch.gate.mode };
            }
            if (write) ch.gate[field] = clamp01(newValue);
            return { type: 'f', value: ch.gate[field] };
          }

          // Dinamica: /ch/NN/dyn/{mode,det,env,thr,ratio,knee,mgain,attack,hold,release,mix,pos}
          const dynMatch = key.match(
            /^dyn\/(mode|det|env|ratio|pos|thr|knee|mgain|attack|hold|release|mix)$/
          );
          if (dynMatch) {
            const field = dynMatch[1];
            const isInt = ['mode', 'det', 'env', 'ratio', 'pos'].includes(field);
            if (isInt) {
              if (write) ch.dyn[field] = newValue | 0;
              return { type: 'i', value: ch.dyn[field] };
            }
            if (write) ch.dyn[field] = clamp01(newValue);
            return { type: 'f', value: ch.dyn[field] };
          }

          const sendMatch = key.match(/^mix\/(\d{2})\/level$/);
          if (sendMatch) {
            const idx = parseInt(sendMatch[1], 10) - 1;
            if (idx >= 0 && idx < BUS_COUNT) {
              if (write) ch.sends[idx] = clamp01(newValue);
              return { type: 'f', value: ch.sends[idx] };
            }
          }
          return this.extraAccess(address, newValue);
        }
      }
    }

    m = address.match(/^\/bus\/(\d{2})\/(.+)$/);
    if (m) {
      const bus = this.buses[parseInt(m[1], 10) - 1];
      if (!bus) return null;
      switch (m[2]) {
        case 'mix/fader':
          if (write) bus.fader = clamp01(newValue);
          return { type: 'f', value: bus.fader };
        case 'mix/on':
          if (write) bus.on = newValue ? 1 : 0;
          return { type: 'i', value: bus.on };
        case 'config/name':
          if (write) bus.name = String(newValue).slice(0, 12);
          return { type: 's', value: bus.name };
        case 'config/color':
          if (write) bus.color = newValue | 0;
          return { type: 'i', value: bus.color };
        default:
          return this.extraAccess(address, newValue);
      }
    }

    // O botao de ganho do Mixing Station manda /headamp/NNN/gain, nao um endereco
    // de canal: NNN e' o indice do preamp, base zero. Com o patch padrao (entrada
    // local 1 no canal 1) o preamp NNN e' o canal NNN+1.
    m = address.match(/^\/headamp\/(\d{1,3})\/gain$/);
    if (m) {
      const ch = this.channel(parseInt(m[1], 10) + 1);
      if (ch) {
        if (write) ch.gain = clamp01(newValue);
        return { type: 'f', value: ch.gain };
      }
    }

    // Solo. Na X32 nao e' um endereco de canal: e' /-stat/solosw/NN, numerado
    // de 01 a 80 (canais, aux, fx, bus, matrizes...). So os 32 primeiros nos
    // interessam. O /-stat/solo e' o aviso de "tem algum solo ligado", que a
    // mesa acende sozinha — so leitura.
    m = address.match(/^\/-stat\/solosw\/(\d{1,2})$/);
    if (m) {
      const ch = this.channel(parseInt(m[1], 10));
      if (ch) {
        if (write) ch.solo = newValue ? 1 : 0;
        return { type: 'i', value: ch.solo };
      }
      // Fora dos 32 canais (aux, fx, bus): guarda e devolve, sem efeito.
      return this.extraAccess(address, newValue);
    }

    if (address === '/-stat/solo') {
      return { type: 'i', value: this.soloAtivo() ? 1 : 0 };
    }

    switch (address) {
      case '/main/st/mix/fader':
        if (write) this.main.fader = clamp01(newValue);
        return { type: 'f', value: this.main.fader };
      case '/main/st/mix/on':
        if (write) this.main.on = newValue ? 1 : 0;
        return { type: 'i', value: this.main.on };
      case '/main/st/mix/pan':
        if (write) this.main.pan = clamp01(newValue);
        return { type: 'f', value: this.main.pan };
      case '/main/st/config/name':
        if (write) this.main.name = String(newValue).slice(0, 12);
        return { type: 's', value: this.main.name };
      case '/-stat/tape/state':
        if (write) this.tapeState = newValue | 0;
        return { type: 'i', value: this.tapeState };
      default:
        break;
    }

    return this.extraAccess(address, newValue);
  }

  /** Qualquer endereco nao modelado: guarda e devolve, para o sync nao quebrar. */
  extraAccess(address, newValue) {
    const type = guessType(address);
    if (newValue !== undefined) {
      const value = type === 's' ? String(newValue) : type === 'i' ? newValue | 0 : Number(newValue);
      this.extra.set(address, value);
      return { type, value };
    }
    if (!this.extra.has(address)) this.extra.set(address, defaultFor(type));
    return { type, value: this.extra.get(address) };
  }

  /**
   * Resposta do comando /node, que o Mixing Station usa para
   * sincronizar blocos inteiros de parametros de uma vez.
   * Formato: uma linha de texto igual a da mesa real.
   */
  node(path) {
    const p = path.replace(/^\//, '');

    // Preamp fisico. Formato do X32: "/headamp/013 +0.0 OFF" — ganho em dB como
    // texto e phantom por nome. O catch-all respondia "/headamp/013 0", que nao
    // e' leitura valida para quem monta o mapa de preamps a partir daqui.
    let m = p.match(/^headamp\/(\d{1,3})$/);
    if (m) {
      const idx = parseInt(m[1], 10);
      const ch = this.channel(idx + 1);
      const db = ch ? ch.gain * 72 - 12 : 0;
      const phantom = this.extra.get(`/headamp/${pad3(idx)}/phantom`) ? 'ON' : 'OFF';
      return `/headamp/${pad3(idx)} ${db >= 0 ? '+' : ''}${db.toFixed(1)} ${phantom}`;
    }

    m = p.match(/^ch\/(\d{2})\/(config|mix)$/);
    if (m) {
      const ch = this.channel(parseInt(m[1], 10));
      if (!ch) return null;
      if (m[2] === 'config') {
        return `/ch/${pad2(ch.index)}/config "${ch.name}" ${ch.color} ${colorName(ch.color)} ${ch.source}`;
      }
      const sends = ch.sends.map((s) => dbLabel(s)).join(' ');
      return `/ch/${pad2(ch.index)}/mix ${ch.on ? 'ON' : 'OFF'} ${dbLabel(ch.fader)} ${
        ch.pan === 0.5 ? 0 : Math.round((ch.pan - 0.5) * 200)
      } OFF -oo ${sends}`;
    }

    m = p.match(/^ch\/(\d{2})\/gate$/);
    if (m) {
      const ch = this.channel(parseInt(m[1], 10));
      if (!ch) return null;
      const g = ch.gate;
      return `/ch/${m[1]}/gate ${g.on ? 'ON' : 'OFF'} ${GATE_MODES[g.mode] || 'GATE'} ${(
        g.thr * 80 - 80
      ).toFixed(1)} ${(3 + g.range * 57).toFixed(1)} ${(g.attack * 120).toFixed(0)} ${(
        g.hold * 2000
      ).toFixed(0)} ${(5 * Math.pow(800, g.release)).toFixed(0)}`;
    }

    m = p.match(/^ch\/(\d{2})\/dyn$/);
    if (m) {
      const ch = this.channel(parseInt(m[1], 10));
      if (!ch) return null;
      const d = ch.dyn;
      return `/ch/${m[1]}/dyn ${d.on ? 'ON' : 'OFF'} ${d.mode ? 'EXP' : 'COMP'} ${
        d.det ? 'RMS' : 'PEAK'
      } ${d.env ? 'LOG' : 'LIN'} ${(d.thr * 60 - 60).toFixed(1)} ${RATIOS[d.ratio] || 3} ${(
        d.knee * 5
      ).toFixed(1)} ${(d.mgain * 24).toFixed(1)} ${(d.attack * 120).toFixed(0)} ${(
        d.hold * 2000
      ).toFixed(0)} ${(5 * Math.pow(800, d.release)).toFixed(0)} ${d.pos ? 'POST' : 'PRE'} ${(
        d.mix * 100
      ).toFixed(0)}`;
    }

    m = p.match(/^ch\/(\d{2})\/eq$/);
    if (m) {
      const ch = this.channel(parseInt(m[1], 10));
      if (!ch) return null;
      return `/ch/${m[1]}/eq ${ch.eq.on ? 'ON' : 'OFF'}`;
    }

    m = p.match(/^ch\/(\d{2})\/eq\/([1-4])$/);
    if (m) {
      const ch = this.channel(parseInt(m[1], 10));
      if (!ch) return null;
      const b = ch.eq.bands[parseInt(m[2], 10) - 1];
      return `/ch/${m[1]}/eq/${m[2]} ${EQ_TYPES[b.type] || 'PEQ'} ${normFreq(b.f).toFixed(
        1
      )} ${(b.g * 30 - 15).toFixed(1)} ${normQ(b.q).toFixed(1)}`;
    }

    m = p.match(/^bus\/(\d{2})\/(config|mix)$/);
    if (m) {
      const bus = this.buses[parseInt(m[1], 10) - 1];
      if (!bus) return null;
      if (m[2] === 'config') {
        return `/bus/${pad2(bus.index)}/config "${bus.name}" ${bus.color} ${colorName(bus.color)} ${bus.index}`;
      }
      return `/bus/${pad2(bus.index)}/mix ${bus.on ? 'ON' : 'OFF'} ${dbLabel(bus.fader)} 0 OFF -oo`;
    }

    if (p === 'main/st/config') {
      return `/main/st/config "${this.main.name}" 1 RD`;
    }
    if (p === 'main/st/mix') {
      return `/main/st/mix ${this.main.on ? 'ON' : 'OFF'} ${dbLabel(this.main.fader)} 0`;
    }

    // Parametro solto ou no desconhecido: sempre devolve alguma coisa.
    // Uma resposta imperfeita e' melhor que silencio, que derruba o sync.
    const direct = this.access('/' + p);
    if (direct.type === 's') return `/${p} "${direct.value}"`;
    if (direct.type === 'f') return `/${p} ${Number(direct.value).toFixed(4)}`;
    return `/${p} ${direct.value}`;
  }

  /** Lista de nos que compoem um show completo, na ordem de um arquivo .scn. */
  showdumpPaths() {
    const paths = ['/config', '/config/chlink', '/config/buslink', '/config/mute'];

    for (let i = 1; i <= CH_COUNT; i++) {
      const n = pad2(i);
      paths.push(
        `/ch/${n}/config`,
        `/ch/${n}/delay`,
        `/ch/${n}/preamp`,
        `/ch/${n}/gate`,
        `/ch/${n}/dyn`,
        `/ch/${n}/insert`,
        `/ch/${n}/eq`,
        `/ch/${n}/eq/1`,
        `/ch/${n}/eq/2`,
        `/ch/${n}/eq/3`,
        `/ch/${n}/eq/4`,
        `/ch/${n}/mix`,
        `/ch/${n}/grp`,
        `/ch/${n}/automix`
      );
      for (let b = 1; b <= BUS_COUNT; b++) {
        paths.push(`/ch/${n}/mix/${pad2(b)}`);
      }
    }

    for (let i = 1; i <= BUS_COUNT; i++) {
      const n = pad2(i);
      paths.push(`/bus/${n}/config`, `/bus/${n}/dyn`, `/bus/${n}/eq`, `/bus/${n}/mix`, `/bus/${n}/grp`);
    }

    for (let i = 1; i <= 6; i++) {
      paths.push(`/mtx/${pad2(i)}/config`, `/mtx/${pad2(i)}/mix`);
    }

    paths.push('/main/st/config', '/main/st/mix', '/main/st/eq', '/main/st/dyn');
    paths.push('/main/m/config', '/main/m/mix');

    for (let i = 1; i <= 8; i++) paths.push(`/dca/${i}`, `/dca/${i}/config`);
    for (let i = 1; i <= 8; i++) paths.push(`/fx/${i}`, `/fx/${i}/par`);
    for (let i = 1; i <= 8; i++) {
      paths.push(`/fxrtn/${pad2(i)}/config`, `/fxrtn/${pad2(i)}/mix`);
    }
    for (let i = 1; i <= 16; i++) paths.push(`/outputs/main/${pad2(i)}`);
    for (let i = 1; i <= 6; i++) paths.push(`/outputs/aux/${pad2(i)}`);
    paths.push('/config/routing', '/config/routing/IN', '/config/routing/AES50A', '/config/routing/CARD');

    return paths;
  }

  /** Ha algum canal em solo? */
  soloAtivo() {
    return this.channels.some((c) => c.solo);
  }

  /** Snapshot enviado ao navegador para montar a engine de audio. */
  snapshot() {
    return {
      channels: this.channels.map((c) => ({
        index: c.index,
        name: c.name,
        color: c.color,
        fader: c.fader,
        on: c.on,
        solo: c.solo,
        pan: c.pan,
        gain: faderToGain(c.fader),   // ganho do fader, ja convertido
        trim: c.trim,                 // trim digital, 0..1 = -18 a +18 dB
        ha: c.gain,                   // ganho de preamp, 0..1 = -12 a +60 dB
        hp: { on: c.hpon, slope: c.hpslope, f: c.hpf },
        eq: c.eq,
        gate: c.gate,
        dyn: c.dyn,
      })),
      main: { ...this.main, gain: faderToGain(this.main.fader) },
      tapeState: this.tapeState,
    };
  }
}

function clamp01(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

module.exports = {
  MixerState,
  CH_COUNT,
  BUS_COUNT,
  faderToGain,
  faderToDb,
  dbLabel,
  RATIOS,
  normFreq,
  normQ,
};
