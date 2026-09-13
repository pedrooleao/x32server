'use strict';

// Codec OSC 1.0 minimo, suficiente para o dialeto do X32.
// Tipos usados pelo X32: s (string), i (int32), f (float32), b (blob).

function padTo4(n) {
  return (4 - (n % 4)) % 4;
}

function encodeString(str) {
  const raw = Buffer.from(str, 'ascii');
  const nul = Buffer.alloc(1 + padTo4(raw.length + 1));
  return Buffer.concat([raw, nul]);
}

/**
 * @param {string} address ex: "/ch/01/mix/fader"
 * @param {Array<{type:'s'|'i'|'f'|'b', value:any}>} args
 */
function encode(address, args = []) {
  const parts = [encodeString(address)];
  const tags = ',' + args.map((a) => a.type).join('');
  parts.push(encodeString(tags));

  for (const arg of args) {
    if (arg.type === 's') {
      parts.push(encodeString(String(arg.value)));
    } else if (arg.type === 'i') {
      const b = Buffer.alloc(4);
      b.writeInt32BE(arg.value | 0, 0);
      parts.push(b);
    } else if (arg.type === 'f') {
      const b = Buffer.alloc(4);
      b.writeFloatBE(arg.value, 0);
      parts.push(b);
    } else if (arg.type === 'b') {
      const data = Buffer.isBuffer(arg.value) ? arg.value : Buffer.from(arg.value);
      const head = Buffer.alloc(4);
      head.writeInt32BE(data.length, 0);
      parts.push(head, data, Buffer.alloc(padTo4(data.length)));
    } else {
      throw new Error('Tipo OSC nao suportado: ' + arg.type);
    }
  }
  return Buffer.concat(parts);
}

function readString(buf, offset) {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  const value = buf.toString('ascii', offset, end);
  let next = end + 1;
  next += padTo4(next - offset === 0 ? 1 : next - offset) === 0 ? 0 : 0; // no-op, alinhamento abaixo
  next = offset + Math.ceil((end - offset + 1) / 4) * 4;
  return { value, next };
}

/**
 * @returns {{address:string, types:string, args:Array}|null}
 */
function decode(buf) {
  // O X32 responde ao /node com o endereco "node", sem barra inicial.
  if (!buf || buf.length < 4) return null;

  const addrRead = readString(buf, 0);
  const address = addrRead.value;
  let offset = addrRead.next;

  if (offset >= buf.length) {
    return { address, types: '', args: [] };
  }

  const tagRead = readString(buf, offset);
  offset = tagRead.next;
  const types = tagRead.value.startsWith(',') ? tagRead.value.slice(1) : '';

  const args = [];
  for (const t of types) {
    if (t === 's') {
      const r = readString(buf, offset);
      args.push(r.value);
      offset = r.next;
    } else if (t === 'i') {
      args.push(buf.readInt32BE(offset));
      offset += 4;
    } else if (t === 'f') {
      args.push(buf.readFloatBE(offset));
      offset += 4;
    } else if (t === 'b') {
      const len = buf.readInt32BE(offset);
      offset += 4;
      args.push(buf.subarray(offset, offset + len));
      offset += len + padTo4(len);
    } else {
      // Tipo desconhecido: para de ler para nao corromper o resto.
      break;
    }
  }

  return { address, types, args };
}

module.exports = { encode, decode };
