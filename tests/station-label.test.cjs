const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/../index.html','utf8');
const ctx={};vm.createContext(ctx);vm.runInContext(source.match(/function stationDisplayLines\(station\) \{[\s\S]*?\n\}/)[0],ctx);
test('rail station suggestions show physical lines rather than remote through-service lines',()=>{
 const station={n:'五反田',l:['京成成田スカイアクセス線','ＪＲ山手線'],wl:['五反田駅','山手線','東急池上線','都営地下鉄浅草線']};
 assert.deepEqual(Array.from(ctx.stationDisplayLines(station)),['山手線','東急池上線','都営地下鉄浅草線']);
});
test('bus systems and rail stations without physical-line data retain their labels',()=>{
 assert.deepEqual(Array.from(ctx.stationDisplayLines({m:1,sys:['反９４']})),['反９４']);
 assert.deepEqual(Array.from(ctx.stationDisplayLines({n:'駅名',l:['路線名'],wl:[]})),['路線名']);
});
