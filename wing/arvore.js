'use strict';

// A arvore de parametros de uma WING, com os valores atuais.
//
// Na WING tudo e' um no' de uma arvore unica: /ch/1/fdr, /ch/1/eq/1g,
// /$syscfg/$firmware... Cada no' tem um numero de 32 bits (o "hash"), e e' so
// por esse numero que o protocolo nativo conversa. O esquema vem do libwing,
// lido de uma mesa real — ver scripts/gerar-esquema-wing.js.
//
// O que complica: parte da arvore muda conforme o MODELO escolhido. O gate do
// canal pode ser GATE, DUCK, E88...; cada um tem botoes diferentes. Eles ocupam
// os mesmos "encaixes" — o encaixe 1 do gate tem o mesmo id no GATE (thr) e no
// WAVE (att) — e so o modelo atual diz o que o encaixe e'. Por isso o valor e'
// guardado pelo id, e a definicao de cada encaixe vem do modelo atual.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TIPO = {
  NO: 0,
  LINEAR: 1,
  LOG: 2,
  FADER: 3,
  INTEIRO: 4,
  ENUM: 5,
  ENUM_FLOAT: 6,
  TEXTO: 7,
};

// O fader da WING nao traz faixa na definicao: e' sempre -144 (-oo) a +10 dB.
const FADER_MIN = -144;
const FADER_MAX = 10;

function lerDefinicao(cru) {
  let o = 0;
  const pai = cru.readInt32BE(o); o += 4;
  const id = cru.readInt32BE(o); o += 4;
  const indice = cru.readUInt16BE(o); o += 2;
  let n = cru[o++];
  const nome = cru.toString('utf8', o, o + n); o += n;
  n = cru[o++];
  const longo = cru.toString('utf8', o, o + n); o += n;
  const flags = cru.readUInt16BE(o); o += 2;
  const def = {
    pai, id, indice, nome, longo,
    tipo: (flags >> 4) & 0x0f,
    unidade: flags & 0x0f,
    soLeitura: (flags & 0x200) !== 0,
    cru,
  };
  switch (def.tipo) {
    case TIPO.LINEAR:
    case TIPO.LOG:
      def.min = cru.readFloatBE(o);
      def.max = cru.readFloatBE(o + 4);
      def.passos = cru.readInt32BE(o + 8);
      break;
    case TIPO.FADER:
      def.min = FADER_MIN;
      def.max = FADER_MAX;
      break;
    case TIPO.INTEIRO:
      def.min = cru.readInt32BE(o);
      def.max = cru.readInt32BE(o + 4);
      break;
    case TIPO.TEXTO:
      def.maxTexto = cru.readUInt16BE(o);
      break;
    case TIPO.ENUM: {
      const qtd = cru.readUInt16BE(o); o += 2;
      def.itens = [];
      for (let i = 0; i < qtd; i++) {
        n = cru[o++];
        const item = cru.toString('utf8', o, o + n); o += n;
        n = cru[o++];
        o += n;   // nome longo da opcao: so a tela usa
        def.itens.push(item);
      }
      break;
    }
    case TIPO.ENUM_FLOAT: {
      const qtd = cru.readUInt16BE(o); o += 2;
      def.itens = [];
      for (let i = 0; i < qtd; i++) {
        def.itens.push(cru.readFloatBE(o));
        o += 4;
        n = cru[o++];
        o += n;
      }
      break;
    }
    default:
      break;
  }
  return def;
}

function eFloat(def) {
  return def.tipo === TIPO.LINEAR || def.tipo === TIPO.LOG || def.tipo === TIPO.FADER || def.tipo === TIPO.ENUM_FLOAT;
}

function eTexto(def) {
  return def.tipo === TIPO.TEXTO || def.tipo === TIPO.ENUM;
}

