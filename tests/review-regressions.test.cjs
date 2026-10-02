const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync(__dirname+'/../index.html','utf8');
const viaSource=html.slice(html.indexOf('function queryViaRoute('),html.indexOf('function formatTime('));
const shiftSource=html.slice(html.indexOf('function shiftTrain('),html.indexOf('let currentSort'));

function shiftContext(deadline=null){
 const schedules={'0:1':[[480,500],[540,560],[600,620]],'1:2':[[510,530],[570,590],[630,650]]};
 const ctx={RouterV3:{query:(from,to,start)=>{
   const row=(schedules[from+':'+to]||[]).find(([dep])=>dep>=start);
   return row?{dep:row[0],arr:row[1],transfers:0,legs:[{kind:'ride',from,to,dep:row[0],arr:row[1]}]}:null;
 },annotateBudget:j=>j},lastSearchOpts:{},searchTimeCtx:deadline,
 document:{getElementById:()=>null},toast:m=>ctx.message=m};
 vm.createContext(ctx);vm.runInContext(viaSource+shiftSource,ctx);
 ctx.allFoundRoutes=[ctx.queryViaRoute([[0],[1],[2]],540,{})];
 return ctx;
}
test('next and previous departures retain the requested via station',()=>{
 const ctx=shiftContext();ctx.shiftTrain(0,1);
 assert.deepEqual(Array.from(ctx.allFoundRoutes[0].waypoints),[0,1,2]);
 assert.equal(ctx.allFoundRoutes[0].dep,600);
 assert.equal(ctx.allFoundRoutes[0].legs[0].to,ctx.allFoundRoutes[0].legs[1].from);
 ctx.shiftTrain(0,-1);assert.equal(ctx.allFoundRoutes[0].dep,540);
});
test('next departure cannot silently exceed an arrival deadline',()=>{
 const ctx=shiftContext({type:'arr',minutes:600});const original=ctx.allFoundRoutes[0];
 ctx.shiftTrain(0,1);assert.equal(ctx.allFoundRoutes[0],original);assert.match(ctx.message,/到着時刻/);
});
test('via segments cannot jump between two different stations with the same label',()=>{
 const ctx=shiftContext();const query=ctx.RouterV3.query;
 ctx.RouterV3.query=(from,to,start)=>from===3&&to===2?query(1,2,start):from===1&&to===2?null:query(from,to,start);
 assert.equal(ctx.queryViaRoute([[0],[1,3],[2]],540,{}),null);
});
test('removing and readding via fields does not reuse a surviving field ID',()=>{
 const selected={};const ctx={selectedStations:selected,document:{querySelectorAll:()=>[]}};
 vm.createContext(ctx);
 const source=html.slice(html.indexOf('let nextFieldId'),html.indexOf('// === Via Stations'));
 vm.runInContext(source,ctx);
 const row=()=>{const input={dataset:{},setAttribute(){},addEventListener(){}};
   return {dataset:{role:'via'},input,querySelector:selector=>selector==='input'?input:selector==='.ac-dropdown'?{}:{setAttribute(){}}};};
 const a=row(),b=row();ctx.setupFieldAC(a);ctx.setupFieldAC(b);
 selected[b.input.dataset.fieldId]=7;
 delete selected[a.input.dataset.fieldId];const c=row();ctx.setupFieldAC(c);
 selected[c.input.dataset.fieldId]=9;
 assert.notEqual(b.input.dataset.fieldId,c.input.dataset.fieldId);
 assert.equal(selected[b.input.dataset.fieldId],7);
 ctx.setupFieldAC(b);assert.equal(selected[b.input.dataset.fieldId],7);
});
test('day offsets use Saturdays, Sundays, and public holidays of each calendar date',()=>{
 let value='2026-10-02';const ctx={document:{getElementById:()=>({value})}};
 vm.createContext(ctx);
 vm.runInContext(html.slice(html.indexOf('const FIXED_HOLIDAYS'),html.indexOf('// === Data Loading')),ctx);
 assert.deepEqual([0,1,2,3].map(i=>ctx.getDayType(i)),[0,1,2,0]);
 value='2026-09-21';assert.deepEqual([0,1,2,3].map(i=>ctx.getDayType(i)),[2,2,2,0]);
});
test('real timetable retains Ueno when shifting Funabashi to Gotanda via Ueno',()=>{
 const zlib=require('node:zlib'),R=require('../router_v3.js');
 const read=name=>JSON.parse(fs.readFileSync(__dirname+'/../'+name,'utf8'));
 const graph=read('graph_v2.json'),meta=read('trains_v3_meta.json'),fares=read('fares.json');
 const bin=zlib.gunzipSync(fs.readFileSync(__dirname+'/../trains_v3.bin.gz'));
 R.loadBinary(bin.buffer.slice(bin.byteOffset,bin.byteOffset+bin.byteLength),meta,graph.stations,fares);
 const ids=['船橋','上野','五反田'].map(n=>graph.stations.findIndex(s=>!s.m&&s.n===n));
 assert(ids.every(id=>id>=0));
 const ctx=shiftContext();ctx.RouterV3=R;ctx.lastSearchOpts={noBus:true,day:0,days:[0,1,2,0]};
 const first=ctx.queryViaRoute(ids.map(id=>[id]),540,ctx.lastSearchOpts);
 assert(first);ctx.allFoundRoutes=[first];ctx.shiftTrain(0,1);
 const next=ctx.allFoundRoutes[0];assert(next.dep>first.dep);
 assert.deepEqual(Array.from(next.waypoints),ids);
 assert(next.legs.some(l=>l.kind==='ride'&&l.stops.some(s=>s.st===ids[1])));
 for(let i=1;i<next.legs.length;i++)assert.equal(next.legs[i-1].to,next.legs[i].from);
 ctx.shiftTrain(0,-1);assert(ctx.allFoundRoutes[0].dep<next.dep);
 assert.deepEqual(Array.from(ctx.allFoundRoutes[0].waypoints),ids);
});
