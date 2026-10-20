'use strict';

// Protocolo nativo da WING, o que o WING Edit fala na porta TCP 2222.
//
// E' um fluxo de bytes com varios "canais" misturados. O byte 0xDF e' o escape:
//   DF D0..DD  troca o canal (D1 = dados da mesa, D3 = medidores)
//   DF DE      um 0xDF de verdade, dentro dos dados
// Dentro do canal, cada token comeca por um byte que diz o que vem:
//   00..3F  inteiro pequeno (o proprio byte)     D3  inteiro 16 bits
//   40..7F  vai para o filho de indice 1..64      D4  inteiro 32 bits
//   80..BF  texto de 1..64 bytes                  D5  float 32 bits
//   C0..CF  vai para o filho de nome 1..16 bytes  D6  float cru (0..1)
//   D0      texto vazio                           D7  vai para o no' de id N
//   D1      texto com tamanho no byte seguinte    D8  clique (alterna)
//   D2      vai para o filho de indice (16 bits)  D9  passo (+/- N)
//   DA  vai para a raiz   DB  sobe um nivel   DC  pede os valores
//   DD  pede as definicoes   DE  fim da resposta   DF  definicao de um no'
// Tudo em big-endian. Fontes: o libwing (que e' cliente) e a documentacao da
// Behringer ("WING Remote Protocols", Patrick-Gilles Maillot).

const ESC = 0xdf;

/**
 * Le o fluxo que chega de um cliente e entrega os tokens ja separados por
 * canal. Os pedacos do TCP podem cortar um token ao meio: o que sobra fica
 * guardado ate o resto chegar.
 */
class Leitor {
  constructor(aoToken) {
    this.aoToken = aoToken;     // (canal, token) => void
    this.esc = false;
    // Sem troca de canal, o que chega vale como dados da mesa: o libwing manda
    // DF D1 logo de cara, mas nao custa aceitar quem nao manda.
    this.canal = 1;
    this.pendente = new Map();  // canal -> bytes ainda sem token completo
  }

  receber(pedaco) {
    const porCanal = new Map();
    const guardar = (b) => {
      if (!porCanal.has(this.canal)) porCanal.set(this.canal, []);
      porCanal.get(this.canal).push(b);
    };
    for (const b of pedaco) {
      if (!this.esc) {
        if (b === ESC) this.esc = true;
        else guardar(b);
        continue;
      }
      this.esc = false;
      if (b === 0xde || b === ESC) guardar(ESC);
      else if (b >= 0xd0 && b <= 0xdd) {
        // Antes de trocar, fecha o que ja veio no canal antigo.
        this.processar(porCanal);
        porCanal.clear();
        this.canal = b - 0xd0;
      } else {
        guardar(ESC);
        guardar(b);
      }
    }
    this.processar(porCanal);
  }

  processar(porCanal) {
    for (const [canal, bytes] of porCanal) {
      const antes = this.pendente.get(canal);
      const buf = antes ? antes.concat(bytes) : bytes;
      let i = 0;
      const medidor = canal === 3;
      while (i < buf.length) {
        const n = medidor ? tamanhoMedidor(buf, i) : tamanhoDados(buf, i);
        if (n < 0 || i + n > buf.length) break;
        this.aoToken(canal, lerToken(buf, i, n, medidor));
        i += n;
      }
      this.pendente.set(canal, buf.slice(i));
    }
  }
}

function tamanhoDados(buf, i) {
  const c = buf[i];
  if (c <= 0x7f) return 1;
  if (c <= 0xbf) return 1 + (c - 0x80 + 1);
  if (c <= 0xcf) return 1 + (c - 0xc0 + 1);
  switch (c) {
    case 0xd1: return i + 1 < buf.length ? 2 + buf[i + 1] + 1 : -1;
    case 0xd2: case 0xd3: return 3;
    case 0xd4: case 0xd5: case 0xd6: case 0xd7: return 5;
    case 0xd9: return 2;
    default: return 1;
  }
}

// No canal dos medidores o D3 traz a porta UDP, o D4 o numero da inscricao,
// DC..DE a lista do que medir. Cada tipo de medidor leva um byte de indice,
// menos o monitor (A9) e o RTA (AA).
function tamanhoMedidor(buf, i) {
  const c = buf[i];
  if (c === 0xd3) return 3;
  if (c === 0xd4) return 5;
  if (c >= 0xa0 && c <= 0xaf && c !== 0xa9 && c !== 0xaa) return 2;
  return 1;
}

