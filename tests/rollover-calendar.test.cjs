const {test}=require('node:test');
const assert=require('node:assert/strict');
const R=require('../router_v3.js');
// Minimal binary timetable with real connection construction and calendar filtering.
function load(trips){
 const align=n=>(n+3)&~3,nt=trips.length,ns=trips.reduce((n,t)=>n+t.stops.length,0);
 const stopStart=12+(nt+1)*4,arrStart=align(stopStart+ns*2),depStart=align(arrStart+ns*2);
 const ab=new ArrayBuffer(align(depStart+ns*2)),dv=new DataView(ab);
 [0x54,0x56,0x33].forEach((v,i)=>dv.setUint8(i,v));dv.setUint32(4,nt,true);dv.setUint32(8,ns,true);
 let off=0;trips.forEach((t,i)=>{dv.setUint32(12+i*4,off,true);for(const [st,a,d] of t.stops){
   dv.setUint16(stopStart+off*2,st,true);dv.setUint16(arrStart+off*2,a??65535,true);
   dv.setUint16(depStart+off*2,d??65535,true);off++;
 }});dv.setUint32(12+nt*4,off,true);
 R.loadBinary(ab,{lines:['ＪＲテスト線'],types:['普通'],trips:{l:trips.map(()=>0),t:trips.map(()=>0),d:trips.map(()=>''),c:trips.map(t=>t.cal)},footpaths:[]},
 ['出発','経由','到着','終点'].map(n=>({n,la:35,lo:139})),null);
}
test('Friday overnight journey boards Saturday daytime service',()=>{
 load([{cal:1,stops:[[0,1380,1380],[1,1410,null]]},
 {cal:1,stops:[[1,360,360],[2,420,null]]},
 {cal:2,stops:[[1,390,390],[2,450,null]]}]);
 const j=R.query(0,2,1380,{day:0,days:[0,1,2,0]});
 assert(j);assert.equal(j.arr,1890);assert.equal(j.legs[1].dep,1830);
});
test('after-midnight duplicate is filtered by its own operating date',()=>{
 load([{cal:1,stops:[[0,1380,1380],[1,1410,null]]},
 {cal:1,stops:[[1,30,30],[2,60,null]]},
 {cal:2,stops:[[1,40,40],[2,70,null]]}]);
 const j=R.query(0,2,1380,{day:0,days:[0,1,2,0]});
 assert(j);assert.equal(j.arr,1510);assert.equal(j.legs[1].dep,1480);
});
test('a through train crossing midnight keeps the calendar of its origin day',()=>{
 load([{cal:1,stops:[[0,1430,1430],[1,10,11],[2,30,null]]}]);
 const j=R.query(0,2,1430,{day:0,days:[0,1,2,0]});
 assert(j);assert.equal(j.arr,1470);assert.equal(j.legs.length,1);
});
test('boarding a train today does not board its next-day copy at another station',()=>{
 load([{cal:7,stops:[[0,0,0],[1,10,11],[2,1380,1380],[3,1390,null]]}]);
 const j=R.query(2,1,1380,{day:0,days:[0,1,2,0]});
 assert.equal(j,null);
});
