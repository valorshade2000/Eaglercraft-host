'use strict';
// Harness-only instrumentation: the game's mob spawner (SpawnerAnimals.findChunksForSpawning, Cwt in the vendored
// classes.js). Per call: its flags (spawn monsters, spawn animals at all, an animal tick: world total time a multiple of
// 400), the chunks it may spawn in, and how many mobs it spawned. Per creature type (by its cap: monster 70, creature
// (animals) 10, ambient 15, water 5): how often its cap was compared, the loaded count and the cap it was compared with
// (cap = max * chunks counted round the players / 289), and how each spawn attempt's steps went (the random position a
// normal cube, a player within 24 blocks, 24 blocks from the world spawn, a spawn list entry, the type allowed there, the
// placement, getCanSpawnHere, isNotColliding, spawned). On animal ticks: the loaded entities the animal count counted, by
// class. Used with run.js --extra spawn (worker-runtime.js applies it in harness runs only); in result.json speedups.spawn.
function apply(src) {
  const start = src.indexOf('function Cwt(a,b,c,d,e){'), end = src.indexOf('function ', start + 30);
  if (start < 0 || src.indexOf('function Cwt(a,b,c,d,e){', start + 1) >= 0) throw new Error('extra-spawn: Cwt not found once');
  let body = src.slice(start, end);
  const edit = (a, b, n = 1) => { if (body.split(a).length !== n + 1) throw new Error('extra-spawn: not found ' + n + ' time(s) in Cwt: ' + a); body = body.split(a).join(b); };
  edit('function Cwt(a,b,c,d,e){', 'function $spCwt(a,b,c,d,e){');
  edit('BXk(b,BtZ(s))<=(Bp(BOk(s),k)/LcN|0)', '$spCap(s,BXk(b,BtZ(s)),Bp(BOk(s),k)/LcN|0,k,b)', 2);
  edit('$z=ES0(l);', '$z=$spR("normalCube",ES0(l));');
  edit('$z=DIL(b,t,bg,bh,bi);', '$z=$spR("playerWithin24",DIL(b,t,bg,bh,bi));');
  edit('A3k(p,t,bg,bh)>=576.0', '$spR("spawn24Away",A3k(p,t,bg,bh)>=576.0)');
  edit('$z=CD7(b,s,l);', '$z=$spR("entry",CD7(b,s,l));');
  edit('$z=C7E(b,s,z,l);', '$z=$spR("typeAllowed",C7E(b,s,z,l));');
  edit('$z=EJ3(bj,b,l);', '$z=$spR("placement",EJ3(bj,b,l));');
  edit('$z=l.a1a();', '$z=$spR("canSpawnHere",l.a1a());');
  edit('$z=l.cmi();', '$z=$spR("notColliding",l.cmi());', 2);
  edit('case 24:Fll(b,l);', 'case 24:$spR("spawned",1);Fll(b,l);');
  const code = [
    'var $sp={calls:0,hostile:0,peaceful:0,animalTicks:0,spawned:0,spawnedOnAnimalTicks:0,eligible:0,eligibleMax:0,types:{},animalLog:[],cur:0};',
    'function $spT(m){return $sp.types[m]||($sp.types[m]={max:m,checks:0,under:0,count:0,cap:0,chunks:0,steps:{}});}',
    'function $spR(n,v){var t=$spT($sp.cur),k=n+(v?":yes":":no");t.steps[k]=(t.steps[k]||0)+1;return v;}',
    'function $spName(o){var m=o&&o.constructor&&o.constructor.$meta;var n=m&&m.name;return n?String(n).replace(/^.*\\./,""):"?";}',
    'function $spCap(s,n,cap,k,w){var m=BOk(s),t=$spT(m);t.checks++;t.count=n;t.cap=cap;t.chunks=k;if(n<=cap)t.under++;$sp.cur=m;' +
      'if(m===10){var names={},cls=BtZ(s).T,l=w.pP;for(var i=0;i<l.b;i++){var f=l.f.data[i];if(f instanceof Kr&&f.bkg)continue;if($rt_isAssignable(f.constructor,cls)){var nm=$spName(f);names[nm]=(names[nm]||0)+1;}}' +
      '$sp.animalLog.push({count:n,cap:cap,chunks:k,counted:names});if($sp.animalLog.length>40)$sp.animalLog.shift();}return n<=cap;}',
    'function Cwt(a,b,c,d,e){if(!FQ()){$sp.calls++;if(c)$sp.hostile++;if(d)$sp.peaceful++;if(e)$sp.animalTicks++;}var r=$spCwt(a,b,c,d,e);if(B())return r;' +
      '$sp.eligible=a.byy.sx;if(a.byy.sx>$sp.eligibleMax)$sp.eligibleMax=a.byy.sx;$sp.spawned+=r|0;if(e){$sp.spawnedOnAnimalTicks+=r|0;if($sp.animalLog.length)$sp.animalLog[$sp.animalLog.length-1].spawnedThisCall=r|0;}return r;}',
    '(globalThis.__eaglanSpeedups||(globalThis.__eaglanSpeedups={})).spawn=function(){return JSON.parse(JSON.stringify($sp));};',
  ].join('\n') + '\n';
  return src.slice(0, start) + code + body + src.slice(end);
}
module.exports = { apply };
