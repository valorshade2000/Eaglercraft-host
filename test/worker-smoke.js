// Smoke test: boot the native integrated server in a Node worker, create a world, start it, stop it.
const path = require('path');
const { Worker } = require('worker_threads');
const { IPC_CHANNEL, enc, decode } = require('../src/ipc');

const dbFile = process.argv[2] || path.join(require('os').tmpdir(), 'eaglan-smoke-' + Date.now() + '.sqlite');
require('fs').mkdirSync(path.dirname(dbFile), { recursive: true });
const w = new Worker(path.resolve(__dirname, '../src/worker-runtime.js'), {
  workerData: { dbFile, classesJs: require('../src/paths').classesJs },
});
const send = (buf) => { const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); w.postMessage({ ch: IPC_CHANNEL, dat: ab }, [ab]); };
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
let stage = 0;
w.on('message', (m) => {
  if (m.__host) return console.log(ts(), m.msg);
  if (m.ch !== IPC_CHANNEL) return console.log(ts(), 'channel pkt', m.ch);
  const p = decode(m.dat);
  if (p.type === 'Logger') return console.log(ts(), '[srv]', p.message);
  if (p.type === 'StringList' && p.opCode === 3) return;
  console.log(ts(), 'IPC', JSON.stringify(p).slice(0, 300));
  if (p.type === 'KeepAlive' && p.ack === 0xff && stage === 0) {
    stage = 1;
    send(enc.initWorld({ worldName: 'Smoke World', seed: 12345n }));
    send(enc.startServer({ worldName: 'smoke_world', ownerName: 'HeadlessHost' }));
  } else if (p.type === 'KeepAlive' && p.ack === 0x00 && stage === 1) {
    stage = 2;
    console.log(ts(), 'SERVER STARTED; stopping in 5s');
    setTimeout(() => send(enc.stopServer()), 5000);
  } else if (p.type === 'KeepAlive' && p.ack === 0x01 && stage === 2) {
    console.log(ts(), 'SERVER STOPPED OK'); w.terminate();
  }
});
w.on('error', (e) => console.log('worker error', e));
w.on('exit', (c) => console.log('worker exit', c));
w.postMessage({ msg: JSON.stringify({ worldsDB: 'worlds', demoMode: false, lang: 'en_US', allowVoiceClient: false, allowUpdateSvc: false, allowUpdateDL: false, allowFNAWSkins: true, crashOnUncaughtExceptions: false }) });
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 120000).unref();
