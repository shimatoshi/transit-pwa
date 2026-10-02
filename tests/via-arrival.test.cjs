const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync(__dirname+'/../index.html','utf8');
const source=html.slice(html.indexOf('function doSearch()'),html.indexOf('function formatTime('));
function search(type,minutes,schedulesOverride){
 const results={innerHTML:''};let rendered;
 const schedules=schedulesOverride || {'0:1':[[480,500],[570,590],[600,620]],'1:2':[[510,540],[600,630],[630,660]]};
 const stations=['出発','経由','到着'].map(n=>({n}));
 const rows=stations.map((s,i)=>({dataset:{role:i===1?'via':i===0?'dep':'arr'},querySelector:()=>({value:s.n,dataset:{fieldId:String(i)}})}));
 const context={clearInputError(){},updateTimeUI(){},formatTime:n=>String(n),document:{querySelectorAll:()=>rows,getElementById:id=>id==='results'?results:{checked:true}},selectedStations:{0:0,1:1,2:2},graph:{stations},findAllByName:n=>[stations.findIndex(s=>s.n===n)],getSearchTime:()=>({type,minutes,explicit:true}),currentSeat:()=>'',currentBudget:()=>null,travelMode:'rail',railFilter:'all',selectedOps:new Set(),getDayType:()=>0,lastSearchOpts:null,searchTimeCtx:null,alert:()=>{},renderMultipleResults:rs=>rendered=rs,RouterV3:{
  query:(f,t,start)=>{const row=(schedules[f+':'+t]||[]).find(([dep])=>dep>=start);return row?{dep:row[0],arr:row[1],transfers:0,legs:[{kind:'ride',from:f,to:t,dep:row[0],arr:row[1]}]}:null},
  annotateBudget:j=>j
 }};
 vm.runInNewContext(source+'\ndoSearch();',context);
 return {rendered,results};
}
test('via arrival search reaches the destination by the requested time',()=>{
 const {rendered}=search('arr',600);assert(rendered);const j=rendered[0];assert.equal(j.dep,480);assert.equal(j.arr,540);assert(j.arr<=600);assert(j.legs[1].dep-j.legs[0].arr>=4);assert.equal(j.legs[0].to,j.legs[1].from);
});
test('an unreachable arrival deadline shows a no-route message',()=>{
 const {rendered,results}=search('arr',450);assert.equal(rendered,undefined);assert.match(results.innerHTML,/指定した到着時刻/);
});
test('via departure search still starts at or after the requested time',()=>{
 const {rendered}=search('dep',600);assert.equal(rendered[0].dep,600);assert.equal(rendered[0].arr,660);
});
test('arrival search includes a departure at the beginning of the eight-hour window',()=>{
 const {rendered}=search('arr',600,{'0:1':[[110,116]],'1:2':[[120,600]]});
 assert(rendered);assert.equal(rendered[0].dep,110);assert.equal(rendered[0].arr,600);
});
