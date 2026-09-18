'use strict';

// Leitura de WAV e AIFF do lado da mesa.
//
// Serve para cortar um pedaco do arquivo e entregar ao navegador como um WAV
// pequeno e completo. Assim o player nao precisa entender formato nenhum: pede
// "os 4 segundos a partir de 12 s" e passa o que chegou para o decodificador do
// proprio navegador.
//
// O motivo de existir esta em NOTAS-TECNICAS.md: um <audio> por faixa guarda a
// musica inteira desde o inicio, e com 18 stems de 24 bits o Chrome estoura o
// orcamento de memoria de midia e emudece metade das faixas.

const fs = require('fs');

// O cabecalho nao esta sempre no mesmo lugar: estes arquivos trazem um bloco
// JUNK de 92 bytes antes do 'fmt '. Por isso andamos bloco a bloco em vez de
// ler de posicao fixa.
const CABECALHO_MAX = 65536;

function lerCabecalho(caminho) {
  const fd = fs.openSync(caminho, 'r');
  try {
    const buf = Buffer.alloc(CABECALHO_MAX);
    const lidos = fs.readSync(fd, buf, 0, CABECALHO_MAX, 0);
    const tamanho = fs.fstatSync(fd).size;
    const cabeca = buf.subarray(0, lidos);
    if (cabeca.length < 12) return null;
    const marca = cabeca.toString('ascii', 0, 4);
    if (marca === 'RIFF' && cabeca.toString('ascii', 8, 12) === 'WAVE') return lerRiff(cabeca, tamanho);
    if (marca === 'FORM' && /AIF[FC]/.test(cabeca.toString('ascii', 8, 12))) return lerAiff(cabeca, tamanho);
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function lerRiff(c, tamanhoArquivo) {
  let p = 12;
  let fmt = null;
  let dados = null;
  while (p + 8 <= c.length) {
    const id = c.toString('ascii', p, p + 4);
    const n = c.readUInt32LE(p + 4);
    const corpo = p + 8;
    if (id === 'fmt ' && corpo + 16 <= c.length) {
      let codigo = c.readUInt16LE(corpo);
      const canais = c.readUInt16LE(corpo + 2);
      const taxa = c.readUInt32LE(corpo + 4);
      const bits = c.readUInt16LE(corpo + 14);
      // WAVE_FORMAT_EXTENSIBLE guarda o formato de verdade no fim do bloco.
      if (codigo === 0xfffe && corpo + 26 <= c.length) codigo = c.readUInt16LE(corpo + 24);
      fmt = { codigo, canais, taxa, bits };
    }
    if (id === 'data') {
      // Alguns arquivos declaram 0 ou 0xFFFFFFFF em 'data' e valem ate o fim.
      const real = n === 0 || n === 0xffffffff || corpo + n > tamanhoArquivo ? tamanhoArquivo - corpo : n;
      dados = { inicio: corpo, tamanho: real };
      break;
    }
    p = corpo + n + (n % 2);   // blocos RIFF sao alinhados em 2 bytes
  }
  if (!fmt || !dados) return null;
  if (fmt.codigo !== 1 && fmt.codigo !== 3) return null;   // so PCM e float
  return montar(fmt, dados, false);
}

function lerAiff(c, tamanhoArquivo) {
  let p = 12;
  let comm = null;
  let dados = null;
  while (p + 8 <= c.length) {
    const id = c.toString('ascii', p, p + 4);
    const n = c.readUInt32BE(p + 4);
    const corpo = p + 8;
    if (id === 'COMM' && corpo + 18 <= c.length) {
      comm = {
        codigo: 1,
        canais: c.readUInt16BE(corpo),
        bits: c.readUInt16BE(corpo + 6),
        taxa: Math.round(extendido80(c, corpo + 8)),
      };
    }
    if (id === 'SSND' && corpo + 8 <= c.length) {
      const desloca = c.readUInt32BE(corpo);
      const inicio = corpo + 8 + desloca;
      const declarado = n - 8 - desloca;
      dados = { inicio, tamanho: Math.min(declarado, tamanhoArquivo - inicio) };
      break;
    }
    p = corpo + n + (n % 2);
  }
  if (!comm || !dados || !comm.taxa) return null;
  return montar(comm, dados, true);
}

// A taxa de amostragem do AIFF e' um float de 80 bits (extended da Apple).
function extendido80(c, p) {
  const expoente = ((c[p] & 0x7f) << 8) | c[p + 1];
  let mantissa = 0;
  for (let i = 0; i < 8; i++) mantissa = mantissa * 256 + c[p + 2 + i];
  if (expoente === 0 && mantissa === 0) return 0;
  const valor = mantissa * Math.pow(2, expoente - 16383 - 63);
  return c[p] & 0x80 ? -valor : valor;
}

function montar(fmt, dados, bigEndian) {
  const bytesPorQuadro = (fmt.bits / 8) * fmt.canais;
  if (!bytesPorQuadro) return null;
  const quadros = Math.floor(dados.tamanho / bytesPorQuadro);
  return {
    codigo: fmt.codigo,
    canais: fmt.canais,
    taxa: fmt.taxa,
    bits: fmt.bits,
    bigEndian,
    inicio: dados.inicio,
    bytesPorQuadro,
    quadros,
    duracao: quadros / fmt.taxa,
  };
}

// Cabecalho de um WAV completo com `quadros` quadros do mesmo formato.
function cabecalhoWav(info, quadros) {
  const bytes = quadros * info.bytesPorQuadro;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + bytes, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(info.codigo, 20);
  h.writeUInt16LE(info.canais, 22);
  h.writeUInt32LE(info.taxa, 24);
  h.writeUInt32LE(info.taxa * info.bytesPorQuadro, 28);
  h.writeUInt16LE(info.bytesPorQuadro, 32);
  h.writeUInt16LE(info.bits, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(bytes, 40);
  return h;
}

// AIFF guarda as amostras ao contrario do WAV; invertemos quadro a quadro.
function inverterBytes(buf, bytesPorAmostra) {
  for (let i = 0; i + bytesPorAmostra <= buf.length; i += bytesPorAmostra) {
    for (let a = 0, b = bytesPorAmostra - 1; a < b; a++, b--) {
      const t = buf[i + a];
      buf[i + a] = buf[i + b];
      buf[i + b] = t;
    }
  }
  return buf;
}

module.exports = { lerCabecalho, cabecalhoWav, inverterBytes };
