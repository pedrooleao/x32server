'use strict';

// Ponte entre a arvore da WING e o estado da mesa (que fala X32).
//
// O motor de audio do navegador so entende o estado da X32: fader de 0 a 1,
// frequencia normalizada, gate em cinco modos. Em vez de ensinar a ele uma
// segunda mesa, a WING traduz: o WING Edit mexe em /ch/1/fdr em dB, a ponte
// escreve /ch/01/mix/fader como se fosse o Mixing Station, e o som segue o
// mesmo caminho de sempre. No sentido contrario, quando o Mixing Station mexe,
// a ponte atualiza a WING e o WING Edit ve o fader andar.
//
// O que a WING tem e a X32 nao (canais 33 a 40, modelos de EQ e dinamica que
// nao o padrao...) fica guardado na arvore, responde ao WING Edit, mas nao
// mexe no audio.

const { faderToDb } = require('../mixer-state');

const RATIOS_X32 = [1.1, 1.3, 1.5, 2, 2.5, 3, 4, 5, 7, 10, 20, 100];

const pad2 = (n) => String(n).padStart(2, '0');
const pad3 = (n) => String(n).padStart(3, '0');
const limitar01 = (v) => Math.max(0, Math.min(1, v));

// Fader da X32 (0..1) <-> dB. A curva e' a mesma de mixer-state.js.
function dbParaFader(db) {
  if (db <= -90) return 0;
  if (db < -60) return (db + 90) / 480;
  if (db < -30) return (db + 70) / 160;
  if (db < -10) return (db + 50) / 80;
  return limitar01((db + 30) / 40);
}
function faderParaDb(f) {
  const db = faderToDb(f);
  return isFinite(db) ? db : -144;
}

// Escalas da X32, as mesmas que public/app.js usa para montar o audio.
const freqNorm = (hz) => limitar01(Math.log(hz / 20) / Math.log(1000));
const normFreq = (n) => 20 * Math.pow(1000, n);
const qNorm = (q) => limitar01(Math.log(q / 10) / Math.log(0.03));
const normQ = (n) => 10 * Math.pow(0.03, n);
const relNorm = (ms) => limitar01(Math.log(Math.max(ms, 5) / 5) / Math.log(800));
const normRel = (n) => 5 * Math.pow(800, n);

function ratioMaisPerto(r) {
  let melhor = 0;
  RATIOS_X32.forEach((x, i) => {
    if (Math.abs(Math.log(x / r)) < Math.abs(Math.log(RATIOS_X32[melhor] / r))) melhor = i;
  });
  return melhor;
}

// Gate da X32: 0 EXP2, 1 EXP3, 2 EXP4, 3 GATE, 4 DUCK. No GATE da WING o modo
// e' o "ratio": 1:1.5 a 1:4 sao expansores, "gate" fecha ate o range.
const RATIO_GATE_PARA_MODO = { '1:1.5': 0, '1:2': 0, '1:3': 1, '1:4': 2, gate: 3 };
const MODO_PARA_RATIO_GATE = ['1:2', '1:3', '1:4', 'gate'];

// As 6 bandas do EQ padrao da WING (L, 1-4, H) e onde cada uma cai no estado.
// As 4 primeiras do estado sao as da X32; a WING tem duas a mais, que ficam
// nas posicoes 5 e 6 — o filtro em serie e' o mesmo em qualquer ordem.
const BANDAS = [['l', 1], ['1', 2], ['2', 5], ['3', 3], ['4', 6], ['h', 4]];

class Ponte {
  /**
   * @param {object} o
   * @param {(endereco:string)=>any} o.lerX32     valor atual no estado
   * @param {(endereco:string, valor:any)=>void} o.escreverX32
   * @param {(caminho:string)=>any} o.lerWing     valor atual na arvore, ou undefined
   * @param {(caminho:string, valor:any)=>void} o.escreverWing
   * @param {(acao:string)=>void} o.aoTransporte  play/pause/stop do player
   */
  constructor(o) {
    Object.assign(this, o);
    this.ligacoes = [];
    this.porWing = new Map();
    this.porX32 = new Map();
    this.montar();
  }

  /**
   * Uma ligacao: quais caminhos da WING e enderecos da X32 ela junta, e como
   * passar de um para o outro. `bloco` + `modelos` dizem quando ela vale — os
   * botoes do GATE so existem com o modelo GATE escolhido.
   */
  ligar(l) {
    this.ligacoes.push(l);
    for (const c of l.wing) {
      if (!this.porWing.has(c)) this.porWing.set(c, []);
      this.porWing.get(c).push(l);
    }
    for (const a of l.x32) {
      if (!this.porX32.has(a)) this.porX32.set(a, []);
      this.porX32.get(a).push(l);
    }
  }

