const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/../index.html','utf8');
const fn=source.match(/function useEnteredTime\(\) \{[\s\S]*?\n\}/)[0];
test('editing time changes now to departure but preserves arrival mode',()=>{
 const type={value:'now'},ctx={updateTimeUI(){},document:{getElementById:()=>type}};
 vm.createContext(ctx);vm.runInContext(fn,ctx);ctx.useEnteredTime();assert.equal(type.value,'dep');
 type.value='arr';ctx.useEnteredTime();assert.equal(type.value,'arr');
});
