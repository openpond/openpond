/** Development-only schema export. Installed Python never invokes a JavaScript runtime. */
import { z } from 'zod';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as alphaedit from '../../../packages/sdk/src/alphaedit.ts';
import * as alphaeditArtifact from '../../../packages/sdk/src/alphaedit-artifact.ts';
import * as alphaeditDraft from '../../../packages/sdk/src/alphaedit-experiment-draft.ts';
import * as alphaeditExecutions from '../../../packages/sdk/src/managed-alphaedit-executions.ts';
import * as alphaeditServing from '../../../packages/sdk/src/alphaedit-model-serving.ts';
import * as neuronTraining from '../../../packages/sdk/src/neuron-training.ts';
import * as neuronTrainingArtifact from '../../../packages/sdk/src/neuron-training-artifact.ts';
import * as neuronTrainingResult from '../../../packages/sdk/src/neuron-training-result.ts';
import * as neuronTrainingDraft from '../../../packages/sdk/src/neuron-training-experiment-draft.ts';
import * as neuronTrainingExecutions from '../../../packages/sdk/src/managed-neuron-training-executions.ts';
import * as neuronTrainingServing from '../../../packages/sdk/src/neuron-training-model-serving.ts';
import * as weightModels from '../../../packages/sdk/src/weight-model-versions.ts';
import * as weightInference from '../../../packages/sdk/src/weight-inference.ts';
import * as engramAdapter from '../../../packages/sdk/src/engram-adapter.ts';
import * as engramDraft from '../../../packages/sdk/src/engram-experiment-draft.ts';
import * as engramExecutions from '../../../packages/sdk/src/managed-engram-executions.ts';
import * as engramInference from '../../../packages/sdk/src/engram-inference.ts';
import * as engramModels from '../../../packages/sdk/src/engram-model-version.ts';
import * as engramServing from '../../../packages/sdk/src/engram-model-serving.ts';
import * as decisionModel from '../../../packages/sdk/src/decision-model.ts';
import * as decisionData from '../../../packages/sdk/src/decision-model-data.ts';
import * as decisionArtifact from '../../../packages/sdk/src/decision-model-artifact.ts';
import * as decisionTraining from '../../../packages/sdk/src/decision-model-training.ts';
import * as decisionDraft from '../../../packages/sdk/src/decision-experiment-draft.ts';
import * as decisionAuthoring from '../../../packages/sdk/src/decision-experiment-authoring.ts';
import * as decisionExecutions from '../../../packages/sdk/src/managed-decision-executions.ts';
import * as decisionModels from '../../../packages/sdk/src/decision-model-version.ts';
import * as decisionScoring from '../../../packages/sdk/src/decision-model-scoring.ts';
import * as decisionServing from '../../../packages/sdk/src/decision-model-serving.ts';
import * as evaluation from '../../../packages/sdk/src/training-evaluation-results.ts';
import * as datasetPreparation from '../../../packages/sdk/src/dataset-preparation-contracts.ts';
import * as datasetOperations from '../../../packages/sdk/src/dataset-workspace-operations.ts';
import * as tasksetRuns from '../../../packages/sdk/src/model-taskset-runs-contracts.ts';
import * as harness from '../../../packages/harness/src/source-package.ts';
import * as learningClient from '../../../packages/sdk/src/learning-client.ts';
import * as harnessClient from '../../../packages/sdk/src/training-harness-sources.ts';
import * as credentials from '../../../packages/sdk/src/learning-credentials.ts';
import * as learningIndex from '../../../packages/evals/src/learning/index.ts';
import * as training from '../../../packages/sdk/src/training.ts';
import * as trainingContracts from '../../../packages/sdk/src/training-job-contracts.ts';
import * as trainingResult from '../../../packages/sdk/src/training-result.ts';
import * as trainingModelSave from '../../../packages/sdk/src/training-model-save.ts';
import * as trainingModelServing from '../../../packages/sdk/src/training-model-serving.ts';
import * as trainingModelServingControl from '../../../packages/sdk/src/training-model-serving-control.ts';
import * as managedServingUsage from '../../../packages/sdk/src/managed-serving-usage.ts';
import * as serverlessServing from '../../../packages/sdk/src/serverless-serving.ts';
import * as trainingUsageFunding from '../../../packages/sdk/src/training-usage-funding.ts';
import * as trainingUsageStatus from '../../../packages/sdk/src/training-usage-status.ts';
import * as neuronSteering from '../../../packages/sdk/src/neuron-steering.ts';
import * as steeringSelection from '../../../packages/sdk/src/steering-model-selection.ts';
import * as steeringServing from '../../../packages/sdk/src/steering-model-serving.ts';
import * as steeringInference from '../../../packages/sdk/src/steering-inference.ts';
import * as residualCalibration from '../../../packages/sdk/src/neuron-residual-calibration.ts';
import * as calibrationRecords from '../../../packages/sdk/src/neuron-calibration-records.ts';
import * as activationReference from '../../../packages/sdk/src/activation-reference.ts';
import * as preparation from '../../../packages/sdk/src/training-preparations.ts';
import * as experimentSetup from '../../../packages/sdk/src/training-experiment-setup.ts';
import * as evaluationDrafts from '../../../packages/sdk/src/evaluation-experiment-draft.ts';
import * as hostedEvaluationDrafts from '../../../packages/sdk/src/hosted-evaluation-experiment-draft.ts';
import * as activationDrafts from '../../../packages/sdk/src/activation-experiment-draft.ts';
import * as modificationCapabilities from '../../../packages/sdk/src/model-modification-capabilities.ts';
import * as modificationRecordings from '../../../packages/sdk/src/modification-recordings.ts';
import * as experimentDraftStorage from '../../../packages/sdk/src/experiment-draft-storage.ts';
import * as models from '../../../packages/sdk/src/model-projects.ts';
import * as learning from '../../../packages/evals/src/learning/contracts.ts';
import * as datasetTaskIngestion from '../../../packages/sdk/src/dataset-task-ingestion.ts';
import * as datasets from '../../../packages/sdk/src/dataset-workspace-contracts.ts';
import * as estimates from '../../../packages/sdk/src/training-estimates.ts';
import * as funding from '../../../packages/sdk/src/training-funding.ts';
import * as hardwareCatalog from '../../../packages/sdk/src/training-hardware-catalog.ts';
import * as computeSelection from '../../../packages/sdk/src/training-compute-selection.ts';
import * as postTraining from '../../../packages/sdk/src/post-training.ts';
import * as candidate from '../../../packages/sdk/src/training-candidate-decisions.ts';
import * as acceptance from '../../../packages/sdk/src/training-acceptance.ts';
import * as recovery from '../../../packages/sdk/src/training-recovery.ts';
import * as toolLearning from '../../../packages/evals/src/tool-learning/index.ts';
import * as toolLearningClient from '../../../packages/sdk/src/tool-learning-client.ts';
import * as toolLearningResponses from '../../../packages/sdk/src/tool-learning-responses.ts';
import * as toolLearningEpisodes from '../../../packages/sdk/src/tool-learning-episodes.ts';
import { canonicalJson, canonicalSha256 } from '../../../packages/sdk/src/protocol.ts';
const schemas: Record<string,unknown>={};
const inputSchemas: Record<string,unknown>={};
const override=({zodSchema,jsonSchema}:any)=>{
 if(zodSchema._zod.def.type==='object'){
  const catchall=zodSchema._zod.def.catchall;
  jsonSchema['x-openpond-object-policy']=catchall===undefined?'strip':catchall._zod.def.type==='never'?'strict':'passthrough';
 }
 const overwrites=(zodSchema._zod.def.checks??[]).filter((check:any)=>check._zod.def.check==='overwrite');
 if(!overwrites.length)return;
 const transforms=overwrites.map((check:any)=>{
  const code=String(check._zod.def.tx);
  if(code==='(input) => input.trim()')return 'trim';
  if(code==='(input) => input.toLowerCase()')return 'lowercase';
  if(code==='(input) => input.toUpperCase()')return 'uppercase';
  throw Error('Unrepresentable portable overwrite');
 });
 jsonSchema['x-openpond-string-transforms']=transforms;
};
for(const module of [alphaedit,alphaeditArtifact,alphaeditDraft,alphaeditExecutions,alphaeditServing,neuronTraining,neuronTrainingArtifact,neuronTrainingResult,neuronTrainingDraft,neuronTrainingExecutions,neuronTrainingServing,weightModels,weightInference,engramAdapter,engramDraft,engramExecutions,engramInference,engramModels,engramServing,decisionModel,decisionData,decisionArtifact,decisionTraining,decisionDraft,decisionAuthoring,decisionExecutions,decisionModels,decisionScoring,decisionServing,training,trainingContracts,trainingResult,trainingModelSave,trainingModelServing,trainingModelServingControl,managedServingUsage,serverlessServing,trainingUsageFunding,trainingUsageStatus,neuronSteering,steeringSelection,steeringServing,steeringInference,residualCalibration,calibrationRecords,activationReference,funding,hardwareCatalog,computeSelection,preparation,experimentSetup,evaluationDrafts,hostedEvaluationDrafts,activationDrafts,modificationCapabilities,modificationRecordings,experimentDraftStorage,models,learning,datasets,datasetTaskIngestion,estimates,postTraining,candidate,acceptance,recovery,evaluation,datasetPreparation,datasetOperations,tasksetRuns,harness,credentials,learningIndex,learningClient,harnessClient,toolLearning,toolLearningClient,toolLearningResponses,toolLearningEpisodes]){
 for(const [name,value] of Object.entries(module)){
  if(!name.endsWith('Schema')||!(value instanceof z.ZodType))continue;
  const schema=z.toJSONSchema(value,{target:'draft-2020-12',io:'output',override});
  // These wire envelopes have no defaults or shape-changing transforms. Their
  // preprocessors only enforce JSON bounds, so input and output shapes match.
  // Zod's generic input projection would otherwise erase bounded request types.
  inputSchemas[name]=[toolLearning,toolLearningClient,toolLearningResponses,toolLearningEpisodes].includes(module as any)
   ? schema : z.toJSONSchema(value,{target:'draft-2020-12',io:'input',override});
  if(name in schemas&&canonicalJson(schemas[name])!==canonicalJson(schema))throw Error(`Conflicting wire schema ${name}`);
  schemas[name]=schema;
 }
}
const privateWire={
 DatasetWorkspaceValidateRequestSchema:z.object({expectedRevision:z.number().int().positive()}).strict(),
 DatasetPreparationCandidatePageSchema:z.object({teamId:z.string().trim().min(1).max(240),datasetId:z.string().trim().min(1).max(240),runId:z.string().trim().min(1).max(240),candidates:z.array(datasetPreparation.DatasetPreparationCandidateSchema).max(50),nextCursor:z.string().trim().min(1).max(240).nullable()}).strict(),
 DatasetPreparationOperationResultSchema:z.object({operationId:z.string().trim().min(1).max(240),requestHash:z.string().regex(/^[a-f0-9]{64}$/),run:datasetPreparation.DatasetPreparationRunSchema}).strict(),
};
for(const [name,value] of Object.entries(privateWire)){
 schemas[name]=z.toJSONSchema(value,{target:'draft-2020-12',io:'output',override});
 inputSchemas[name]=z.toJSONSchema(value,{target:'draft-2020-12',io:'input',override});
}
const resourceKinds=Object.fromEntries(Object.entries(learningIndex.learningResourceSchemas).map(([kind,value])=>{
 const name='LearningResource_'+kind+'Schema';
 schemas[name]=z.toJSONSchema(value,{target:'draft-2020-12',io:'output',override});
 inputSchemas[name]=z.toJSONSchema(value,{target:'draft-2020-12',io:'input',override});
 return [kind,name];
}));
// Actual nested dataset contract: Zod's default object strips unknown keys.
const publishedRef=(datasets.DatasetWorkspaceReceiptSchema as any).shape.workspace.shape.draft.shape.publishedTasksetRef.unwrap();
const strictRequest=privateWire.DatasetWorkspaceValidateRequestSchema;
const normalizationCases=[
 {name:'published-taskset-reference-strips',schema:publishedRef,input:{id:' taskset-fixture ',revision:1,contentHash:'abcdefgh',unknown:'discarded'}},
 {name:'event-data-record-preserves',schema:training.TrainingJobEventSchema.shape.data,input:{unknown:{retained:true}}},
 {name:'workspace-validation-strict',schema:strictRequest,input:{expectedRevision:1,unknown:'rejected'}},
];
const normalizationVectors=normalizationCases.map(({name,schema,input})=>{
 const parsed=schema.safeParse(input);
 return {name,schema:z.toJSONSchema(schema,{target:'draft-2020-12',io:'output',override}),input,accepted:parsed.success,...(parsed.success?{output:parsed.data}:{})};
});
const values=['\ud83d\ude00','\ud800',JSON.parse('{"__proto__":{"retained":true},"ordinary":1}'),{'10':1,'2':2,'01':3,'4294967294':4,'4294967295':5},'\ud800',null,{omitted:'kept',present:null},{unicode:'雪😀é',keys:{'😀':1,'\uE000':2}},[-0,0,1,0.000001,1e-7,1e20,1e21,9007199254740991,1000000000000000100],{nested:[true,false,{b:2,a:1}]}];
const vectors=await Promise.all(values.map(async value=>({value,canonical:canonicalJson(value),sha256:await canonicalSha256(value)})));
const root=new URL('../../../packages/sdk/fixtures/python-foundation/',import.meta.url);
await mkdir(root,{recursive:true});
const generator=await readFile(import.meta.url.startsWith('file:')?new URL(import.meta.url):import.meta.url,'utf8');
const sourcePaths=[...generator.matchAll(/from '(\.\.\/\.\.\/\.\.\/packages\/[^']+)'/g)].map(match=>match[1]!);
const sourceFiles=Object.fromEntries(await Promise.all([...new Set(sourcePaths)].sort().map(async path=>[path.replace('../../../',''),createHash('sha256').update(await readFile(new URL(path,import.meta.url))).digest('hex')])));
const sdkMetadata=JSON.parse(await readFile(new URL('../../../packages/sdk/package.json',import.meta.url),'utf8'));
const pythonProject=await readFile(new URL('../pyproject.toml',import.meta.url),'utf8');
const pythonVersion=/^version = "([0-9]+\.[0-9]+\.[0-9]+)"$/m.exec(pythonProject)?.[1];
if(!pythonVersion)throw Error('Missing stable Python package version.');
const provenance={sourceBase:'0bf7b6be48ae1d3a94f1266d41c695c992d05b48',candidateSdkVersion:sdkMetadata.version,pythonVersion,sourceFiles};
// Lossless transport interning only: expand before interpreting any JSON Schema.
// Every source object is a reference, so source keys cannot collide with tags.
// Child-first references preserve root-local $refs and original property order.
function internJson(value: unknown): unknown {
 const objects: Record<string,unknown>[]=[];
 const known=new Map<string,number>();
 function encode(item: unknown): unknown {
  if(Array.isArray(item))return item.map(encode);
  if(item===null||typeof item!=='object')return item;
  const body=Object.fromEntries(Object.entries(item).map(([key,child])=>[key,encode(child)]));
  const signature=JSON.stringify(body);
  let index=known.get(signature);
  if(index===undefined){index=objects.length;known.set(signature,index);objects.push(body);}
  return {$object:index};
 }
 const root=encode(value);
 return {schemaVersion:'openpond.internedJson.v1',root,objects};
}
const bytes=JSON.stringify(internJson({schemaVersion:'openpond.pythonWireSchemas.v1',provenance,schemas,inputSchemas,resourceKinds}),null,2)+'\n';
await writeFile(new URL('schemas.json',root),bytes);
const normalizationBytes=JSON.stringify({schemaVersion:'openpond.wireNormalization.v1',vectors:normalizationVectors},null,2)+'\n';
await writeFile(new URL('wire-normalization.json',root),normalizationBytes);
await writeFile(new URL('../src/ponder_sdk/wire-normalization.json',import.meta.url),normalizationBytes);
const identityBytes=JSON.stringify({schemaVersion:'openpond.canonicalIdentities.v1',vectors},null,2)+'\n';
await writeFile(new URL('canonical-identities.json',root),identityBytes);
await writeFile(new URL('../src/ponder_sdk/canonical-identities.json',import.meta.url),identityBytes);
await mkdir(new URL('../src/ponder_sdk/fixtures/',import.meta.url),{recursive:true});
await writeFile(new URL('../src/ponder_sdk/fixtures/policy-optimize.valid.json',import.meta.url),await readFile(new URL('../../../packages/sdk/fixtures/training/v2/policy-optimize.valid.json',import.meta.url)));
await writeFile(new URL('../src/ponder_sdk/schemas.json',import.meta.url),bytes);
console.log(JSON.stringify({schemaCount:Object.keys(schemas).length,sha256:createHash('sha256').update(bytes).digest('hex')}));