  /** Ligacao de um parametro para outro, com a conversao nos dois sentidos. */
  um(wing, x32, ida, volta, cond) {
    this.ligar({
      wing: [wing],
      x32: [x32],
      ...cond,
      paraX32: (ler) => (ida ? [[x32, ida(ler(wing))]] : []),
      daX32: (ler32) => [[wing, volta(ler32(x32))]],
    });
  }

  montar() {
    const igual = (v) => v;
    const inverso = (v) => (v ? 0 : 1);

    for (let n = 1; n <= 32; n++) {
      const w = `/ch/${n}`;
      const x = `/ch/${pad2(n)}`;

      this.um(`${w}/fdr`, `${x}/mix/fader`, dbParaFader, faderParaDb);
      this.um(`${w}/mute`, `${x}/mix/on`, inverso, inverso);
      this.um(`${w}/pan`, `${x}/mix/pan`, (p) => p / 200 + 0.5, (v) => (v - 0.5) * 200);
      this.um(`${w}/name`, `${x}/config/name`, igual, igual);
      this.um(`${w}/$solo`, `/-stat/solosw/${pad2(n)}`, igual, igual);

      // Entrada: fase, trim digital e o ganho do preamp (que na X32 mora no
      // /headamp, contado do zero).
      this.um(`${w}/in/set/inv`, `${x}/preamp/invert`, igual, igual);
      this.um(`${w}/in/set/trim`, `${x}/preamp/trim`, (db) => (db + 18) / 36, (v) => v * 36 - 18);
      this.um(`${w}/in/set/$g`, `/headamp/${pad3(n - 1)}/gain`, (db) => (db + 12) / 72, (v) => v * 72 - 12);

      // Low cut. O da WING vai a 2 kHz; o da X32, e o do player, a 400 Hz.
      this.um(`${w}/flt/lc`, `${x}/preamp/hpon`, igual, igual);
      this.um(`${w}/flt/lcf`, `${x}/preamp/hpf`,
        (hz) => limitar01(Math.log(Math.min(hz, 400) / 20) / Math.log(20)),
        (v) => 20 * Math.pow(20, v));
      this.um(`${w}/flt/lcs`, `${x}/preamp/hpslope`,
        (s) => ({ 6: 0, 12: 0, 18: 1, 24: 2 })[s] ?? 1,
        (v) => ['12', '18', '24'][v] || '18');

      this.montarEq(n, w, x);
      this.montarGate(n, w, x);
      this.montarDinamica(n, w, x);

      for (let b = 1; b <= 16; b++) {
        this.um(`${w}/send/${b}/lvl`, `${x}/mix/${pad2(b)}/level`, dbParaFader, faderParaDb);
        this.um(`${w}/send/${b}/on`, `${x}/mix/${pad2(b)}/on`, igual, igual);
      }
    }

    for (let b = 1; b <= 16; b++) {
      this.um(`/bus/${b}/fdr`, `/bus/${pad2(b)}/mix/fader`, dbParaFader, faderParaDb);
      this.um(`/bus/${b}/mute`, `/bus/${pad2(b)}/mix/on`, inverso, inverso);
      this.um(`/bus/${b}/name`, `/bus/${pad2(b)}/config/name`, igual, igual);
    }

    this.um('/main/1/fdr', '/main/st/mix/fader', dbParaFader, faderParaDb);
    this.um('/main/1/mute', '/main/st/mix/on', inverso, inverso);
    this.um('/main/1/pan', '/main/st/mix/pan', (p) => p / 200 + 0.5, (v) => (v - 0.5) * 200);
    this.um('/main/1/name', '/main/st/config/name', igual, igual);

    // O estado do player aparece no player USB da WING. O comando vai pelo
    // $action, tratado a parte em wingEscreveu.
    this.um('/play/$actstate', '/-stat/tape/state', null,
      (v) => (v === 2 ? 'PLAY' : v === 1 ? 'PAUSE' : 'STOP'));
  }