function limitar(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/** Valor de partida de um parametro que ninguem ajustou ainda. */
function valorInicial(def) {
  switch (def.tipo) {
    case TIPO.LINEAR:
    case TIPO.LOG:
      return def.min <= 0 && def.max >= 0 ? 0 : def.min;
    // Envio e retorno sem nada: -oo. Fader de canal, bus e main: 0 dB, que e'
    // o que um operador espera achar numa mesa recem ligada.
    case TIPO.FADER:
      return def.nome === 'fdr' ? 0 : FADER_MIN;
    case TIPO.INTEIRO:
      return limitar(0, def.min, def.max);
    case TIPO.ENUM:
      return def.itens.length ? def.itens[0] : '';
    case TIPO.ENUM_FLOAT:
      return def.itens.length ? def.itens[0] : 0;
    case TIPO.TEXTO:
      return '';
    default:
      return null;
  }
}

/**
 * Converte o que chegou do cliente no valor que o parametro aceita.
 * Devolve undefined quando nao da para aproveitar (opcao que nao existe).
 */
function normalizarValor(def, v) {
  switch (def.tipo) {
    case TIPO.LINEAR:
    case TIPO.LOG:
    case TIPO.FADER: {
      const n = typeof v === 'string' ? parseFloat(v) : Number(v);
      if (!isFinite(n)) return def.tipo === TIPO.FADER && /-oo/.test(String(v)) ? FADER_MIN : undefined;
      return limitar(n, def.min, def.max);
    }
    case TIPO.INTEIRO: {
      let n;
      if (typeof v === 'string') {
        if (/^(on|yes)$/i.test(v)) n = 1;
        else if (/^(off|no)$/i.test(v)) n = 0;
        else n = parseInt(v, 10);
      } else n = Number(v);
      if (!isFinite(n)) return undefined;
      return limitar(Math.round(n), def.min, def.max);
    }
    case TIPO.ENUM: {
      // Pela opcao, que e' como a mesa manda; pelo indice, se vier numero.
      if (typeof v === 'number') return def.itens[Math.round(v)];
      const s = String(v);
      if (def.itens.includes(s)) return s;
      const achado = def.itens.find((it) => it.toLowerCase() === s.toLowerCase());
      return achado;
    }
    case TIPO.ENUM_FLOAT: {
      const n = Number(v);
      if (!isFinite(n) || !def.itens.length) return undefined;
      let melhor = def.itens[0];
      for (const it of def.itens) if (Math.abs(it - n) < Math.abs(melhor - n)) melhor = it;
      return melhor;
    }
    case TIPO.TEXTO:
      return String(v).slice(0, def.maxTexto || 256);
    default:
      return undefined;
  }
}

// Valor "cru" (0..1, a posicao do botao) <-> valor real. O protocolo nativo
// tem um token so para isso, e o OSC devolve os dois juntos.
//
// A curva do fader da WING nao esta no esquema; usamos a da X32 — que tambem
// poe o 0 dB em 3/4 do curso — com -oo no fundo.
function faderParaCru(db) {
  if (db <= -90) return 0;
  if (db < -60) return (db + 90) / 480;
  if (db < -30) return (db + 70) / 160;
  if (db < -10) return (db + 50) / 80;
  return limitar((db + 30) / 40, 0, 1);
}

function cruParaFader(f) {
  if (f <= 0) return FADER_MIN;
  if (f < 0.0625) return f * 480 - 90;
  if (f < 0.25) return f * 160 - 70;
  if (f < 0.5) return f * 80 - 50;
  return Math.min(FADER_MAX, f * 40 - 30);
}

function paraCru(def, v) {
  switch (def.tipo) {
    case TIPO.LINEAR:
      return def.max === def.min ? 0 : (v - def.min) / (def.max - def.min);
    case TIPO.LOG:
      return def.min > 0 && def.max > def.min ? Math.log(v / def.min) / Math.log(def.max / def.min) : 0;
    case TIPO.FADER:
      return faderParaCru(v);
    case TIPO.INTEIRO:
      return def.max === def.min ? 0 : (v - def.min) / (def.max - def.min);
    case TIPO.ENUM:
    case TIPO.ENUM_FLOAT: {
      const i = def.itens.indexOf(v);
      return def.itens.length > 1 ? Math.max(0, i) / (def.itens.length - 1) : 0;
    }
    default:
      return 0;
  }
}

function deCru(def, r) {
  const x = limitar(Number(r) || 0, 0, 1);
  switch (def.tipo) {
    case TIPO.LINEAR:
      return def.min + x * (def.max - def.min);
    case TIPO.LOG:
      return def.min * Math.pow(def.max / def.min, x);
    case TIPO.FADER:
      return cruParaFader(x);
    case TIPO.INTEIRO:
      return Math.round(def.min + x * (def.max - def.min));
    case TIPO.ENUM:
    case TIPO.ENUM_FLOAT:
      return def.itens[Math.round(x * (def.itens.length - 1))];
    default:
      return undefined;
  }
}

/** Texto do valor, como a mesa mostra: "-oo", "0.0", "ON"... */
function textoDoValor(def, v) {
  if (v === null || v === undefined) return '';
  if (def.tipo === TIPO.FADER && v <= FADER_MIN) return '-oo';
  if (eFloat(def)) {
    const n = Number(v);
    return Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1);
  }
  return String(v);
}