function lerToken(buf, i, n, medidor) {
  const c = buf[i];
  const b = Buffer.from(buf.slice(i + 1, i + n));
  if (medidor) {
    if (c === 0xd3) return { tipo: 'porta', valor: b.readUInt16BE(0) };
    if (c === 0xd4) return { tipo: 'inscricao', valor: b.readUInt32BE(0) };
    if (c === 0xdc) return { tipo: 'inicio' };
    if (c === 0xde) return { tipo: 'fim' };
    if (c >= 0xa0 && c <= 0xaf) return { tipo: 'medidor', codigo: c, indice: n > 1 ? b[0] : 0 };
    return { tipo: 'desconhecido', codigo: c };
  }
  if (c <= 0x3f) return { tipo: 'valor', valor: c, forma: 'int' };
  if (c <= 0x7f) return { tipo: 'indice', valor: c - 0x40 + 1 };
  if (c <= 0xbf) return { tipo: 'valor', valor: b.toString('utf8'), forma: 'texto' };
  if (c <= 0xcf) return { tipo: 'nome', valor: b.toString('utf8') };
  switch (c) {
    case 0xd0: return { tipo: 'valor', valor: '', forma: 'texto' };
    case 0xd1: return { tipo: 'valor', valor: b.subarray(1).toString('utf8'), forma: 'texto' };
    case 0xd2: return { tipo: 'indice', valor: b.readUInt16BE(0) + 1 };
    case 0xd3: return { tipo: 'valor', valor: b.readInt16BE(0), forma: 'int' };
    case 0xd4: return { tipo: 'valor', valor: b.readInt32BE(0), forma: 'int' };
    case 0xd5: return { tipo: 'valor', valor: b.readFloatBE(0), forma: 'float' };
    case 0xd6: return { tipo: 'valor', valor: b.readFloatBE(0), forma: 'cru' };
    case 0xd7: return { tipo: 'id', valor: b.readInt32BE(0) };
    case 0xd8: return { tipo: 'clique' };
    case 0xd9: return { tipo: 'passo', valor: b.readInt8(0) };
    case 0xda: return { tipo: 'raiz' };
    case 0xdb: return { tipo: 'sobe' };
    case 0xdc: return { tipo: 'pedeDados' };
    case 0xdd: return { tipo: 'pedeDefinicao' };
    case 0xde: return { tipo: 'fim' };
    default: return { tipo: 'desconhecido', codigo: c };
  }
}

/**
 * Monta o que a mesa manda. Guarda o canal atual do fluxo de saida para so
 * mandar a troca (DF Dx) quando o canal mudar.
 */
class Escritor {
  constructor() {
    this.canal = -1;
    this.bytes = [];
  }

  canalDe(canal) {
    if (this.canal !== canal) {
      this.bytes.push(ESC, 0xd0 + canal);
      this.canal = canal;
    }
  }

  dados(canal, lista) {
    this.canalDe(canal);
    for (const b of lista) {
      this.bytes.push(b);
      if (b === ESC) this.bytes.push(0xde);
    }
  }

  tirar() {
    const b = Buffer.from(this.bytes);
    this.bytes = [];
    return b;
  }
}

function bytesDe(buf) {
  return Array.from(buf);
}

function tokenId(id) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(id | 0, 0);
  return [0xd7, ...bytesDe(b)];
}

function tokenInteiro(v) {
  if (v >= 0 && v <= 0x3f) return [v];
  if (v >= -32768 && v <= 32767) {
    const b = Buffer.alloc(2);
    b.writeInt16BE(v, 0);
    return [0xd3, ...bytesDe(b)];
  }
  const b = Buffer.alloc(4);
  b.writeInt32BE(v | 0, 0);
  return [0xd4, ...bytesDe(b)];
}

function tokenFloat(v) {
  const b = Buffer.alloc(4);
  b.writeFloatBE(v, 0);
  return [0xd5, ...bytesDe(b)];
}

function tokenTexto(s) {
  let b = Buffer.from(String(s), 'utf8');
  if (b.length > 256) b = b.subarray(0, 256);
  if (b.length === 0) return [0xd0];
  if (b.length <= 64) return [0x80 + b.length - 1, ...bytesDe(b)];
  return [0xd1, b.length - 1, ...bytesDe(b)];
}

/** Definicao de um no': DF, tamanho em 16 bits, os bytes que a mesa guarda. */
function tokenDefinicao(cru) {
  return [ESC, (cru.length >> 8) & 0xff, cru.length & 0xff, ...bytesDe(cru)];
}

const FIM = [0xde];

module.exports = {
  Leitor,
  Escritor,
  tokenId,
  tokenInteiro,
  tokenFloat,
  tokenTexto,
  tokenDefinicao,
  FIM,
};