  montarEq(n, w, x) {
    const std = { bloco: `${w}/eq`, modelos: ['STD'] };

    // Com outro modelo de EQ escolhido no WING Edit, o EQ do player desliga:
    // os botoes daquele modelo nao tem equivalente aqui.
    this.ligar({
      wing: [`${w}/eq/on`, `${w}/eq/mdl`],
      x32: [`${x}/eq/on`],
      paraX32: (ler) => [[`${x}/eq/on`, ler(`${w}/eq/on`) && ler(`${w}/eq/mdl`) === 'STD' ? 1 : 0]],
      daX32: (ler32) => [[`${w}/eq/on`, ler32(`${x}/eq/on`)]],
    });

    for (const [bw, bx] of BANDAS) {
      const e = `${x}/eq/${bx}`;
      this.um(`${w}/eq/${bw}g`, `${e}/g`, (g) => (g + 15) / 30, (v) => v * 30 - 15, std);
      this.um(`${w}/eq/${bw}f`, `${e}/f`, freqNorm, normFreq, std);
      this.um(`${w}/eq/${bw}q`, `${e}/q`, qNorm, normQ, std);
    }
    // So as bandas das pontas escolhem entre parametrico e prateleira.
    this.um(`${w}/eq/leq`, `${x}/eq/1/type`, (s) => (s === 'SHV' ? 1 : 2), (t) => (t <= 1 ? 'SHV' : 'PEQ'), std);
    this.um(`${w}/eq/heq`, `${x}/eq/4/type`, (s) => (s === 'SHV' ? 4 : 2), (t) => (t >= 4 ? 'SHV' : 'PEQ'), std);
  }

  montarGate(n, w, x) {
    const gate = { bloco: `${w}/gate`, modelos: ['GATE', 'DUCK'] };

    this.ligar({
      wing: [`${w}/gate/on`, `${w}/gate/mdl`, `${w}/gate/ratio`],
      x32: [`${x}/gate/on`, `${x}/gate/mode`],
      paraX32: (ler) => {
        const mdl = ler(`${w}/gate/mdl`);
        const temos = mdl === 'GATE' || mdl === 'DUCK';
        const lista = [[`${x}/gate/on`, ler(`${w}/gate/on`) && temos ? 1 : 0]];
        if (temos) {
          const modo = mdl === 'DUCK' ? 4 : RATIO_GATE_PARA_MODO[ler(`${w}/gate/ratio`)] ?? 3;
          lista.push([`${x}/gate/mode`, modo]);
        }
        return lista;
      },
      // So o modo da X32 escolhe o modelo. Ligar o gate pelo Mixing Station com
      // um E88 escolhido no WING Edit nao deve trocar o E88 por um GATE.
      daX32: (ler32, endereco) => {
        const lista = [[`${w}/gate/on`, ler32(`${x}/gate/on`)]];
        if (endereco === `${x}/gate/on`) return lista;
        const modo = ler32(`${x}/gate/mode`);
        if (modo === 4) lista.unshift([`${w}/gate/mdl`, 'DUCK']);
        else {
          lista.unshift([`${w}/gate/mdl`, 'GATE']);
          lista.push([`${w}/gate/ratio`, MODO_PARA_RATIO_GATE[modo] || 'gate']);
        }
        return lista;
      },
    });

    const g = `${x}/gate`;
    // De novo o ratio, agora preso ao modelo: e' o que o faz voltar do estado
    // quando o WING Edit escolhe o GATE, em vez de nascer em 1:1.5.
    this.um(`${w}/gate/ratio`, `${g}/mode`,
      (r) => RATIO_GATE_PARA_MODO[r] ?? 3,
      (m) => MODO_PARA_RATIO_GATE[m] || 'gate',
      { bloco: `${w}/gate`, modelos: ['GATE'] });
    this.um(`${w}/gate/thr`, `${g}/thr`, (t) => (t + 80) / 80, (v) => v * 80 - 80, gate);
    this.um(`${w}/gate/range`, `${g}/range`, (r) => (r - 3) / 57, (v) => 3 + v * 57, gate);
    this.um(`${w}/gate/att`, `${g}/attack`, (ms) => ms / 120, (v) => v * 120, gate);
    this.um(`${w}/gate/hld`, `${g}/hold`, (ms) => ms / 2000, (v) => v * 2000, gate);
    this.um(`${w}/gate/rel`, `${g}/release`, relNorm, normRel, gate);
  }

