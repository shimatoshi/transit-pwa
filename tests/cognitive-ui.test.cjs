const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'), vm=require('node:vm');
const html=fs.readFileSync(__dirname+'/../index.html','utf8');
const helpers=html.slice(html.indexOf('function escapeUI'),html.indexOf('// === Global State'));
test('now searches reset a previously selected future date and hide manual controls',()=>{
 const elements={'time-type':{value:'now'},'date-input':{value:'2027-01-01'},'time-input':{value:'08:00'},'date-control':{},'time-control':{},'time-hint':{}};
 class Clock extends Date {constructor(){super('2026-10-02T09:30:00');}}
 const ctx={Date:Clock,document:{getElementById:id=>elements[id]}};vm.createContext(ctx);vm.runInContext(helpers,ctx);ctx.updateTimeUI();
 assert.equal(elements['date-input'].value,'2026-10-02');assert.equal(elements['time-input'].value,'09:30');
 assert.equal(elements['date-control'].hidden,true);assert.equal(elements['time-control'].hidden,true);
 elements['time-type'].value='arr';elements['date-input'].value='2026-10-03';ctx.updateTimeUI();
 assert.equal(elements['date-control'].hidden,false);assert.equal(elements['date-input'].value,'2026-10-03');
});
test('a partial station name never silently searches the first suggestion',()=>{
 let error='',queries=0,events=0;
 const input={value:'東京',dataset:{fieldId:'0'},dispatchEvent(){events++;}};
 const row={dataset:{role:'dep'},querySelector:()=>input};
 const ctx={document:{querySelectorAll:s=>s==='.field-row'?[row]:[input]},graph:{},selectedStations:{},clearInputError(){},showInputError:(i,m)=>error=m,findAllByName:()=>[],searchStations:()=>[{name:'東京駅とは異なる候補'}],Event:class{},RouterV3:{query(){queries++;}}};
 vm.createContext(ctx);vm.runInContext(html.slice(html.indexOf('function doSearch()'),html.indexOf('function formatTime(')),ctx);ctx.doSearch();
 assert.equal(queries,0);assert.equal(events,1);assert.match(error,/候補から/);assert.equal(input.value,'東京');
});
test('editing criteria keeps the previous result context visible and asks for a new search',()=>{
 const elements={'result-context':{textContent:'A → B'},'result-notice':{hidden:true}};
 const ctx={document:{getElementById:id=>elements[id]}};vm.createContext(ctx);vm.runInContext(helpers,ctx);ctx.markSearchDirty();
 assert.equal(elements['result-context'].textContent,'A → B');assert.equal(elements['result-notice'].hidden,false);
});
test('route disclosure reports the visible state and updates its action label',()=>{
 let collapsed=true;const attrs={},button={setAttribute:(k,v)=>attrs[k]=v};
 const detail={classList:{toggle:()=>collapsed=!collapsed}};
 const ctx={document:{getElementById:id=>id==='route-1'?detail:button}};
 vm.createContext(ctx);vm.runInContext(html.slice(html.indexOf('function toggleRoute('),html.indexOf('// 途中駅リスト')),ctx);
 ctx.toggleRoute('route-1');assert.equal(attrs['aria-expanded'],'true');assert.match(button.textContent,/閉じる/);
 ctx.toggleRoute('route-1');assert.equal(attrs['aria-expanded'],'false');assert.match(button.textContent,/開く/);
});