class ArvoreWing {
  constructor(arquivo = path.join(__dirname, 'esquema.bin.gz')) {
    this.raiz = { id: 0, def: null, caminho: '', logico: '', filhos: [], pai: null };
    this.porCaminho = new Map();    // caminho do esquema (com o modelo) -> no'
    this.porLogico = new Map();     // caminho sem o modelo -> [nos]
    this.porId = new Map();         // id -> [nos] (encaixes repetem id)
    this.valores = new Map();       // id -> valor atual
    this.porCaminho.set('', this.raiz);
    this.carregar(zlib.gunzipSync(fs.readFileSync(arquivo)));
    this.iniciarValores(this.raiz);
  }

  carregar(bytes) {
    for (let i = 0; i < bytes.length;) {
      const encaixe = bytes[i];
      i += 1;
      const tn = bytes.readUInt16BE(i);
      const caminho = bytes.toString('utf8', i + 2, i + 2 + tn);
      i += 2 + tn;
      const td = bytes.readUInt16BE(i);
      const def = lerDefinicao(bytes.subarray(i + 2, i + 2 + td));
      i += 2 + td;

      const partes = caminho.split('/');
      const no = { id: def.id, def, caminho, filhos: [] };
      let pai;
      if (encaixe) {
        // /ch/1/gate/GATE/thr: o pai e' /ch/1/gate e o modelo, GATE.
        const modelo = partes[partes.length - 2];
        pai = this.porCaminho.get(partes.slice(0, -2).join('/'));
        if (!pai) continue;
        if (!pai.modelos) pai.modelos = new Map();
        if (!pai.modelos.has(modelo)) pai.modelos.set(modelo, []);
        pai.modelos.get(modelo).push(no);
        no.modelo = modelo;
      } else {
        pai = this.porCaminho.get(partes.slice(0, -1).join('/'));
        if (!pai) continue;
        pai.filhos.push(no);
        if (def.nome === 'mdl' && def.tipo === TIPO.ENUM) pai.noModelo = no;
      }
      no.pai = pai;
      // O nome de um no' numerado (/ch/1) e' vazio: vale o indice.
      no.logico = `${pai.logico}/${def.nome || def.indice}`;
      this.porCaminho.set(caminho, no);
      if (!this.porLogico.has(no.logico)) this.porLogico.set(no.logico, []);
      this.porLogico.get(no.logico).push(no);
      if (!this.porId.has(no.id)) this.porId.set(no.id, []);
      this.porId.get(no.id).push(no);
    }
  }

