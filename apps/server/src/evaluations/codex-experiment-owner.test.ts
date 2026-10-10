import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {expect,test,vi} from 'vitest';
import {ProviderSettingsSchema,type CodexStatus,type LocalDatasetRecord} from '@openpond/contracts';
import {SqliteStore} from '../store/store.js';
import {createLocalDatasetService} from '../training/local-dataset-service.js';
import {createChatExperiments} from './chat-experiments.js';

const native=vi.hoisted(()=>({account:'first@example.test',dispatches:0,switchAfterDispatch:false,threads:[] as any[],prompts:[] as string[],closed:0}));
vi.mock('../providers/codex-model-catalog.js',()=>({withCodexModelCatalog:async(settings:any)=>({...settings,modelCaches:{codex:{models:[{id:'gpt-6.1-sol',displayName:'GPT 6.1 Sol',capabilities:{reasoningEfforts:['low'],streaming:true}}]}}})}));
vi.mock('@openpond/codex-provider',()=>({
 defaultServerRequestResult:()=>({result:{}}),
 CodexAppServerClient:class {
  constructor(private options:any){}
  async readAccount(){return{account:{type:'chatgpt',email:native.account,planType:'pro'}};}
  async readConfig(){return{config:{mcp_servers:{private_connection:{enabled:true}}}};}
  async startThread(input:any){native.threads.push(input);return{threadId:'thread'};}
  async startTurn(input:any){native.dispatches++;native.prompts.push(input.prompt);this.options.onNotification({method:'item/completed',params:{item:{type:'agentMessage',text:'4',phase:'final_answer'}}});this.options.onNotification({method:'thread/tokenUsage/updated',params:{tokenUsage:{total:{inputTokens:20,outputTokens:1,totalTokens:21}}}});if(native.switchAfterDispatch)native.account='second@example.test';return{turnId:'turn'};}
  async waitForTurn(){}
  async interruptTurn(){}
  async stop(){native.closed++;}
  async stopAndWait(){native.closed++;}
 },
}));

// Failure story: subscription evaluation must use the pinned native login,
// exclude repo/MCP/private gold, clean up every process, retain unknown dollar
// cost, and prevent a changed account from dispatching the remaining cases.
test('Codex chat experiments use isolated subscription execution and fence account changes',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'openpond-codex-owner-')),store=new SqliteStore(home),datasets=createLocalDatasetService({store,home});
 // An incomplete unrelated provider must not block subscription model discovery.
 const settings=ProviderSettingsSchema.parse({providers:{codex:{id:'codex',enabled:true},'custom-openai-compatible':{id:'custom-openai-compatible',enabled:true}},modelCaches:{'custom-openai-compatible':{providerId:'custom-openai-compatible',source:'manual',models:[{id:'incomplete',providerId:'custom-openai-compatible',displayName:'Unconfigured endpoint',source:'manual',contextWindow:4096,outputLimit:256,capabilities:{streaming:true}}]}}});
 await store.claimLocalExperimentOwner('native-owner');
 const status=async():Promise<CodexStatus>=>({available:true,binaryPath:'/native/codex',version:'1.0.0',authHealth:'signed_in',account:{type:'chatgpt',email:native.account,planType:'pro',label:'ChatGPT Pro'},appServer:{status:'ready',lastError:null}});
 const experiments=await createChatExperiments({store,home,ownerId:'native-owner',datasets,codexStatus:status,state:async()=>({settings,secrets:{version:1,providers:{}}})});
 try{
  const created=await datasets.request({action:'create',operationId:'author',payload:{name:'Native arithmetic',draft:{objective:'Exact arithmetic',tasks:['one','two'].map(id=>({schemaVersion:'openpond.taskData.v1',id,clusterKey:id,split:'validation',input:{prompt:'Answer 2+2 with the number only.'},expectedOutput:{text:'4',private:'GOLD_CANARY'},policyVisibleContext:{},privilegedContextRef:null,sourceRefs:[],tags:[],metadata:{}})),graders:[{id:'exact',version:'1',label:'Exact answer',kind:'content',weight:1,hardGate:true,rewardEligible:false,privileged:true,config:{operator:'final_answer_equals_expected'},metadata:{}}]}}}) as {record:LocalDatasetRecord};
  const input={datasetId:created.record.workspace.draft.id,revision:1,operationId:'subscription',taskLimit:2,maxOutputTokens:128,models:[{providerId:'codex',modelId:'gpt-6.1-sol'}]};
  const admitted=await experiments.run(input);expect(admitted.errors).toEqual([]);expect(admitted.summaries[0]).toMatchObject({datasetId:input.datasetId,datasetRevision:1,costUsd:null});await experiments.service.wait(admitted.runs[0]!.id);
  const result=await experiments.request({action:'result',payload:{id:admitted.runs[0]!.id}}) as any;
  expect(result.summary).toMatchObject({state:'completed',datasetId:input.datasetId,datasetRevision:1,taskCount:2,evaluatedCount:2,score:1,costUsd:null});expect(native.dispatches).toBe(2);
  expect(native.prompts.join('\n')).not.toContain('GOLD_CANARY');
  for(const thread of native.threads){expect(thread).toMatchObject({ephemeral:true,approvalPolicy:'never',sandbox:'read-only',dynamicTools:[],config:{'features.shell_tool':false,'features.apps':false,'features.plugins':false,'features.hooks':false,'agents.enabled':false,'mcp_servers.private_connection.enabled':false,project_doc_max_bytes:0,web_search:'disabled',model_reasoning_effort:'low'}});expect(thread.cwd).toContain('openpond-codex-eval-');await expect(import('node:fs/promises').then(fs=>fs.access(thread.cwd))).rejects.toThrow();}
  expect(native.closed).toBe(2);
  const replay=await experiments.run(input);expect(replay.runs[0]!.id).toBe(admitted.runs[0]!.id);expect(replay.summaries[0]).toMatchObject({score:1,datasetId:input.datasetId,datasetRevision:1,costUsd:null});expect(native.dispatches).toBe(2);
  await expect(experiments.run({...input,operationId:'no-metered-budget',models:[{providerId:'openpond',modelId:'paid-model'}]})).rejects.toThrow(/budget/);
  native.switchAfterDispatch=true;
  const fenced=await experiments.run({...input,operationId:'account-switch'});await experiments.service.wait(fenced.runs[0]!.id);
  expect(native.dispatches).toBe(3);
  expect((await experiments.service.result({teamId:experiments.scope,id:fenced.runs[0]!.id})).cases.some(row=>row.status==='failed')).toBe(true);
 }finally{await experiments.service.close();await store.releaseLocalExperimentOwner('native-owner');await store.close();await rm(home,{recursive:true,force:true});}
},30_000);
