const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync(__dirname+'/../index.html','utf8');
function sort(routes, mode, time){
 const ctx={RouterV3:{journeyFare:j=>({total:j.fare})},currentSeat:()=> 'reserved'};
 vm.createContext(ctx);
 vm.runInContext(html.slice(html.indexOf('let currentSort'),html.indexOf('function setSort(')),ctx);
 ctx.routes=routes;ctx.mode=mode;ctx.time=time;
 return Array.from(vm.runInContext('searchTimeCtx=time; routes.slice().sort(SORTERS[mode])',ctx),j=>j.id);
}
const far={id:'far',dep:480,arr:540,transfers:0,fare:100};
const near={id:'near',dep:595,arr:599,transfers:3,fare:1000};
for(const mode of ['fast','cheap','transfer']){
 for(const type of ['dep','arr'])test(`${mode}: ${type} proximity wins over speed, fare and transfers`,()=>{
  assert.deepEqual(sort([far,near],mode,{type,minutes:600}),['near','far']);
 });
 test(`${mode}: no specified time preserves original priority`,()=>{
  assert.deepEqual(sort([near,far],mode,null),['far','near']);
 });
}
test('equal proximity uses the selected sorting criterion',()=>{
 const a={id:'a',dep:600,arr:650,transfers:0,fare:500};
 const b={id:'b',dep:600,arr:640,transfers:1,fare:100};
 const time={type:'dep',minutes:600};
 assert.deepEqual(sort([a,b],'fast',time),['b','a']);
 assert.deepEqual(sort([a,b],'cheap',time),['b','a']);
 assert.deepEqual(sort([b,a],'transfer',time),['a','b']);
});
