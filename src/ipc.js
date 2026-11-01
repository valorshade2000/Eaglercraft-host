'use strict';
// Codec for the client <-> integrated-server IPC packets of EaglercraftX u53
// (src/main/java/net/lax1dude/eaglercraft/v1_8/sp/ipc/*). Wire format is Java
// DataOutputStream: big-endian numbers, writeUTF = u16 length + modified UTF-8.

const IPC_CHANNEL = '~!IPC';

class Writer {
  constructor() { this.parts = []; }
  u8(v) { this.parts.push(Buffer.from([v & 0xff])); return this; }
  bool(v) { return this.u8(v ? 1 : 0); }
  i32(v) { const b = Buffer.alloc(4); b.writeInt32BE(v | 0); this.parts.push(b); return this; }
  i64(v) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt.asIntN(64, BigInt(v))); this.parts.push(b); return this; }
  utf(s) {
    const bytes = [];
    for (const ch of String(s)) {
      // Java modified UTF-8 works on UTF-16 code units.
      for (let i = 0; i < ch.length; i++) {
        const c = ch.charCodeAt(i);
        if (c >= 1 && c <= 0x7f) bytes.push(c);
        else if (c <= 0x7ff) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    if (bytes.length > 65535) throw new Error('UTF string too long');
    const b = Buffer.alloc(2); b.writeUInt16BE(bytes.length);
    this.parts.push(b, Buffer.from(bytes));
    return this;
  }
  bytes(buf) { this.parts.push(Buffer.from(buf)); return this; }
  done() { return Buffer.concat(this.parts); }
}

class Reader {
  constructor(buf) { this.b = Buffer.from(buf); this.o = 0; }
  u8() { return this.b[this.o++]; }
  i8() { const v = this.b.readInt8(this.o); this.o += 1; return v; }
  bool() { return this.u8() !== 0; }
  i32() { const v = this.b.readInt32BE(this.o); this.o += 4; return v; }
  f32() { const v = this.b.readFloatBE(this.o); this.o += 4; return v; }
  bytes(n) { const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
  utf() {
    const n = this.b.readUInt16BE(this.o); this.o += 2;
    const end = this.o + n; let s = '';
    while (this.o < end) {
      const a = this.b[this.o++];
      if (a < 0x80) s += String.fromCharCode(a);
      else if ((a & 0xe0) === 0xc0) s += String.fromCharCode(((a & 0x1f) << 6) | (this.b[this.o++] & 0x3f));
      else { const b2 = this.b[this.o++], c = this.b[this.o++]; s += String.fromCharCode(((a & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (c & 0x3f)); }
    }
    return s;
  }
}

const enc = {
  startServer: ({ worldName, ownerName, difficulty = 2, viewDistance = 4, demo = false }) =>
    new Writer().u8(0x00).utf(worldName).utf(ownerName).u8(difficulty).u8(viewDistance).bool(demo).done(),
  stopServer: () => new Writer().u8(0x01).done(),
  initWorld: ({ worldName, gamemode = 0, worldType = 0, worldArgs = '', seed = 0n, cheats = false, structures = true, bonusChest = false, hardcore = false }) =>
    new Writer().u8(0x02).utf(worldName).u8(gamemode).u8(worldType).utf(worldArgs).i64(seed).bool(cheats).bool(structures).bool(bonusChest).bool(hardcore).done(),
  requestData: (worldName, request) => new Writer().u8(0x05).utf(worldName).u8(request).done(),
  importWorld: ({ worldName, data, format, gameRules = 0 }) =>
    new Writer().u8(0x07).utf(worldName).i32(data.length).u8(format).u8(gameRules).bytes(data).done(),
  setDifficulty: (d) => new Writer().u8(0x0a).u8(d).done(),
  pause: (p) => new Writer().u8(0x0b).bool(p).done(),
  playerChannel: (channel, open) => new Writer().u8(0x0c).utf(channel).bool(open).done(),
  stringList: (opCode, list) => { const w = new Writer().u8(0x14).u8(opCode).i32(list.length); for (const s of list) w.utf(s); return w.done(); },
  configureLAN: ({ gamemode = 0, cheats = false, iceServers = [] }) => {
    const w = new Writer().u8(0x17).u8(gamemode).bool(cheats).u8(iceServers.length);
    for (const s of iceServers) w.utf(s);
    return w.done();
  },
  autosave: () => new Writer().u8(0x19).done(),
  enableLogging: (en) => new Writer().u8(0x1b).bool(en).done(),
};

function decode(buf) {
  const r = new Reader(buf);
  const id = r.u8();
  switch (id) {
    case 0x09: { const n = r.i32(); return { id, type: 'RequestResponse', data: Buffer.from(r.bytes(n)) }; }
    case 0x0c: return { id, type: 'PlayerChannel', channel: r.utf(), open: r.bool() };
    case 0x0d: return { id, type: 'ProgressUpdate', message: r.utf(), progress: r.f32() };
    case 0x14: { const opCode = r.i8(); const n = r.i32(); const list = []; for (let i = 0; i < n; i++) list.push(r.utf()); return { id, type: 'StringList', opCode, list }; }
    case 0x15: { const n = r.i32(); return { id, type: 'Crashed', report: r.bytes(n).toString('utf8') }; }
    case 0x1a: return { id, type: 'Logger', message: r.utf(), isError: r.bool() };
    case 0x1c: return { id, type: 'IssueDetected', issue: r.u8() };
    case 0xff: return { id, type: 'KeepAlive', ack: r.u8() };
    default: return { id, type: 'Unknown' };
  }
}

module.exports = { IPC_CHANNEL, enc, decode, Writer, Reader };
