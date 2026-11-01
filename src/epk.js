'use strict';
// Reader for EaglercraftX "EAGPKG$$ ver2" resource packages (port of teavm EPKLoader).
const zlib = require('node:zlib');

function readEPK(buf, wanted) {
  if (buf.subarray(0, 8).toString('latin1') !== 'EAGPKG$$') throw new Error('not an EPK');
  if (buf.subarray(buf.length - 8).toString('latin1') !== ':::YEE:>') throw new Error('EPK missing EOF code');
  let o = 8;
  const a8 = (b, p) => { const n = b[p.o++]; const s = b.subarray(p.o, p.o + n).toString('latin1'); p.o += n; return s; };
  const p = { o };
  const vers = a8(buf, p);
  if (!vers.startsWith('ver2.')) throw new Error('unknown EPK version ' + vers);
  p.o += 1 + buf[p.o];                       // filename
  p.o += 2 + buf.readUInt16BE(p.o);          // comment
  p.o += 8;                                  // date
  const numFiles = buf.readInt32BE(p.o); p.o += 4;
  const comp = String.fromCharCode(buf[p.o++]);
  const body = buf.subarray(p.o, buf.length - 8);
  const z = comp === 'G' ? zlib.gunzipSync(body) : comp === 'Z' ? zlib.inflateSync(body) : body;
  const q = { o: 0 }; const out = new Map();
  for (let i = 0; i < numFiles; i++) {
    const type = z.subarray(q.o, q.o + 4).toString('latin1'); q.o += 4;
    const name = a8(z, q);
    const len = z.readInt32BE(q.o); q.o += 4;
    if (type === 'FILE') {
      const data = z.subarray(q.o + 4, q.o + len - 1);
      if (!wanted || wanted(name)) out.set(name, Buffer.from(data));
    }
    q.o += len; q.o += 1; // payload (+ ':' for FILE) and trailing '>'
  }
  return out;
}

module.exports = { readEPK };