  montarDinamica(n, w, x) {
    const comp = { bloco: `${w}/dyn`, modelos: ['COMP'] };

    // A X32 tem COMP e EXP; o player so comprime. Os outros modelos da WING
    // (LA, 76LA, B160...) passam limpo.
    this.ligar({
      wing: [`${w}/dyn/on`, `${w}/dyn/mdl`],
      x32: [`${x}/dyn/on`, `${x}/dyn/mode`],
      paraX32: (ler) => {
        const mdl = ler(`${w}/dyn/mdl`);
        const temos = mdl === 'COMP' || mdl === 'EXP';
        const lista = [[`${x}/dyn/on`, ler(`${w}/dyn/on`) && temos ? 1 : 0]];
        if (temos) lista.push([`${x}/dyn/mode`, mdl === 'EXP' ? 1 : 0]);
        return lista;
      },
      daX32: (ler32, endereco) => {
        const lista = [[`${w}/dyn/on`, ler32(`${x}/dyn/on`)]];
        if (endereco !== `${x}/dyn/on`) lista.unshift([`${w}/dyn/mdl`, ler32(`${x}/dyn/mode`) === 1 ? 'EXP' : 'COMP']);
        return lista;
      },
    });

    const d = `${x}/dyn`;
    this.um(`${w}/dyn/thr`, `${d}/thr`, (t) => (t + 60) / 60, (v) => v * 60 - 60, comp);
    this.um(`${w}/dyn/ratio`, `${d}/ratio`, ratioMaisPerto, (i) => RATIOS_X32[i] ?? 3, comp);
    this.um(`${w}/dyn/knee`, `${d}/knee`, (k) => k / 5, (v) => Math.round(v * 5), comp);
    this.um(`${w}/dyn/att`, `${d}/attack`, (ms) => ms / 120, (v) => v * 120, comp);
    this.um(`${w}/dyn/hld`, `${d}/hold`, (ms) => ms / 2000, (v) => v * 2000, comp);
    this.um(`${w}/dyn/rel`, `${d}/release`, relNorm, normRel, comp);
    this.um(`${w}/dyn/det`, `${d}/det`, (s) => (s === 'RMS' ? 1 : 0), (v) => (v ? 'RMS' : 'PEAK'), comp);
    this.um(`${w}/dyn/env`, `${d}/env`, (s) => (s === 'LOG' ? 1 : 0), (v) => (v ? 'LOG' : 'LIN'), comp);
    // O ganho de saida da dinamica vale para qualquer modelo. A X32 so tem
    // makeup positivo; abaixo de 0 dB fica em 0.
    this.um(`${w}/dyn/gain`, `${d}/mgain`, (g) => limitar01(g / 24), (v) => v * 24);
  }

  vale(l) {
    if (!l.bloco) return true;
    return l.modelos.includes(this.lerWing(`${l.bloco}/mdl`));
  }

  aplicarNaX32(l) {
    if (!this.vale(l)) return;
    for (const [endereco, valor] of l.paraX32(this.lerWing)) {
      if (valor !== undefined && valor !== null && !Number.isNaN(valor)) this.escreverX32(endereco, valor);
    }
  }

  aplicarNaWing(l, endereco) {
    if (!this.vale(l)) return;
    for (const [caminho, valor] of l.daX32(this.lerX32, endereco)) {
      if (valor !== undefined && valor !== null && !Number.isNaN(valor)) this.escreverWing(caminho, valor);
    }
  }

  /** Copia o estado inteiro da X32 para a WING, sem avisar ninguem. */
  inicializar() {
    for (const l of this.ligacoes) this.aplicarNaWing(l);
  }

  /** Um cliente da WING mudou este caminho. */
  wingEscreveu(caminho) {
    if (caminho === '/play/$action') {
      const acao = this.lerWing(caminho);
      if (acao === 'PLAY') this.aoTransporte('play');
      else if (acao === 'PAUSE') this.aoTransporte('pause');
      else if (acao === 'STOP') this.aoTransporte('stop');
      return;
    }

    // Trocou o modelo: os botoes do bloco agora sao outros. Os que a X32 tem
    // vem do estado atual — e nao dos valores de partida, que ligariam o gate
    // com threshold em 0 dB e calariam o canal.
    const m = /^(.*)\/mdl$/.exec(caminho);
    if (m) {
      for (const l of this.ligacoes) {
        if (l.bloco === m[1]) this.aplicarNaWing(l);
      }
    }
    for (const l of this.porWing.get(caminho) || []) this.aplicarNaX32(l);
  }

  /** O Mixing Station (ou o player) mudou este endereco da X32. */
  x32Escreveu(endereco) {
    for (const l of this.porX32.get(endereco) || []) this.aplicarNaWing(l, endereco);
  }
}

module.exports = { Ponte, dbParaFader, faderParaDb };
