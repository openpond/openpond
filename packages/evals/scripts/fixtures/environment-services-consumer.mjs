import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { contentHash } from '@openpond/harness';
import { createLearningTextAsset, sealLearningContent } from '@openpond/evals/learning';
import { createJavaScriptEnvironmentSession, JavaScriptEnvironmentDefinitionSchema } from '@openpond/evals/javascript-environment';
import { executeJavaScriptEnvironmentInProcess } from '@openpond/evals/javascript-environment/node';
// Protect the shared session boundary: services execute actual submissions while
// hidden expectations remain in the owner, and destroy waits for all child work.
const asset = createLearningTextAsset({ text: `
export function create({initialState}) { return {state:initialState,observation:{}}; }
export const reset=create;
export function step({state,action,services}) { return action.name==='submit' ? {state:{source:action.arguments.source},observation:{accepted:true}} : {state,observation:{sql:services.query}}; }
export function collect({state,initialState,services}) { const result=services.program; return {state,observation:{result,passed:result.status==='completed'&&result.cases.every((value,index)=>value.answer===initialState.cases[index].expected&&!value.leak&&!value.previous)}}; }
export function destroy(){return{state:{},observation:{}};}
`, path:'service-owner.mjs', mediaType:'application/javascript', visibility:'host_private' });
const tool = (name, property, sideEffect) => { const inputSchema={type:'object',properties:{[property]:{type:'string'}},required:[property],additionalProperties:false};return{name,description:name,inputSchema,inputSchemaHash:contentHash(inputSchema),sideEffect,timeoutMs:5000};};
const base={schemaVersion:'openpond.javascriptEnvironment.v1',id:'packed-services',revision:1,module:asset.asset,tools:[tool('submit','source','write'),tool('query','sql','read')],maxSteps:20,maxStateBytes:65536,maxObservationBytes:65536,operationTimeoutMs:5000};
const definition=sealLearningContent({...base,executionServices:[
{id:'query',kind:'sqlite.v1',operation:'step',toolName:'query',timeoutMs:2000,sql:{scope:'arguments',path:['sql']},snapshot:{scope:'input',path:['snapshot']},maxRows:50,maxResultBytes:4096},
{id:'program',kind:'javascript.v1',operation:'collect',timeoutMs:1500,source:{scope:'state',path:['source']},cases:{scope:'initialState',path:['cases']},exportName:'solve',maxCases:8,maxResultBytes:8192},
]});
const old=sealLearningContent(base);assert.equal(JavaScriptEnvironmentDefinitionSchema.parse(old).contentHash,old.contentHash);assert.equal('executionServices' in JavaScriptEnvironmentDefinitionSchema.parse(old),false);
const input={snapshot:{tables:[{name:'items',columns:[{name:'n',type:'INTEGER'}],rows:[[1],[2]]}]},cases:[{input:{x:1},expected:2,secret:'owner-only'},{input:{x:2},expected:3,secret:'owner-only'}]};
const create=()=>createJavaScriptEnvironmentSession({definition,asset,input:{snapshot:input.snapshot},initialState:{source:'',cases:input.cases},seed:0,execute:executeJavaScriptEnvironmentInProcess});
const session=await create();
try {
  const before=session.snapshot().finalStateHash;
  assert.deepEqual(await session.step({name:'query',arguments:{sql:'SELECT sum(n) AS total FROM items'}}),{sql:{status:'completed',columns:['total'],rows:[[3]]}});
  assert.equal(session.snapshot().finalStateHash,before);
  await session.step({name:'submit',arguments:{source:"export function solve(input){const previous=Object.prototype.changed===true;Object.prototype.changed=true;return{answer:input.x+1,previous,leak:['expected','secret','services','state','process','require'].some(key=>Object.hasOwn(input,key)||Object.hasOwn(globalThis,key))};}"}});
  const state=session.snapshot().finalStateHash;
  const collected=await session.collect();assert.equal(collected.observation.passed,true);assert.equal(collected.finalStateHash,state);
  for(const source of ["import fs from 'node:fs';export function solve(){return fs.readFileSync('/etc/passwd')}","export function solve(){for(;;){}}","export function solve(){return 'x'.repeat(100000)}"]){
    await session.step({name:'submit',arguments:{source}});
    const result=await session.collect();assert.equal(result.observation.passed,false);assert.equal(result.observation.result.status,'rejected');
  }
} finally {await session.destroy();}
const running=await create();await running.step({name:'submit',arguments:{source:'export function solve(){for(;;){}}'}});
const childrenFile=`/proc/${process.pid}/task/${process.pid}/children`;const children=()=>existsSync(childrenFile)?readFileSync(childrenFile,'utf8').trim():null;const before=children();
const collecting=running.collect();const rejection=assert.rejects(collecting,/environment_destroyed/);await running.destroy();await rejection;assert.equal(children(),before);await running.destroy();
process.stdout.write('Packed environment execution services verified\n');
const { runJavaScriptEnvironmentAttempt } = await import('@openpond/evals/javascript-environment/attempt');
let turn=0;
const attempt=await runJavaScriptEnvironmentAttempt({definition,asset,input:{snapshot:input.snapshot},initialState:{source:'',cases:input.cases},seed:0,execute:executeJavaScriptEnvironmentInProcess,taskId:'hidden-cases',instructions:'Submit solve(input).',timeoutMs:15000,policy:async({messages})=>{
  assert.ok(!JSON.stringify(messages).includes('owner-only'));assert.ok(!JSON.stringify(messages).includes('"expected"'));
  return turn++===0?{text:'',toolCalls:[{id:'submit',name:'submit',arguments:{source:'export function solve(input){return{answer:input.x+1}}'}}]}:{text:'done',toolCalls:[]};
}});
assert.equal(attempt.status,'completed');assert.equal(attempt.environmentCleanupComplete,true);assert.equal(attempt.snapshot.events.at(-1).observation.passed,true);
const infrastructure=await runJavaScriptEnvironmentAttempt({definition,asset,input:{snapshot:{tables:[{name:'bad',columns:[{name:'n',type:'INTEGER'}],rows:[[1,2]]}]}},initialState:{source:'',cases:input.cases},seed:0,execute:executeJavaScriptEnvironmentInProcess,taskId:'bad-owner-snapshot',instructions:'Query.',timeoutMs:15000,policy:async()=>({text:'',toolCalls:[{id:'query',name:'query',arguments:{sql:'SELECT 1'}}]})});
assert.equal(infrastructure.status,'environment_failure');assert.equal(infrastructure.collected,false);assert.equal(infrastructure.environmentCleanupComplete,true);
process.stdout.write('Packed policy privacy and infrastructure classification verified\n');
