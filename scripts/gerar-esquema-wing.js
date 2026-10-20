'use strict';

// Gera wing/esquema.bin.gz a partir do mapa de propriedades do libwing.
//
// A WING nao fala por nome: o protocolo nativo so conhece o numero (hash) de
// cada parametro, e o WING Edit ja vem com esses numeros dentro. Para responder
// a ele precisamos da arvore inteira da mesa — mais de 60 mil nos, com id, pai,
// tipo, faixa e lista de opcoes. Ninguem escreve isso a mao: o libwing
// (github.com/dannydulai/libwing, licenca Apache 2.0) leu a arvore de uma WING
// Compact de verdade, firmware 3.0.5, e a guardou em src/propmap.rs.
//
// O arquivo de la e' um literal de bytes do Rust. Cada registro:
//   u8   indice do modelo (0 = no' fixo; N = N-esimo filho de um "mdl")
//   u16  tamanho do caminho, caminho
//   u16  tamanho da definicao, definicao crua (exatamente o que a mesa manda)
// Guardamos os mesmos bytes, so tirando do Rust e comprimindo.
//
//   git clone --depth 1 https://github.com/dannydulai/libwing /tmp/libwing
//   node scripts/gerar-esquema-wing.js /tmp/libwing/src/propmap.rs

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const origem = process.argv[2];
if (!origem) {
  console.error('Uso: node scripts/gerar-esquema-wing.js <libwing>/src/propmap.rs');
  process.exit(1);
}

const fonte = fs.readFileSync(origem, 'latin1');
const ini = fonte.indexOf('let d = b"');
if (ini < 0) {
  console.error('Nao achei o literal de bytes no propmap.rs');
  process.exit(1);
}
const fim = fonte.indexOf('";', ini);
const literal = fonte.slice(ini + 'let d = b"'.length, fim);

// So aparecem escapes \xNN no literal gerado pelo wingschema.
const bytes = Buffer.alloc(literal.length / 4);
for (let i = 0, j = 0; i < literal.length; i += 4, j++) {
  bytes[j] = parseInt(literal.slice(i + 2, i + 4), 16);
}

// Confere a estrutura antes de gravar: um arquivo truncado aqui viraria uma
// mesa que responde metade da arvore, e isso so apareceria no WING Edit.
let n = 0;
for (let i = 0; i < bytes.length; n++) {
  i += 1;
  const tn = bytes.readUInt16BE(i);
  i += 2 + tn;
  const td = bytes.readUInt16BE(i);
  i += 2 + td;
  if (i > bytes.length) {
    console.error(`Registro ${n} passa do fim do arquivo`);
    process.exit(1);
  }
}

const destino = path.join(__dirname, '..', 'wing', 'esquema.bin.gz');
fs.writeFileSync(destino, zlib.gzipSync(bytes, { level: 9 }));
console.log(`${n} nos, ${bytes.length} bytes -> ${destino}`);
