'use strict';
// A pre-generation job with nobody on the server (so it loads several chunks a tick: config pregenFastWhenEmpty):
// every chunk within `radius` blocks of spawn made, decorated, lit and saved, one tick at a time, to its end.
// Args: { radius: 160, rate: 400, maxTicks: 6000 }. result: the job's last status.
module.exports = async function pregen(h) {
  const { radius = 160, rate = 400, maxTicks = 6000 } = h.args;
  await h.steps(2);
  const r = await h.call('pregen', { action: 'start', radius, rate, fromRing: 0, fast: true });
  if (r && r.error) throw new Error('pregen: ' + r.error);
  let st = null;
  for (let t = 0; t < maxTicks; t++) {
    await h.steps(1);
    if (t % 20 === 19) { st = (await h.call('pregen', { action: 'status' })) || null; const p = st && (st.status || st); if (p && (p.done || (!p.running && p.processed > 0))) break; }
  }
  h.result.pregen = st;
};
