'use strict';
// Harness-only instrumentation for stage 8, path 4 (decoration on another thread, replayed in order): what each
// decoration (ChunkProviderGenerate.populate, EPT) does that a thread could not reproduce on a copy of the chunks, and
// how its time splits. Used with run.js --extra deco; the counts are in result.json speedups.deco.
// "Top level": a call made by the decoration's own logic, not inside a block write or another call it makes (those the
// game thread would make itself when it replays the decoration's block writes). Per decoration it notes:
//   light       a light value read at top level (mushrooms, snow and ice: Chunk.getLightFor CQj, getLightSubtracted DPI)
//   tileEntity  a tile entity read, set or removed at top level (dungeon chests and spawners: CRV, F6M, EoI)
//   entity      an entity added at top level outside the animals' spawning (Fll)
//   other       a block tick scheduled, neighbours notified or light checked at top level (EZy, Cz6, EXu, EcW)
//   worldRand   the world's random generator (World.c8) drawn at any depth outside the animals' spawning
//   newRandom   a random generator made without a seed, or Math.random, at any depth outside the animals' spawning
//   outside     a chunk asked for (ChunkProviderServer.provideChunk Cin, chunkExists Feb) outside the 2 x 2 chunks
//   randAfter   the decoration's own random generator drawn after the animals' spawning (its state there is the game's)
// and, as things the game thread would do itself in a replay: spawning (E31), forced block ticks (F7l, liquid springs),
// the top-level block writes (World.setBlockState FUd) and their time.
function apply(src) {
  const edit = (a, b) => { if (src.split(a).length !== 2) throw new Error('extra-deco: not found once: ' + a); src = src.replace(a, b); };
  const wrap = (name, args, pre, post) => edit(`function ${name}(${args}){`,
    `function ${name}(${args}){${pre || ''}var r=$dx${name}(${args});${post || ''}return r;}\nfunction $dx${name}(${args}){`);
  const code = [
    'var $dx={stack:[],depth:0,n:0,clean:0,ms:0,cleanMs:0,setMs:0,cleanSetMs:0,sets:0,cleanSets:0,why:{},whyMs:{},spawn:0,force:0,lavaForce:0};',
    'function $dxNow(){return Number(globalThis.process.hrtime.bigint())/1e6;}',
    'function $dxTop(){return $dx.stack.length>0&&$dx.depth===0;}',
    'function $dxCur(){return $dx.stack.length?$dx.stack[$dx.stack.length-1]:null;}',
    'function $dxFlag(k,any){var s=$dxCur();if(s===null||FQ())return;if(!any&&$dx.depth!==0)return;if(s.native>0&&k!=="outside")return;s.f[k]=(s.f[k]||0)+1;}',
    'function $dxEnter(a,c,d){$dx.stack.push({x:c,z:d,t:$dxNow(),f:{},sets:0,setMs:0,native:0,spawned:0,depth:$dx.depth,gen:a.no,world:a.jj});$dx.depth=0;}',
    'function $dxExit(){var s=$dx.stack.pop();$dx.depth=s.depth;var ms=$dxNow()-s.t,keys=Object.keys(s.f);$dx.n++;$dx.ms+=ms;$dx.sets+=s.sets;$dx.setMs+=s.setMs;' +
      'if(!keys.length){$dx.clean++;$dx.cleanMs+=ms;$dx.cleanSets+=s.sets;$dx.cleanSetMs+=s.setMs;}' +
      'else{var k=keys.sort().join("+");$dx.why[k]=($dx.why[k]||0)+1;$dx.whyMs[k]=($dx.whyMs[k]||0)+ms;}}',
    '(globalThis.__eaglanSpeedups||(globalThis.__eaglanSpeedups={})).deco=function(){return {populates:$dx.n,clean:$dx.clean,ms:$dx.ms,cleanMs:$dx.cleanMs,sets:$dx.sets,setMs:$dx.setMs,cleanSets:$dx.cleanSets,cleanSetMs:$dx.cleanSetMs,why:$dx.why,whyMs:$dx.whyMs,spawn:$dx.spawn,force:$dx.force};};',
  ].join('\n') + '\n';
  // the decoration: a record from its first call to its end (a pause in between and the call resuming are one call)
  edit('function EPT(a,b,c,d){', code + 'function EPT(a,b,c,d){if(!FQ())$dxEnter(a,c,d);var r=$dxEPT(a,b,c,d);if(!B())$dxExit();return r;}\nfunction $dxEPT(a,b,c,d){');
  // top-level block writes (timed) and the depth for everything inside them
  edit('function FUd(a,b,c,d){', 'function FUd(a,b,c,d){var s=$dxCur(),top=s!==null&&$dx.depth===0&&s.native===0&&!FQ(),t=top?$dxNow():0;if(top)s.sets++;$dx.depth++;var r=$dxFUd(a,b,c,d);$dx.depth--;if(top)s.setMs+=$dxNow()-t;return r;}\nfunction $dxFUd(a,b,c,d){');
  // what the game thread would do itself in a replay: the animals' spawning, a liquid spring's forced tick
  edit('function E31(b,c,d,e,f,g,h){', 'function E31(b,c,d,e,f,g,h){var s=$dxCur();if(s!==null&&!FQ()){$dx.spawn++;s.spawned=1;}if(s!==null)s.native++;$dx.depth++;var r=$dxE31(b,c,d,e,f,g,h);$dx.depth--;if(s!==null)s.native--;return r;}\nfunction $dxE31(b,c,d,e,f,g,h){');
  edit('function F7l(a,b,c,d){', 'function F7l(a,b,c,d){var s=$dxCur();if(s!==null&&!FQ())$dx.force++;$dx.depth++;var r=$dxF7l(a,b,c,d);$dx.depth--;return r;}\nfunction $dxF7l(a,b,c,d){');
  // things a thread could not reproduce
  for (const [n, args] of [['CQj', 'a,b,c'], ['DPI', 'a,b,c'], ['E2_', 'a,b,c'], ['F3Y', 'a,b,c']]) wrap(n, args, '$dxFlag("light");');
  for (const [n, args] of [['CRV', 'a,b'], ['F6M', 'a,b,c'], ['EoI', 'a,b']]) wrap(n, args, '$dxFlag("tileEntity");');
  wrap('Fll', 'a,b', '$dxFlag("entity");');
  for (const [n, args] of [['EZy', 'a,b,c,d'], ['Cz6', 'a,b,c,d'], ['EXu', 'a,b,c'], ['EcW', 'a,b']]) wrap(n, args, '$dxFlag("other");');
  wrap('E0d', 'a', '$dxFlag("newRandom",true);');
  edit('function E0(){return $rt_globals.Math.random();}', 'function E0(){$dxFlag("newRandom",true);return $rt_globals.Math.random();}');
  // the random generators: the world's at any depth; the decoration's own after the animals' spawning
  edit('function DF(a,b){', 'function DF(a,b){var s=$dxCur();if(s!==null&&s.native===0&&!FQ()){if(a===s.world.c8)$dxFlag("worldRand",true);else if(a===s.gen&&s.spawned)$dxFlag("randAfter",true);}return $dxDF(a,b);}\nfunction $dxDF(a,b){');
  // chunks outside the decoration's 2 x 2 (any depth)
  const out = 'var s=$dxCur();if(s!==null&&!FQ()&&(b<s.x||b>s.x+1||c<s.z||c>s.z+1))$dxFlag("outside",true);';
  wrap('Cin', 'a,b,c', out);
  wrap('Feb', 'a,b,c', out);
  return src;
}
module.exports = { apply };
