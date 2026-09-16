'use strict';

// Monta um .m4a a partir de quadros AAC crus.
//
// Por que nao ADTS: quadros ADTS bastam para tocar, mas o formato nao guarda a
// duracao — o player estima pela taxa de bits e erra. Uma musica de 90 s
// aparecia como 224 s, com a barra de tempo toda errada. O .m4a guarda a
// duracao de verdade.
//
// Um MP4 so de audio precisa de tres caixas no topo: ftyp, moov e mdat. O resto
// e' o aninhamento que a especificacao pede.

function caixa(tipo, ...partes) {
  const corpo = partes.flat().map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const tam = corpo.reduce((s, p) => s + p.length, 8);
  const saida = new Uint8Array(tam);
  new DataView(saida.buffer).setUint32(0, tam);
  saida.set(new TextEncoder().encode(tipo), 4);
  let o = 8;
  for (const p of corpo) { saida.set(p, o); o += p.length; }
  return saida;
}

const u8 = (...v) => new Uint8Array(v);
function u16(v) { const a = new Uint8Array(2); new DataView(a.buffer).setUint16(0, v); return a; }
function u32(v) { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, v); return a; }

// Descritores do esds levam o tamanho em forma estendida de 4 bytes.
function descritor(tag, conteudo) {
  const n = conteudo.length;
  return new Uint8Array([tag, 0x80, 0x80, 0x80, n, ...conteudo]);
}

function esds(configAudio, taxaBits) {
  const dsi = descritor(0x05, configAudio);                    // AudioSpecificConfig
  const dcd = descritor(0x06, [0x02]);                         // SLConfigDescriptor
  const dec = descritor(0x04, [
    0x40,                                                      // MPEG-4 Audio
    0x15,                                                      // fluxo de audio
    0x00, 0x00, 0x00,                                          // tamanho do buffer
    ...u32(taxaBits), ...u32(taxaBits),                        // taxa maxima e media
    ...dsi,
  ]);
  const es = descritor(0x03, [...u16(1), 0x00, ...dec, ...dcd]);
  return caixa('esds', u32(0), es);
}

/**
 * @param {Uint8Array[]} quadros  quadros AAC crus, sem cabecalho ADTS
 * @param {Uint8Array} configAudio  o AudioSpecificConfig que o codificador deu
 */
function montarM4a(quadros, configAudio, taxa, canais, taxaBits) {
  const POR_QUADRO = 1024;                 // AAC-LC: 1024 amostras por quadro
  const total = quadros.length * POR_QUADRO;
  const tamanhoMdat = quadros.reduce((s, q) => s + q.length, 0) + 8;

  const mp4a = caixa('mp4a',
    u8(0, 0, 0, 0, 0, 0), u16(1),          // reservado, indice da referencia
    u16(0), u16(0), u32(0),                // versao, revisao, fabricante
    u16(canais), u16(16),                  // canais, bits por amostra
    u16(0), u16(0),
    u32(taxa << 16 >>> 0),                 // taxa em 16.16
    esds(configAudio, taxaBits)
  );

  const stbl = caixa('stbl',
    caixa('stsd', u32(0), u32(1), mp4a),
    caixa('stts', u32(0), u32(1), u32(quadros.length), u32(POR_QUADRO)),
    caixa('stsc', u32(0), u32(1), u32(1), u32(quadros.length), u32(1)),
    caixa('stsz', u32(0), u32(0), u32(quadros.length), ...quadros.map((q) => u32(q.length))),
    caixa('stco', u32(0), u32(1), u32(0))  // corrigido depois, quando se sabe o offset
  );

  const mdia = caixa('mdia',
    caixa('mdhd', u32(0), u32(0), u32(0), u32(taxa), u32(total), u16(0x55c4), u16(0)),
    caixa('hdlr', u32(0), u32(0), new TextEncoder().encode('soun'), u32(0), u32(0), u32(0), u8(0)),
    caixa('minf',
      caixa('smhd', u32(0), u16(0), u16(0)),
      caixa('dinf', caixa('dref', u32(0), u32(1), caixa('url ', u32(1)))),
      stbl
    )
  );

  const segundos = Math.round((total / taxa) * 1000);
  const trak = caixa('trak',
    caixa('tkhd', u8(0, 0, 0, 7), u32(0), u32(0), u32(1), u32(0), u32(segundos), u32(0), u32(0),
      u16(0), u16(0), u16(0x0100), u16(0),
      ...[0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32),
      u32(0), u32(0)),
    mdia
  );

  const moov = caixa('moov',
    caixa('mvhd', u32(0), u32(0), u32(0), u32(1000), u32(segundos), u32(0x00010000),
      u16(0x0100), u16(0), u32(0), u32(0),
      ...[0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32),
      ...new Array(6).fill(u32(0)), u32(2)),
    trak
  );

  const ftyp = caixa('ftyp',
    new TextEncoder().encode('M4A '), u32(512),
    new TextEncoder().encode('M4A isomiso2')
  );

  // Agora da' para saber onde o audio comeca e corrigir o stco.
  const inicioMdat = ftyp.length + moov.length + 8;
  const posStco = acharStco(moov);
  new DataView(moov.buffer, moov.byteOffset).setUint32(posStco, inicioMdat);

  const mdat = new Uint8Array(tamanhoMdat);
  new DataView(mdat.buffer).setUint32(0, tamanhoMdat);
  mdat.set(new TextEncoder().encode('mdat'), 4);
  let o = 8;
  for (const q of quadros) { mdat.set(q, o); o += q.length; }

  return new Blob([ftyp, moov, mdat], { type: 'audio/mp4' });
}

// O stco fica no fim do moov; achamos pela assinatura para nao recalcular todos
// os tamanhos das caixas aninhadas.
function acharStco(moov) {
  const alvo = [0x73, 0x74, 0x63, 0x6f];   // "stco"
  for (let i = moov.length - 16; i >= 0; i--) {
    if (moov[i] === alvo[0] && moov[i+1] === alvo[1] && moov[i+2] === alvo[2] && moov[i+3] === alvo[3]) {
      return i + 12;                        // tipo + versao/flags + contagem
    }
  }
  throw new Error('stco nao encontrado');
}

window.montarM4a = montarM4a;