  /** Modelo atual de um no' que tem "mdl", ou null. */
  modeloDe(no) {
    if (!no.noModelo) return null;
    return this.valores.get(no.noModelo.id);
  }

  /** Filhos que existem agora: os fixos e os do modelo escolhido. */
  filhosDe(no) {
    if (!no.modelos) return no.filhos;
    const doModelo = no.modelos.get(this.modeloDe(no)) || [];
    return no.filhos.concat(doModelo);
  }

  /** O no' existe no estado atual da mesa? (encaixe de outro modelo nao) */
  ativo(no) {
    for (let n = no; n && n.pai; n = n.pai) {
      if (n.modelo && this.modeloDe(n.pai) !== n.modelo) return false;
    }
    return true;
  }

  noPorId(id) {
    if (id === 0) return this.raiz;
    const lista = this.porId.get(id);
    if (!lista) return null;
    return lista.find((n) => this.ativo(n)) || null;
  }

  /** /ch/1/gate/thr, sem o nome do modelo — o caminho que o OSC da WING usa. */
  noPorLogico(caminho) {
    if (caminho === '' || caminho === '/') return this.raiz;
    const lista = this.porLogico.get(caminho);
    if (!lista) return null;
    return lista.find((n) => this.ativo(n)) || null;
  }

  filhoPorIndice(no, indice) {
    const filhos = this.filhosDe(no);
    return filhos.find((f) => f.def.indice === indice) || filhos[indice - 1] || null;
  }

  filhoPorNome(no, nome) {
    return this.filhosDe(no).find((f) => f.def.nome === nome) || null;
  }

  // Os fixos primeiro: o "mdl" e' um deles, e sem ele nao se sabe quais
  // encaixes existem. Encaixe de modelo sempre recomeca do valor inicial.
  iniciarValores(no, forcar = false) {
    for (const f of no.filhos) {
      if (f.def.tipo !== TIPO.NO && (forcar || !this.valores.has(f.id))) {
        this.valores.set(f.id, valorInicial(f.def));
      }
    }
    for (const f of this.filhosDe(no)) {
      if (f.def.tipo === TIPO.NO) this.iniciarValores(f, forcar || !!f.modelo);
      else if (f.modelo) this.valores.set(f.id, valorInicial(f.def));
    }
  }

  valor(no) {
    return this.valores.get(no.id);
  }

  /**
   * Grava um valor ja convertido para o tipo do no'. Devolve a lista de nos que
   * mudaram — trocar o modelo muda todos os encaixes daquele bloco.
   */
  gravar(no, valor) {
    const antes = this.valores.get(no.id);
    if (antes === valor) return [];
    this.valores.set(no.id, valor);
    const mudados = [no];
    // Modelo novo: os encaixes passam a ser outros botoes, com outras faixas.
    // Comecam do valor inicial, como na troca de modelo na mesa.
    if (no.def.nome === 'mdl' && no.pai.noModelo === no && no.pai.modelos) {
      for (const f of no.pai.modelos.get(valor) || []) {
        if (f.def.tipo === TIPO.NO) {
          this.iniciarValores(f, true);
          mudados.push(...this.folhas(f));
        } else {
          this.valores.set(f.id, valorInicial(f.def));
          mudados.push(f);
        }
      }
    }
    return mudados;
  }

  /** Todas as folhas abaixo de um no', na ordem da arvore. */
  folhas(no, lista = []) {
    for (const f of this.filhosDe(no)) {
      if (f.def.tipo === TIPO.NO) this.folhas(f, lista);
      else lista.push(f);
    }
    return lista;
  }
}

module.exports = {
  ArvoreWing,
  TIPO,
  FADER_MIN,
  FADER_MAX,
  normalizarValor,
  paraCru,
  deCru,
  textoDoValor,
  eFloat,
  eTexto,
};
