'use strict';
// Harness-only instrumentation for stage 8, path 1 (entity updates in parallel, results committed in order): how often
// one entity's update depends on entities updated before it in the same tick. Such an update cannot run in parallel
// on a copy of the tick's start: in-order commit would have to run it again. Used with run.js --extra conflicts (worker-
// runtime.js applies it to the game code in harness runs only); the counts are in result.json speedups.conflicts.
// Per entity update (World.updateEntityWithOptionalForce, EPB), in update order:
//   read:    one of its entity queries (getEntitiesInAABBexcluding CGv, getEntitiesWithinAABB CGg: targets, collisions,
//            pushing, pickups...) returned an entity already updated in this tick
//   written: an entity updated before it in this tick pushed it (Entity.addVelocity A0u on it while the other updated)
//   crossK:  the same, counting only dependencies on an entity in an earlier part when the tick's updates are cut into
//            K parts in order (K = 2, 4, 8: K threads each running one part on a copy, committed in order)
// Not counted, and each enough on its own to need serial order: the world's random generator and the global entity id
// counter (spawning, drops), each mob's own random numbers drawn in update order, block changes.
function apply(src) {
  const edit = (a, b) => { if (src.split(a).length !== 2) throw new Error('extra-conflicts: not found once: ' + a); src = src.replace(a, b); };
  const code = [
    'var $cf={tick:-1,cur:null,order:0,n:0,lastN:0,dep:0,wr:0,cross:[0,0,0],updates:0,read:0,written:0,any:0,crossK:{2:0,4:0,8:0},queries:0,ticks:0};',
    'function $cfTickNow(){var t=Math.floor($rt_globals.performance.now()/50);if(t!==$cf.tick){$cf.tick=t;$cf.lastN=$cf.order||$cf.lastN;$cf.order=0;$cf.ticks++;}}',
    'function $cfUpd(a,b,c){$cfTickNow();var prev=$cf.cur,saved=[$cf.dep,$cf.wr,$cf.cross[0],$cf.cross[1],$cf.cross[2]];$cf.cur=b;$cf.dep=0;$cf.wr=b.$cfWr===$cf.tick?1:0;$cf.cross=[0,0,0];' +
      'var me=$cf.order,ks=[2,4,8];if($cf.wr&&b.$cfWrBy!==undefined)for(var i=0;i<3;i++){var part=Math.max(1,Math.ceil($cf.lastN/ks[i]));if(Math.floor(b.$cfWrBy/part)!==Math.floor(me/part))$cf.cross[i]=1;}' +
      'b.$cfOrder=me;var r=$cfEPB(a,b,c);if(B()){$cf.cur=prev;return r;}' +
      '$cf.order++;b.$cfTick=$cf.tick;$cf.updates++;if($cf.dep)$cf.read++;if($cf.wr)$cf.written++;if($cf.dep||$cf.wr)$cf.any++;' +
      'if($cf.cross[0])$cf.crossK[2]++;if($cf.cross[1])$cf.crossK[4]++;if($cf.cross[2])$cf.crossK[8]++;' +
      '$cf.cur=prev;$cf.dep=saved[0];$cf.wr=saved[1];$cf.cross=[saved[2],saved[3],saved[4]];return r;}',
    'function $cfQ(l){if(l===undefined||l===null||$cf.cur===null)return l;$cf.queries++;var me=$cf.cur.$cfOrder,ks=[2,4,8];' +
      'for(var i=0;i<l.b;i++){var x=l.f.data[i];if(x!==$cf.cur&&x.$cfTick===$cf.tick){$cf.dep=1;for(var k=0;k<3;k++){var part=Math.max(1,Math.ceil($cf.lastN/ks[k]));if(Math.floor(x.$cfOrder/part)!==Math.floor(me/part))$cf.cross[k]=1;}}}return l;}',
    'function $cfPush(a){if($cf.cur!==null&&a!==$cf.cur){a.$cfWr=$cf.tick;a.$cfWrBy=$cf.cur.$cfOrder;}}',
    '(globalThis.__eaglanSpeedups||(globalThis.__eaglanSpeedups={})).conflicts=function(){return {ticks:$cf.ticks,updates:$cf.updates,read:$cf.read,written:$cf.written,any:$cf.any,crossK:$cf.crossK,queries:$cf.queries};};',
  ].join('\n') + '\n';
  edit('function EPB(a,b,c){', code + 'function EPB(a,b,c){return $cfUpd(a,b,c);}\nfunction $cfEPB(a,b,c){');
  edit('function CGv(a,b,c,d){', 'function CGv(a,b,c,d){return $cfQ($cfCGv(a,b,c,d));}\nfunction $cfCGv(a,b,c,d){');
  edit('function CGg(a,b,c,d){', 'function CGg(a,b,c,d){return $cfQ($cfCGg(a,b,c,d));}\nfunction $cfCGg(a,b,c,d){');
  edit('function A0u(a,b,c,d){', 'function A0u(a,b,c,d){$cfPush(a);return $cfA0u(a,b,c,d);}\nfunction $cfA0u(a,b,c,d){');
  return src;
}
module.exports = { apply };
