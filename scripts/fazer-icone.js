'use strict';

// Desenha o icone do app e monta o .icns. Sem dependencia: escreve o PNG na mao
// (zlib do proprio Node) e usa sips/iconutil, que ja vem no macOS.
// Motivo: uma tira de canal com medidor, nas cores da propria interface.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const N = 1024;
const FUNDO = [0x1c, 0x1f, 0x25];
const TRILHO = [0x2b, 0x30, 0x38];
const SINAL = [0xe8, 0xa3, 0x3d];
const CLARO = [0xe6, 0xe9, 0xee];

const px = Buffer.alloc(N * N * 4); // RGBA

function ponto(x, y, cor, alpha = 1) {
  if (x < 0 || y < 0 || x >= N || y >= N) return;
  const i = (y * N + x) * 4;
  for (let c = 0; c < 3; c++) {
    px[i + c] = Math.round(px[i + c] * (1 - alpha) + cor[c] * alpha);
  }
  px[i + 3] = Math.max(px[i + 3], Math.round(255 * alpha));
}

function retangulo(x0, y0, w, h, cor, raio = 0) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (raio > 0) {
        const dx = Math.max(x0 + raio - x, x - (x0 + w - 1 - raio), 0);
        const dy = Math.max(y0 + raio - y, y - (y0 + h - 1 - raio), 0);
        const d = Math.hypot(dx, dy);
        if (d > raio) continue;
        if (d > raio - 1.5) { ponto(x, y, cor, raio - d > 0 ? (raio - d) / 1.5 : 0); continue; }
      }
      ponto(x, y, cor);
    }
  }
}

// Fundo arredondado, no estilo dos icones do macOS
retangulo(0, 0, N, N, FUNDO, 225);

// Quatro tiras de canal com medidores de alturas diferentes
const larguraTira = 92;
const vao = 62;
const total = larguraTira * 4 + vao * 3;
const esq = Math.round((N - total) / 2);
const topo = 250;
const alturaTrilho = 470;
const alturas = [0.82, 0.45, 0.66, 0.30];

alturas.forEach((frac, i) => {
  const x = esq + i * (larguraTira + vao);
  retangulo(x, topo, larguraTira, alturaTrilho, TRILHO, larguraTira / 2);
  const h = Math.round(alturaTrilho * frac);
  retangulo(x, topo + alturaTrilho - h, larguraTira, h, SINAL, larguraTira / 2);
});

// Marca do fader atravessando as tiras, na altura do "0 dB"
const yFader = topo + Math.round(alturaTrilho * 0.42);
retangulo(esq - 34, yFader, total + 68, 16, CLARO, 8);

// --- PNG -------------------------------------------------------------------
let tabela = null;
function crc32(buf) {
  if (!tabela) {
    tabela = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      tabela[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = tabela[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(tipo, dados) {
  const tam = Buffer.alloc(4);
  tam.writeUInt32BE(dados.length, 0);
  const corpo = Buffer.concat([Buffer.from(tipo, 'ascii'), dados]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo), 0);
  return Buffer.concat([tam, corpo, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8;   // bits por canal
ihdr[9] = 6;   // RGBA
const linhas = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) {
  linhas[y * (N * 4 + 1)] = 0; // sem filtro
  px.copy(linhas, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(linhas, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const raiz = path.join(__dirname, '..');
const base = path.join(raiz, 'build');
fs.mkdirSync(base, { recursive: true });
const origem = path.join(base, 'icone-1024.png');
fs.writeFileSync(origem, png);

// .iconset com todos os tamanhos que o macOS espera, e depois o .icns
const iconset = path.join(base, 'icone.iconset');
fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset);
for (const tam of [16, 32, 64, 128, 256, 512, 1024]) {
  const nomes = [`icon_${tam}x${tam}.png`];
  if (tam >= 32) nomes.push(`icon_${tam / 2}x${tam / 2}@2x.png`);
  for (const nome of nomes) {
    execFileSync('sips', ['-z', String(tam), String(tam), origem, '--out', path.join(iconset, nome)], {
      stdio: 'ignore',
    });
  }
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(base, 'icon.icns')]);
console.log('icone pronto: build/icon.icns');

// --- .ico para o Windows ----------------------------------------------------
// O .icns nao serve la. O formato ICO aceita PNG embutido desde o Vista, entao
// e' so um cabecalho, uma entrada por tamanho e os PNGs colados em seguida.
const tamanhosIco = [16, 32, 48, 64, 128, 256];
const pngs = tamanhosIco.map((t) => {
  const arq = path.join(base, `ico-${t}.png`);
  execFileSync('sips', ['-z', String(t), String(t), origem, '--out', arq], { stdio: 'ignore' });
  return fs.readFileSync(arq);
});

const cabecalho = Buffer.alloc(6);
cabecalho.writeUInt16LE(0, 0);                    // reservado
cabecalho.writeUInt16LE(1, 2);                    // 1 = icone
cabecalho.writeUInt16LE(tamanhosIco.length, 4);

const entradas = Buffer.alloc(16 * tamanhosIco.length);
let deslocamento = cabecalho.length + entradas.length;
tamanhosIco.forEach((t, i) => {
  const o = i * 16;
  entradas[o] = t >= 256 ? 0 : t;                 // 0 quer dizer 256
  entradas[o + 1] = t >= 256 ? 0 : t;
  entradas[o + 2] = 0;                            // cores da paleta
  entradas[o + 3] = 0;                            // reservado
  entradas.writeUInt16LE(1, o + 4);               // planos
  entradas.writeUInt16LE(32, o + 6);              // bits por pixel
  entradas.writeUInt32LE(pngs[i].length, o + 8);
  entradas.writeUInt32LE(deslocamento, o + 12);
  deslocamento += pngs[i].length;
});

fs.writeFileSync(path.join(base, 'icon.ico'), Buffer.concat([cabecalho, entradas, ...pngs]));
for (const t of tamanhosIco) fs.unlinkSync(path.join(base, `ico-${t}.png`));
console.log('icone do Windows pronto: build/icon.ico');
