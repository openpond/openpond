"""Failure story: a lost admission reply must not duplicate a job, and neither
client may accept a different workspace/plan merely because the HTTP call worked.
Uses real HTTP sockets and the packaged clients, not patched request methods.
"""
from __future__ import annotations
import asyncio
import copy
import json
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from importlib.resources import files
import threading
import time
from datetime import datetime, timedelta, timezone
import pytest
from ponder_sdk import Client,AsyncClient,PonderError,ProtocolError,canonical_sha256,canonical_json

SOURCE=json.loads(files('ponder_sdk').joinpath('fixtures/policy-optimize.valid.json').read_text())['source']
TEAM='team-fixture'
CREDENTIAL={'action':'create','scope':TEAM,'sourceId':'source-fixture','name':'fixture','expiresAt':'2027-01-01T00:00:00Z','operationId':'credential-operation','apiKey':'opk_key_'+'a'*16+'_'+'b'*48}
REQUEST={'schemaVersion':'openpond.trainingPreparationRequest.v1','teamId':TEAM,'operationId':'operation-fixture','projectId':None,'configuration':{'id':SOURCE['modelProject']['id'],'expectedRevision':3,'expectedEtag':'a'*64},'batch':{'id':'batch-fixture','revision':1,'contentHash':'b'*64},'name':'A reviewed batch','maximumSpendUsd':1,'parent':{'jobId':'parent-job','artifact':{'id':'parent-artifact','contentHash':'d'*64},'checkpointId':'parent-checkpoint','adapterMode':'shared'}}

def receipt(request):
    plan={'schemaVersion':'openpond.trainingPreparationPlan.v1','id':'prep-fixture','creatorUserId':'user-fixture','request':request,'requestHash':canonical_sha256(request),'source':SOURCE,'submissionHash':'c'*64,'createdAt':'2026-10-23T12:00:00Z'}
    if request.get('usageFunding') is not None:
        price={'schemaVersion':'openpond.computeAppliedPrice.v1','version':'fixture-retail-v1','service':'managed_rl',
               'profileHash':'a'*64,'currency':'USD','unit':'resource_hour','hourlyUsd':'2.000000'}
        quote={'schemaVersion':'openpond.trainingUsageQuote.v1','teamId':request['teamId'],'actorUserId':plan['creatorUserId'],
               'preparationId':plan['id'],'submissionHash':plan['submissionHash'],'workerImageDigest':'sha256:'+'d'*64,
               'customerCapUsd':request['usageFunding']['customerCapUsd'],'maximumWallSeconds':3600,'retentionDays':7,
               'gpu':price,'guests':[],
               'judges':{'billing':'existing_retail_child_captures','acceptedPricingHashes':['b'*64],
                         'prices':[{'modelId':'judge-fixture','displayName':'Judge fixture','acceptedPricingHash':'b'*64,
                                    'inputUsdPerMillionTokens':'1.000000','cachedInputUsdPerMillionTokens':'0.100000',
                                    'outputUsdPerMillionTokens':'2.000000','cacheWriteUsdPerMillionTokens':None,
                                    'cacheWriteOneHourUsdPerMillionTokens':None,'longContextThresholdTokens':None,'longContext':None}]},
               'storage':{'price':{**price,'hourlyUsd':'0.000045'},'storageClass':'STANDARD','quantityBasis':'gib_milliseconds',
                          'onCreditExhaustion':'retain_objects_and_stop_new_storage'},
               'gpuBillingBoundary':'active_allocation_until_verified_cleanup','storageBillingBoundary':'accepted_retention_window',
               'startupBillable':True,'postCompletionIdleBillable':False,'minimumBillableSeconds':0,
               'issuedAt':'2026-10-23T12:00:00Z','expiresAt':'2026-10-23T12:10:00Z'}
        plan['usageQuote']={**quote,'contentHash':canonical_sha256(quote),'signature':'fixture-only-signature'}
    return {'schemaVersion':'openpond.trainingPreparationReceipt.v1','plan':{**plan,'contentHash':canonical_sha256(plan)},'revision':1,'state':'prepared','jobId':None}

@pytest.fixture
def server():
    state={'receipt':None,'posts':0,'tool_posts':0,'tool_reply':'valid','draft':None,'draft_ops':{},'draft_mutations':0}
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*_):pass
        def reply(self,status,value):
            raw=json.dumps(value).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers()
            try:self.wfile.write(raw)
            except (BrokenPipeError,ConnectionResetError):pass
        def auth(self):
            assert self.headers['Authorization']=='Bearer secret-fixture'
            assert self.headers['X-OpenPond-Team-Id']==TEAM
            assert self.headers['Accept']==('application/json' if self.path.startswith(('/v1/model-projects/configuration/','/v1/tool-learning/')) else 'application/vnd.openpond.training+json;version=2')
        def do_POST(self):
            self.auth()
            if self.path.startswith('/v1/training/modification-executions/'):
                data=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                assert self.headers['Content-Type']=='application/vnd.openpond.training+json;version=2'
                state['modification_posts']=state.get('modification_posts',0)+1
                if self.path.endswith('/compile'):
                    content={'schemaVersion':'openpond.managedModificationCompilation.v1','teamId':TEAM,'actorId':'user-fixture',
                        'projectId':data['projectId'],'method':data['method'],'query':data['query'],'formHash':canonical_sha256(data['form']),
                        'request':state['compiled_request'],'inputHash':canonical_sha256(state['compiled_request'])}
                    if state.get('compile_forged'):content['formHash']='d'*64
                    self.reply(200,{**content,'contentHash':canonical_sha256(content)});return
                operations=state.setdefault('modification_operations',{})
                value=operations.get(data['operationId'])
                if value is None:
                    preparing=self.path.endswith('/prepare')
                    if preparing:
                        state['modification_state']={'id':'modification-'+canonical_sha256({'teamId':TEAM,'ownerUserId':'user-fixture','operationId':data['operationId']}),
                            'teamId':TEAM,'ownerUserId':'user-fixture','projectId':data['projectId'],'name':data['name'],'method':data['method'],
                            'phase':'prepared','revision':1,'sourceContentHash':'a'*64,
                            'plan':{'contentHash':'b'*64,'inputHash':canonical_sha256(data['request']),'runtimeHash':'c'*64,'maximumSpendUsd':data['maximumSpendUsd'],
                                'createdAt':'2026-11-01T00:00:00Z','expiresAt':'2026-11-01T00:05:00Z'},'updatedAt':'2026-11-01T00:00:00Z'}
                    else:
                        assert self.path==f"/v1/training/modification-executions/{data['id']}/{data['action']}"
                        state['modification_state']={**state['modification_state'],'phase':'queued' if data['action']=='start' else 'cancelled','revision':data['expectedRevision']+1}
                    content={'schemaVersion':'openpond.managedModificationExecutionReceipt.v1','operationId':data['operationId'],
                        'requestHash':canonical_sha256({'action':'prepare','command':data} if preparing else data),'execution':copy.deepcopy(state['modification_state'])}
                    value={**content,'contentHash':canonical_sha256(content)};operations[data['operationId']]=value
                if state.get('modification_drop'):
                    state['modification_drop']=False;self.connection.shutdown(2);self.connection.close();return
                value=copy.deepcopy(value)
                if state.get('modification_forged'):
                    value['execution']['revision']+=1
                    value['contentHash']=canonical_sha256({key:item for key,item in value.items() if key!='contentHash'})
                self.reply(200,value);return
            if self.path == '/v1/modification-recordings':
                data=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                assert data==state['recording_command']
                state['recording_posts']=state.get('recording_posts',0)+1
                self.reply(201,state['recording_read']['recording']);return
            if self.path == '/v1/training/models/hosted-project-fixture/serving':
                data=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                assert data==state['serving_control_request']
                assert self.headers['Content-Type']=='application/vnd.openpond.training+json;version=2'
                state['serving_control_calls'].append(data)
                if state.get('serving_control_drop'):
                    state['serving_control_drop']=False
                    self.connection.shutdown(2);self.connection.close();return
                self.reply(200,state['serving_control_reply']);return
            if self.path == '/v1/training/jobs/job-fixture/model':
                data=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                assert data==state['model_save_command']['request']
                assert self.headers['Content-Type']=='application/vnd.openpond.training+json;version=2'
                state['model_save_calls'].append(data)
                if state.get('model_save_drop'):
                    state['model_save_drop']=False
                    self.connection.shutdown(2);self.connection.close();return
                self.reply(200,state['model_save_reply']);return
            if self.path == '/v1/training/dataset-reviews':
                data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                assert data == state['dataset_review_request']
                assert self.headers['Content-Type'] == 'application/vnd.openpond.training+json;version=2'
                state['dataset_review_posts'] = state.get('dataset_review_posts', 0)+1
                value = copy.deepcopy(state['dataset_review'])
                mode = state.get('dataset_review_reply', 'valid')
                if mode == 'dataset': value['dataset']['contentHash'] = 'e'*64
                if mode == 'team': value['teamId'] = 'other-team'
                if mode == 'operation': value['operationId'] = 'other-operation'
                if mode == 'id': value['id'] = 'another-receipt'
                if mode == 'request': value['requestHash'] = 'e'*64
                if mode == 'inventory': value['evidence'].append(value['evidence'][0])
                if mode == 'sharing': value['shareWithWorkspace'] = False
                value['contentHash'] = 'e'*64 if mode == 'hash' else canonical_sha256({key: item for key,item in value.items() if key!='contentHash'})
                self.reply(200,value); return
            if self.path.startswith('/v1/training/funding/'):
                handoff = self.path.endswith('/handoff')
                request = state['funding_handoff_request' if handoff else 'funding_request']
                data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                assert data == request
                assert self.headers['Content-Type'] == 'application/vnd.openpond.training+json;version=2'
                value = copy.deepcopy(state['funding_handoff' if handoff else 'funding'])
                mode = state.get('funding_reply', 'valid')
                if mode == 'cap': value['maximumSpendUsd'] += 1
                if mode == 'draft': value['draft']['contentHash'] = 'e'*64
                if mode == 'team': value['teamId'] = 'other-team'
                if mode == 'hash': value['requestHash'] = 'e'*64
                if mode == 'expiry':
                    value['checkedAt'] = (datetime.now(timezone.utc)-timedelta(seconds=120)).isoformat().replace('+00:00','Z')
                    value['expiresAt'] = (datetime.now(timezone.utc)-timedelta(seconds=60)).isoformat().replace('+00:00','Z')
                if mode == 'privacy': value['availableUsageUsd'] = '999'
                if mode == 'url': value['billingUrl'] += '?redirect=https://elsewhere.example'
                if mode == 'permission': value['canPurchase'] = False
                self.reply(200,value); return
            if self.path == '/v1/training/estimates':
                data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                assert data == state['estimate_request']
                value = copy.deepcopy(state['estimate'])
                mode = state.get('estimate_reply', 'valid')
                if mode == 'source': value['source']['contentHash'] = 'e'*64
                if mode == 'review': value['review']['inputHash'] = 'e'*64
                if mode == 'request': value['requestHash'] = value['review']['requestHash'] = 'e'*64
                if mode == 'expiry':
                    value['createdAt'] = (datetime.now(timezone.utc)-timedelta(seconds=120)).isoformat()
                    value['expiresAt'] = value['review']['expiresAt'] = (datetime.now(timezone.utc)-timedelta(seconds=60)).isoformat()
                if mode == 'count': value['gpu']['resolved']['gpuCount'] = 2
                if mode == 'range': value['executionSeconds']['planningRange'] = dict(low=300, high=100)
                if mode == 'workload_rows': value['workload']['trainingRows']['total'] += 1
                self.reply(200,value); return
            if self.path=='/v1/tool-learning/consultations':
                state['tool_posts']+=1
                request=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                assert self.headers['Content-Type']=='application/json'
                assert request==TOOL['request']
                if state['tool_reply']=='lost':
                    self.connection.shutdown(2);self.connection.close();return
                response=copy.deepcopy(TOOL['response'])
                if state['tool_reply']=='wrong-identity':response['modelRelease']['contentHash']='0'*64
                self.reply(200,response);return
            if self.path.startswith('/v1/training/experiment-drafts'):
                data=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                prior=state['draft_ops'].get(data['operationId'])
                if prior is not None:self.reply(200,prior);return
                current=state['draft'];archive=self.path.endswith('/archive')
                if (current['revision'] if current else 0)!=data['expectedRevision']:
                    self.reply(409,{'code':'revision_conflict','message':'Newer draft'});return
                content={'schemaVersion':'openpond.experimentDraftRecord.v1','id':'draft-fixture','teamId':TEAM,'ownerUserId':'actor-fixture',
                    'projectId':current['projectId'] if archive else data['projectId'],'draft':current['draft'] if archive else data['draft'],
                    'revision':data['expectedRevision']+1,'status':'archived' if archive else 'draft',
                    'createdAt':'2026-10-31T00:00:00.000Z','updatedAt':'2026-10-31T00:00:00.000Z'}
                row={**content,'contentHash':canonical_sha256(content)}
                result={'schemaVersion':'openpond.experimentDraftReceipt.v1','operationId':data['operationId'],
                    'requestHash':canonical_sha256({'id':row['id'],**data} if archive else data),'record':row}
                state['draft']=row;state['draft_ops'][data['operationId']]=result;state['draft_mutations']+=1
                self.reply(200,result);return
            state['posts']+=1
            data=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            if self.path=='/v1/training/preparations/from-draft':
                run={k:v for k,v in data.items() if k not in ('schemaVersion','baseModel','settings')}
                prepared=receipt({**run,'schemaVersion':REQUEST['schemaVersion'],'configuration':REQUEST['configuration']})
                plan=prepared['plan'];plan['source']=copy.deepcopy(SOURCE)
                plan['source']['modelProject']['portableProjectId']='experiment-'+canonical_sha256({'teamId':TEAM,'operationId':data['operationId'],'creatorUserId':plan['creatorUserId']})
                plan['source']['modelProject']['contentHash']=REQUEST['configuration']['expectedEtag']
                if state.get('setup_reply')=='changed_cap':plan['request']['maximumSpendUsd']+=1
                plan['requestHash']=canonical_sha256(plan['request'])
                plan['contentHash']=canonical_sha256({k:v for k,v in plan.items() if k!='contentHash'})
                self.reply(201,{'schemaVersion':'openpond.trainingExperimentSetupReceipt.v1','request':data,'requestHash':canonical_sha256(data),'preparation':prepared});return
            if self.path=='/v1/training/preparations':
                state['receipt']=receipt(data)
                # Admission was durably retained, but its reply never arrives.
                self.connection.shutdown(2);self.connection.close();return
            retained=state['receipt']
            if self.path.endswith('/start') and retained['plan'].get('usageQuote') is not None:
                assert data.get('usageQuoteHash')==retained['plan']['usageQuote']['contentHash']
            if data['expectedRevision']!=retained['revision']:
                self.reply(409,{'code':'revision_conflict','error':'private upstream content secret-fixture'});return
            retained={**retained,'revision':retained['revision']+1,'state':'submitted' if self.path.endswith('/start') else 'cancelled','jobId':'job-fixture' if self.path.endswith('/start') else None}
            state['receipt']=retained;self.reply(200,retained)
        def do_GET(self):
            self.auth()
            if self.path.startswith('/v1/training/modification-executions?'):
                self.reply(200,state['managed_history']);return
            if self.path.startswith('/v1/training/modification-executions/execution-fixture?'):
                self.reply(200,state['managed_modification']);return
            if self.path.startswith('/v1/modification-recordings'):
                value=copy.deepcopy(state['recording_page' if self.path.startswith('/v1/modification-recordings?') else 'recording_read'])
                if state.get('recording_reply')=='capture' and 'document' in value:value['document']['result']['captures'][0]['after']+=1
                if state.get('recording_reply')=='scope' and 'items' in value:value['teamId']='another-team'
                self.reply(200,value);return
            if self.path.startswith('/v1/training/modification-capabilities?'):
                from urllib.parse import urlsplit,parse_qs
                query={k:v[0] for k,v in parse_qs(urlsplit(self.path).query).items()}
                now=datetime.now(timezone.utc)
                if state.get('capability_reply')=='scope':query['revision']='another-model-revision'
                if state.get('capability_reply')=='expired':now-=timedelta(minutes=10)
                methods=[{'method':method,'draftSchema':'openpond.experimentDraft.v1','validationLevel':None,'execution':{'state':'unavailable','code':'runtime_not_qualified','reason':'No qualified runtime.'}} for method in ('neuron_steering','inspect_activations')]
                if state.get('capability_reply')=='method':methods[1]=methods[0]
                content={'schemaVersion':'openpond.modelModificationCapabilities.v1','teamId':TEAM,'actorId':'user-fixture','query':query,
                    'requestHash':canonical_sha256(query),'destination':'hosted','checkedAt':now.isoformat().replace('+00:00','Z'),'expiresAt':(now+timedelta(minutes=5)).isoformat().replace('+00:00','Z'),'methods':methods}
                self.reply(200,{**content,'contentHash':canonical_sha256(content)});return
            if self.path.startswith('/v1/training/models/hosted-project-fixture/serving?'):
                from urllib.parse import urlsplit,parse_qs
                query={k:v[0] for k,v in parse_qs(urlsplit(self.path).query).items()}
                assert query==state['model_serving_query']
                self.reply(200,state['model_serving']);return
            if self.path.startswith('/v1/training/steering-profiles/steering-http-fixture?'):
                from urllib.parse import urlsplit,parse_qs
                assert parse_qs(urlsplit(self.path).query)=={'teamId':[TEAM]}
                self.reply(200,state['steering_profile']);return
            if self.path.startswith('/v1/training/models/hosted-project-fixture/version?'):
                from urllib.parse import urlsplit,parse_qs
                assert parse_qs(urlsplit(self.path).query)=={'teamId':[TEAM]}
                self.reply(200,{**state['saved_model'],'schemaVersion':'openpond.savedModelVersionRead.v1'});return
            if self.path.startswith('/v1/training/models/hosted-project-fixture?'):
                self.reply(200,state['saved_model']);return
            if self.path=='/v1/training/jobs/job-fixture/result':
                self.reply(200,state['training_result']);return
            if self.path.startswith('/v1/training/gpu-catalog?'):
                from urllib.parse import urlsplit,parse_qs
                query={k:v[0] for k,v in parse_qs(urlsplit(self.path).query).items()}
                query['gpuCount']=int(query['gpuCount']);query['loraRank']=int(query['loraRank'])
                assert query['teamId']==TEAM
                now=datetime.now(timezone.utc)
                value={'schemaVersion':'openpond.trainingGpuCatalog.v1','observedAt':now.isoformat(),'expiresAt':(now+timedelta(seconds=60)).isoformat(),
                    'workerImageDigest':'sha256:'+'a'*64,'supportedLoraRanks':[16],'pricingBasis':'provider_catalog_compute_and_disk_before_credits',
                    'scope':{'query':query,'requestHash':canonical_sha256(query),'qualification':'requires_preparation','reason':None,
                        'provider':{'accountScopeId':'opaque-scope','product':'POD','cloud':'SECURE','countryCodes':['US','CA'],
                            'cudaVersions':['12.8'],'dataCenterId':None,'minimumDiskGb':130,'priceBasis':'provider_catalog_per_gpu_rate_times_count'}},
                    'offerings':[{'availabilityId':'offer','gpuType':'gpu','provider':'fixture_provider','region':'fixture_region','dataCenterId':None,
                        'gpuCount':2,'gpuMemoryGb':80,'stockStatus':'Medium','computeHourlyUsd':4,'diskHourlyUsd':0.01,'totalHourlyUsd':4.01}]}
                if state.get('gpu_reply')=='hash':value['scope']['requestHash']='0'*64
                if state.get('gpu_reply')=='count':value['offerings'][0]['gpuCount']=1
                if state.get('gpu_reply')=='expired':value['expiresAt']=value['observedAt']
                if state.get('gpu_reply')=='missing':del value['scope']
                self.reply(200,{'catalog':value});return
            if self.path=='/v1/training/hardware-catalog':
                content={'schemaVersion':'openpond.trainingHardwareInventory.v1','provider':'fixture_provider','source':'fixture_inventory_v1',
                    'hardware':[{'id':'gpu-new','name':'New GPU','manufacturer':'NVIDIA','memoryGb':192,
                        'secureCloud':True,'communityCloud':False,'maximumPerPod':{'secure':8,'community':0}}]}
                value={'schemaVersion':'openpond.trainingHardwareCatalog.v1','workerImageDigest':'sha256:'+'a'*64,
                    'inventory':{**content,'version':canonical_sha256(content),'observedAt':'2026-10-31T00:00:00.000Z','refreshAfter':'2026-11-01T00:00:00.000Z'},
                    'eligibility':[{'gpuTypeId':'gpu-new','status':'not_admitted','reason':'gpu_type_not_enabled'}]}
                if state.get('hardware_reply')=='hash':value['inventory']['hardware'][0]['memoryGb']=256
                if state.get('hardware_reply')=='gpu':value['eligibility'][0]['gpuTypeId']='another-gpu'
                self.reply(200,value);return
            if self.path.startswith('/v1/training/experiment-drafts'):
                from urllib.parse import urlsplit,parse_qs
                url=urlsplit(self.path);query=parse_qs(url.query)
                assert query['teamId']==[TEAM]
                row=copy.deepcopy(state['draft'])
                if state.get('draft_reply')=='hash':row['draft']['name']='Substituted settings'
                if state.get('draft_reply')=='owner':
                    row['ownerUserId']='another-owner';row['contentHash']=canonical_sha256({k:v for k,v in row.items() if k!='contentHash'})
                if state.get('draft_reply')=='trained-version':
                    row['draft']['startingModel']['trainedVersion']['candidate']['checkpointId']='substituted-checkpoint'
                    row['contentHash']=canonical_sha256({k:v for k,v in row.items() if k!='contentHash'})
                self.reply(200,row if url.path.endswith('/draft-fixture') else {'schemaVersion':'openpond.experimentDraftPage.v1','teamId':TEAM,
                    'ownerUserId':'actor-fixture','projectId':query.get('projectId',[None])[0],'items':[row],'nextCursor':None});return
            if self.path.startswith('/v1/training/executions?'):
                from urllib.parse import urlsplit,parse_qs
                query=parse_qs(urlsplit(self.path).query)
                assert query['projectId']==['project-fixture'] and query['limit']==['1']
                job={'schemaVersion':'openpond.trainingJob.v2','id':'job-fixture','teamId':TEAM,'kind':'policy_optimize','modelProjectId':'model-fixture','portableProjectId':'model-fixture','sourceProjectRevision':1,'submissionHash':'a'*64,'state':'queued','phase':'queued','version':0,'progress':0,'rolloutProgress':{'groupsCompleted':0,'groupsTarget':1,'optimizerUpdatesApplied':0,'optimizerUpdatesSkipped':0},'accruedSpendUsd':0,'terminalReason':None,'createdAt':'2026-10-31T00:00:00Z','updatedAt':'2026-10-31T00:00:00Z','completedAt':None}
                job['usage']={'schemaVersion':'openpond.trainingUsageSnapshot.v1','asOf':job['updatedAt'],
                              'customerCapUsd':'3.000000','chargedUsd':'0.000000','committedUsd':'0.100000',
                              'outstandingUsd':'0.100000','remainingCapUsd':'2.900000','availableCreditUsd':'5.000000','complete':False,
                              'components':[{'component':component,'chargedUsd':'0.000000',
                                             'committedUsd':'0.100000' if component=='gpu' else '0.000000',
                                             'outstandingUsd':'0.100000' if component=='gpu' else '0.000000',
                                             'openOwners':1 if component=='gpu' else 0} for component in ('gpu','guest','storage','judge')]}
                if state.get('history_reply')=='usage_component':job['usage']['components'][1]['component']='gpu'
                if state.get('history_reply')=='wrong-team':job['teamId']='other-team'
                self.reply(200,{'schemaVersion':'openpond.trainingExecutionPage.v1','teamId':TEAM,'projectId':'project-fixture','items':[{'schemaVersion':'openpond.trainingExecutionSummary.v1','job':job,'name':'Training','method':'sft','model':None,'dataset':None,'startedAt':None}],'nextCursor':None});return
            if self.path.startswith('/v1/tool-learning/installations?'):
                assert self.path.endswith('projectId=project-fixture')
                item=copy.deepcopy(TOOL['installation'])
                if state['tool_reply']=='wrong-project':item['scope']['projectId']='another-project'
                self.reply(200,{'items':[item],'nextCursor':None});return
            if self.path=='/v1/tool-learning/installations/installation-fixture/consultations/consultation-fixture':
                self.reply(200,TOOL['response']);return
            if self.path=='/v1/model-projects/configuration/candidates':
                self.reply(200,{'candidates':[]});return
            if self.path.endswith('/slow'):time.sleep(.15)
            value=copy.deepcopy(state['receipt'])
            if state.get('preparation_reply')=='quote_cap':
                quote=value['plan']['usageQuote']
                quote['customerCapUsd']='4.000000'
                quote['contentHash']=canonical_sha256({k:v for k,v in quote.items() if k not in ('contentHash','signature')})
                value['plan']['contentHash']=canonical_sha256({k:v for k,v in value['plan'].items() if k!='contentHash'})
            if self.path.endswith('/wrong-team'):
                value['plan']['request']['teamId']='another-team'
                value['plan']['requestHash']=canonical_sha256(value['plan']['request'])
                value['plan']['contentHash']=canonical_sha256({k:v for k,v in value['plan'].items() if k!='contentHash'})
                value['plan']['id']='wrong-team'
                value['plan']['contentHash']=canonical_sha256({k:v for k,v in value['plan'].items() if k!='contentHash'})
            if '?' in self.path:value={'schemaVersion':'openpond.trainingPreparationPage.v1','teamId':TEAM,'items':[value],'nextCursor':None}
            self.reply(200,value)
    http=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
    try:yield f'http://127.0.0.1:{http.server_port}',state
    finally:http.shutdown();http.server_close();thread.join(timeout=2)

def test_sync_and_async_native_admission_boundary(server):
    url,state=server
    for asynchronous in (False,True):
        state['receipt']=None;state['posts']=0
        priced_request={**REQUEST,'usageFunding':{'schemaVersion':'openpond.trainingUsageFundingRequest.v1',
                                                'billingMode':'actual_usage','customerCapUsd':'3.000000'}}
        if asynchronous:
            async def run():
                async with AsyncClient(base_url=url,api_key='secret-fixture',team_id=TEAM,read_attempts=1) as client:
                    assert await client.models.configuration_candidates()==[]
                    with pytest.raises(ProtocolError):await client.learning.list_source_credentials(CREDENTIAL)
                    assert state['posts']==0
                    with pytest.raises(PonderError) as error:await client.training.prepare_run(priced_request)
                    assert error.value.outcome_unknown and state['posts']==1
                    retained=await client.training.get_preparation('prep-fixture')
                    assert retained['plan']['usageQuote']['judges']['prices'][0]['modelId']=='judge-fixture'
                    page=await client.training.list_preparations({'limit':1})
                    assert page['items']==[retained]
                    with pytest.raises(ProtocolError):await client.training.get_preparation('wrong-team')
                    state['preparation_reply']='quote_cap'
                    with pytest.raises(ProtocolError):await client.training.get_preparation('prep-fixture')
                    state['preparation_reply']='valid'
                    control={'teamId':TEAM,'planHash':retained['plan']['contentHash'],'expectedRevision':1,
                             'usageQuoteHash':retained['plan']['usageQuote']['contentHash']}
                    started=await client.training.start_preparation('prep-fixture',control)
                    assert started['jobId']=='job-fixture'
                    with pytest.raises(PonderError) as stale:await client.training.start_preparation('prep-fixture',control)
                    assert stale.value.status==409 and 'secret' not in str(stale.value)
                async with AsyncClient(base_url=url,api_key='secret-fixture',team_id=TEAM,timeout=.03,read_attempts=1) as client:
                    with pytest.raises(PonderError) as slow:await client.training.get_preparation('slow')
                    assert slow.value.code in ('request_deadline','transport_failed')
            asyncio.run(run())
        else:
            with Client(base_url=url,api_key='secret-fixture',team_id=TEAM,read_attempts=1) as client:
                assert client.models.configuration_candidates()==[]
                with pytest.raises(ProtocolError):client.learning.list_source_credentials(CREDENTIAL)
                assert state['posts']==0
                with pytest.raises(PonderError) as error:client.training.prepare_run(priced_request)
                assert error.value.outcome_unknown and state['posts']==1
                retained=client.training.get_preparation('prep-fixture')
                assert retained['plan']['usageQuote']['customerCapUsd']=='3.000000'
                assert client.training.list_preparations({'limit':1})['items']==[retained]
                with pytest.raises(ProtocolError):client.training.get_preparation('wrong-team')
                state['preparation_reply']='quote_cap'
                with pytest.raises(ProtocolError):client.training.get_preparation('prep-fixture')
                state['preparation_reply']='valid'
                control={'teamId':TEAM,'planHash':retained['plan']['contentHash'],'expectedRevision':1,
                         'usageQuoteHash':retained['plan']['usageQuote']['contentHash']}
                assert client.training.start_preparation('prep-fixture',control)['jobId']=='job-fixture'
                with pytest.raises(PonderError) as stale:client.training.start_preparation('prep-fixture',control)
                assert stale.value.status==409 and 'secret' not in str(stale.value)
        assert state['posts']==3

def test_model_first_draft_preserves_reviewed_inputs_in_both_clients(server):
    # A correctly hashed but increased preparation cap must fail in both clients.
    url,state=server
    fixture=json.loads(files('ponder_sdk').joinpath('fixtures/policy-optimize.valid.json').read_text())
    draft={**{k:v for k,v in REQUEST.items() if k not in ('schemaVersion','configuration')},
           'schemaVersion':'openpond.trainingExperimentSetupRequest.v1',
           'baseModel':fixture['job']['baseModel'],'settings':{'method':'grpo','recipe':fixture['job']['recipe']}}
    with Client(base_url=url,api_key='secret-fixture',team_id=TEAM) as client:
        result=client.training.prepare_experiment(draft)
        assert result['preparation']['state']=='prepared' and result['preparation']['jobId'] is None
        state['setup_reply']='changed_cap'
        with pytest.raises(ProtocolError):client.training.prepare_experiment(draft)
    async def run():
        async with AsyncClient(base_url=url,api_key='secret-fixture',team_id=TEAM) as client:
            state['setup_reply']='valid'
            assert (await client.training.prepare_experiment(draft))['preparation']['state']=='prepared'
            state['setup_reply']='changed_cap'
            with pytest.raises(ProtocolError):await client.training.prepare_experiment(draft)
    asyncio.run(run())
    assert state['posts']==4

def test_training_history_scope_in_sync_and_async_clients(server):
    # Both native clients must reject a foreign job inside an otherwise valid page.
    url,state=server
    query={'projectId':'project-fixture','limit':1}
    with Client(base_url=url,api_key='secret-fixture',team_id=TEAM) as client:
        job=client.training.list_executions(query)['items'][0]['job']
        assert job['id']=='job-fixture' and job['usage']['outstandingUsd']=='0.100000'
        state['history_reply']='usage_component'
        with pytest.raises(ProtocolError):client.training.list_executions(query)
        state['history_reply']='wrong-team'
        with pytest.raises(ProtocolError):client.training.list_executions(query)
    async def run():
        async with AsyncClient(base_url=url,api_key='secret-fixture',team_id=TEAM) as client:
            state['history_reply']='valid'
            assert (await client.training.list_executions(query))['items'][0]['method']=='sft'
            state['history_reply']='usage_component'
            with pytest.raises(ProtocolError):await client.training.list_executions(query)
            state['history_reply']='wrong-team'
            with pytest.raises(ProtocolError):await client.training.list_executions(query)
    asyncio.run(run())
    retained=json.loads((Path(__file__).resolve().parents[3]/'packages/sdk/fixtures/python-foundation/training-result-http-workflow.json').read_text())
    # The same immutable result crosses both installed native HTTP clients.
    invalid=[]
    for mode in ('job','team','source','checkpoint','inventory','receipt','cleanup','composition','hash'):
        value=copy.deepcopy(retained)
        if mode=='job':value['job']['id']='another-job'
        if mode=='team':value['teamId']=value['job']['teamId']='another-team'
        if mode=='source':value['request']['source']['modelProject']['revision']+=1
        if mode=='checkpoint':value['candidate']['checkpointId']='another-checkpoint'
        if mode=='inventory':value['outputs']['outputs'].append(value['outputs']['outputs'][0])
        if mode=='receipt':value['outputs']['receipt']['outputs'][0]['contentHash']='e'*64
        if mode=='cleanup':value['outputs']['receipt']['cleanupComplete']=False
        if mode=='composition':value['candidate']['composition']='shared'
        value['contentHash']='e'*64 if mode=='hash' else canonical_sha256({k:v for k,v in value.items() if k!='contentHash'})
        invalid.append(value)
    with Client(base_url=url,api_key='secret-fixture',team_id=TEAM,read_attempts=1) as client:
        state['training_result']=retained
        assert client.training.result('job-fixture')['candidate']['artifact']['id']=='artifact-fixture'
        for value in invalid:
            state['training_result']=value
            with pytest.raises(ProtocolError):client.training.result('job-fixture')
    async def results():
        async with AsyncClient(base_url=url,api_key='secret-fixture',team_id=TEAM,read_attempts=1) as client:
            state['training_result']=retained
            assert (await client.training.result('job-fixture'))['candidate']['artifact']['id']=='artifact-fixture'
            for value in invalid:
                state['training_result']=value
                with pytest.raises(ProtocolError):await client.training.result('job-fixture')
    asyncio.run(results())
    assert state['posts']==0

def test_shared_identity_vectors_and_number_refusal():
    from ponder_sdk.transport import finite_int,finite_float
    vectors=json.loads(files('ponder_sdk').joinpath('canonical-identities.json').read_text(),parse_int=finite_int,parse_float=finite_float)['vectors']
    for vector in vectors:
        assert canonical_json(vector['value'])==vector['canonical']
        assert canonical_sha256(vector['value'])==vector['sha256']
    assert canonical_json('\ud83d\ude00')=='"😀"'
    with pytest.raises(ProtocolError):canonical_json(10**10000)

    # Unknown fields must not alter sealed identities after actual Zod parsing:
    # nested default objects strip, strict objects reject, and event records keep.
    from ponder_sdk.wire import normalize
    from jsonschema import Draft202012Validator
    normalization=json.loads(files('ponder_sdk').joinpath('wire-normalization.json').read_text())
    for vector in normalization['vectors']:
        parsed=normalize(vector['schema'],vector['input'])
        assert Draft202012Validator(vector['schema']).is_valid(parsed)==vector['accepted']
        if vector['accepted']:assert parsed==vector['output']

    from ponder_sdk.transport import parse_body
    with pytest.raises(ProtocolError):parse_body(b'{"accruedSpendUsd":1e1000}',200)
    rounded=parse_body(b'{"value":1000000000000000100}',200)
    assert rounded['value']==1000000000000000128
    assert canonical_json(rounded)=='{"value":1000000000000000100}'
    with pytest.raises(ProtocolError):Client(base_url='http://localhost',api_key='secret\u2603',team_id=TEAM)

    # A malformed local asset must not bypass runtime validation; original keys
    # resembling storage tags must survive without becoming references.
    from ponder_sdk.schema_asset import decode_schema_asset,SchemaAssetError
    def asset(table,root=0):return json.dumps({'schemaVersion':'openpond.internedJson.v1','root':{'$object':root},'objects':table}).encode()
    assert decode_schema_asset(asset([{'$object':7}]))=={'$object':7}
    for malformed in (asset([{'cycle':{'$object':0}}]),asset([{}, {'bad':{'$object':True}}],1),asset([{'raw':{'extra':0}}])):
        with pytest.raises(SchemaAssetError):decode_schema_asset(malformed)


TOOL=json.loads(files('ponder_sdk').joinpath('fixtures/tool-learning.valid.json').read_text())

def test_native_tool_learning_scope_receipts_and_uncertain_write(server):
    """A valid HTTP response must not cross project/model identity, and a lost
    paid consultation reply must be reconciled by GET rather than replayed.
    Both clients use real HTTP and TypeScript-sealed portable fixtures.
    """
    url,state=server
    async def async_run():
        async with AsyncClient(base_url=url,api_key='secret-fixture',team_id=TEAM,read_attempts=1) as client:
            tools=client.tool_learning(project_id='project-fixture')
            assert (await tools.installations())['items']==[TOOL['installation']]
            state['tool_reply']='wrong-project'
            with pytest.raises(ProtocolError):await tools.installations()
            state['tool_reply']='wrong-identity'
            with pytest.raises(ProtocolError):await tools.consult(TOOL['request'])
            state['tool_reply']='lost';before=state['tool_posts']
            with pytest.raises(PonderError) as uncertain:await tools.consult(TOOL['request'])
            assert uncertain.value.outcome_unknown and state['tool_posts']==before+1
            assert await tools.consultation(TOOL['request'])==TOOL['response']
            wrong=copy.deepcopy(TOOL['request']);wrong['scope']['projectId']='another-project'
            before=state['tool_posts']
            with pytest.raises(ProtocolError):await tools.consult(wrong)
            assert state['tool_posts']==before
    with Client(base_url=url,api_key='secret-fixture',team_id=TEAM,read_attempts=1) as client:
        tools=client.tool_learning(project_id='project-fixture')
        assert tools.installations()['items']==[TOOL['installation']]
        state['tool_reply']='wrong-project'
        with pytest.raises(ProtocolError):tools.installations()
        state['tool_reply']='wrong-identity'
        with pytest.raises(ProtocolError):tools.consult(TOOL['request'])
        state['tool_reply']='lost';before=state['tool_posts']
        with pytest.raises(PonderError) as uncertain:tools.consult(TOOL['request'])
        assert uncertain.value.outcome_unknown and state['tool_posts']==before+1
        assert tools.consultation(TOOL['request'])==TOOL['response']
        wrong=copy.deepcopy(TOOL['request']);wrong['scope']['projectId']='another-project'
        before=state['tool_posts']
        with pytest.raises(ProtocolError):tools.consult(wrong)
        assert state['tool_posts']==before
    state['tool_reply']='valid'
    asyncio.run(async_run())


def test_standalone_draft_receipts_and_owner_checks_in_both_native_clients(server):
    """A retained save receipt must survive later edits, and transport success
    cannot validate a changed document or another creator's paged record."""
    import inspect
    url,state=server
    async def flow(client):
        async def call(method,*args,**kwargs):
            result=getattr(client.training,method)(*args,**kwargs)
            return await result if inspect.isawaitable(result) else result
        # Native editor controls, immutable pins and explicit empty selections
        # must survive both clients and remain saved when another action is used.
        reward={'schemaVersion':'openpond.rewardRelease.v1','id':'grader','revision':2,'name':'Selected grader','description':'',
            'implementation':{'kind':'state','config':{'fields':['answer']}},'rawScore':{'minimum':0,'maximum':1},'assets':[]}
        hosted={'selectedDatasetId':'workspace','dataset':{'kind':'workspace','id':'workspace','revision':7,'ownerUserId':'actor-fixture','taskIds':['task-b']},
            'workspaceMode':'recorded','mode':'fixture','executionMode':'model_harness','name':'','modelId':'model-fixture',
            'messages':[{'role':'user','content':'Retain\nthese instructions'},{'role':'assistant','content':''}],
            'temperature':'-','topP':'.','maxOutputTokens':'','budget':'','seedText':'0, ','reasoningEffort':'high','sourceId':'retained',
            'harness':{'harnessRelease':{'id':'harness','contentHash':'b'*64},'agentSnapshot':{'id':'agent','contentHash':'c'*64},'sourcePackageHash':'d'*64},
            'project':{'id':'project-fixture','revision':4,'contentHash':'e'*64,'targetId':'target'},
            'members':[{'taskId':'task-b','fixtureId':'fixture-b'}],'graderIds':[],
            'graders':[{'id':'grader','version':'2','contentHash':'f'*64,'mappings':[{'destination':'input','path':['answer'],'source':'output','sourcePath':['answer']}]}],
            'graderMappings':{'grader':[]},'selectedGraders':[{**reward,'contentHash':canonical_sha256(reward)}],
            'workflow':{'repositoryId':'profile','sourceRevision':'pinned-revision','definitionId':'definition','workflowId':'workflow','label':'Workflow'},
            'profile':{'profileRepositoryId':'profile','sourceRevision':'pinned-revision','definitionId':'definition','sourceHash':'a'*64,
                'release':{'id':'dataset','revision':3,'contentHash':'a'*64},'taskIds':['task-b']}}
        request={'schemaVersion':'openpond.experimentDraftSave.v1','teamId':TEAM,'operationId':'create-draft','expectedRevision':0,
            'projectId':'project-fixture','draft':{'schemaVersion':'openpond.experimentDraft.v1','id':'draft-fixture','operationType':'evaluate','name':'Evaluation draft',
                'hostedEvaluationForm':hosted,
                'startingModel':{'source':'inference','label':'Fixture model','inferenceModelId':'model-fixture','baseModel':None},
                'evaluationForm':{'form':{'mode':'model','sourceId':'','profileChoiceId':'','name':'','release':None,'modelId':'model-fixture',
                    'budget':None,'outputTokens':None,'temperature':None,'prompt':'Retained instructions','targetId':'model','seed':'0, 3','graderChoices':{}},
                    'selection':None,'source':None,'executionLocation':'local'}}}
        first=await call('save_experiment_draft',request)
        assert first['record']['draft']['evaluationForm']==request['draft']['evaluationForm']
        assert first['record']['draft']['startingModel']==request['draft']['startingModel']
        assert first['record']['draft']['hostedEvaluationForm']==hosted
        edited={**request,'operationId':'edit-draft','expectedRevision':1,'draft':{**request['draft'],'name':'Edited'}}
        saved=await call('save_experiment_draft',edited)
        assert saved['record']['revision']==2
        assert await call('save_experiment_draft',request)==first
        assert (await call('get_experiment_draft','draft-fixture'))['draft']['name']=='Edited'
        query={'projectId':'project-fixture','limit':1}
        assert (await call('list_experiment_drafts',query))['items']==[saved['record']]
        state['draft_reply']='hash'
        with pytest.raises(ProtocolError):await call('get_experiment_draft','draft-fixture')
        state['draft_reply']='owner'
        with pytest.raises(ProtocolError):await call('list_experiment_drafts',query)
        state['draft_reply']='valid'
        archived=await call('archive_experiment_draft','draft-fixture',{'schemaVersion':'openpond.experimentDraftArchive.v1',
            'teamId':TEAM,'operationId':'archive-draft','expectedRevision':2})
        assert archived['record']['status']=='archived'
        restored=await call('save_experiment_draft',{**request,'operationId':'restore-draft','expectedRevision':3})
        assert restored['record']['status']=='draft' and restored['record']['revision']==4
        form={'baseModel':None,'prompts':[{'id':'prompt','text':'Retain\nthese exact instructions'}],
            'coordinates':[{'id':'coordinate','layer':'','neuron':'17','dose':'-'}],'doseMultipliers':'-1, 0, 1',
            'normalization':{'mode':'baseline_prompt_residual_median','statistic':'midpoint_median_fp32','sample':'non_padding_prompt_after_position_zero'},
            'tokenScope':{'phase':'decode_only','positions':'after_position_zero'},'maxNewTokens':'',
            'maximumCapturedValues':'65536','maximumForwardTokenWork':'1000000','maximumDurationSeconds':'300'}
        for index,method in enumerate(('neuron_steering','inspect_activations')):
            draft={'schemaVersion':'openpond.experimentDraft.v1','id':'draft-fixture','operationType':method,'name':'Activation draft','activationForm':form,'hostedEvaluationForm':hosted}
            command={**request,'operationId':method,'expectedRevision':4+index,'draft':draft}
            receipt=await call('save_experiment_draft',command)
            assert (await call('get_experiment_draft','draft-fixture'))['draft']==draft
            assert await call('save_experiment_draft',command)==receipt
            with pytest.raises(ProtocolError):await call('save_experiment_draft',{**command,'draft':{**draft,'training':{}}})
        assert state['draft_mutations']==6 and state['posts']==0
        query={'teamId':TEAM,'modelId':'example/model','source':'managed','revision':'pinned-revision','tokenizerRevision':'pinned-tokenizer'}
        state['capability_reply']='valid'
        capability=await call('modification_capabilities',query)
        assert all(row['execution']['state']=='unavailable' for row in capability['methods'])
        from ponder_sdk.modification_identity import verify_modification_capabilities
        with pytest.raises(ProtocolError):verify_modification_capabilities(capability,query,TEAM,'another-actor')
        for invalid in ('scope','method','expired'):
            state['capability_reply']=invalid
            with pytest.raises(ProtocolError):await call('modification_capabilities',query)
        assert state['draft_mutations']==6 and state['posts']==0
        saved=json.loads((Path(__file__).resolve().parents[3]/'packages/sdk/fixtures/python-foundation/training-model-save-http-workflow.json').read_text())['receipt']['version']
        source={'source':'trained','label':'Exact trained checkpoint','inferenceModelId':None,'baseModel':saved['request']['baseModel'],'trainedVersion':saved}
        revision=6
        for method in ('evaluate','neuron_steering','inspect_activations'):
            draft={'schemaVersion':'openpond.experimentDraft.v1','id':'draft-fixture','operationType':method,
                'name':'Retained trained source','startingModel':source,
                **({'evaluationForm':request['draft']['evaluationForm']} if method=='evaluate' else {'activationForm':{**form,'baseModel':source['baseModel']}})}
            command={**request,'operationId':'trained-'+method,'expectedRevision':revision,'draft':draft}
            retained=await call('save_experiment_draft',command);revision=retained['record']['revision']
            assert (await call('get_experiment_draft','draft-fixture'))['draft']['startingModel']==source
            assert await call('save_experiment_draft',command)==retained
        state['draft_reply']='trained-version'
        with pytest.raises(ProtocolError):await call('get_experiment_draft','draft-fixture')
        state['draft_reply']='valid'
    with Client(base_url=url,api_key='secret-fixture',team_id=TEAM,read_attempts=1) as client:asyncio.run(flow(client))
    state['draft']=None;state['draft_ops']={};state['draft_mutations']=0
    async def run():
        async with AsyncClient(base_url=url,api_key='secret-fixture',team_id=TEAM,read_attempts=1) as client:await flow(client)
    asyncio.run(run())


def test_hardware_catalog_identity_in_both_native_clients(server):
    """Cached metadata must not accept an altered GPU or eligibility binding."""
    import inspect
    url,state=server
    async def flow(client):
        async def read():
            value=client.training.hardware_catalog()
            return await value if inspect.isawaitable(value) else value
        state['hardware_reply']='valid'
        value=await read()
        assert value['eligibility'][0]['status']=='not_admitted'
        assert 'price' not in value['inventory']['hardware'][0]
        for invalid in ('hash','gpu'):
            state['hardware_reply']=invalid
            with pytest.raises(ProtocolError):await read()
        query={'teamId':TEAM,'modelId':'model','modelRevision':'revision','tokenizerRevision':'revision',
            'chatTemplateHash':'a'*64,'method':'grpo','loraRank':16,'gpuCount':2}
        async def gpu_read():
            value=client.training.gpu_catalog(query=query)
            return await value if inspect.isawaitable(value) else value
        state['gpu_reply']='valid'
        assert (await gpu_read())['scope']['query']==query
        for invalid in ('hash','count','expired','missing'):
            state['gpu_reply']=invalid
            with pytest.raises(ProtocolError):await gpu_read()
        assert state['posts']==0
    with Client(base_url=url,api_key='secret-fixture',team_id=TEAM,read_attempts=1) as client:asyncio.run(flow(client))
    async def run():
        async with AsyncClient(base_url=url,api_key='secret-fixture',team_id=TEAM,read_attempts=1) as client:await flow(client)
    asyncio.run(run())


def test_estimate_review_identity_in_both_native_clients(server):
    """A 200 response cannot substitute the reviewed preparation or stale review."""
    import inspect
    url,state = server
    fixture = json.loads((Path(__file__).resolve().parents[3]/'packages/sdk/fixtures/python-foundation/training-estimate-http-workflow.json').read_text())
    request = fixture['request']; request['teamId'] = TEAM
    value = fixture['response']; value['teamId'] = TEAM
    value['requestHash'] = value['review']['requestHash'] = canonical_sha256(request)
    value['createdAt'] = datetime.now(timezone.utc).isoformat()
    value['expiresAt'] = value['review']['expiresAt'] = (datetime.now(timezone.utc)+timedelta(seconds=60)).isoformat()
    state['estimate_request'] = request; state['estimate'] = value
    async def flow(client):
        async def read():
            response = client.training.estimate(request)
            return await response if inspect.isawaitable(response) else response
        state['estimate_reply'] = 'valid'
        assert (await read())['review'] == value['review']
        for invalid in ('source','review','request','expiry','count','range'):
            state['estimate_reply'] = invalid
            with pytest.raises(ProtocolError): await read()
        # Optional token evidence must retain the estimate's admitted population,
        # even when a 200 response truthfully reports native counts unavailable.
        population = lambda total: dict(coverage='unavailable', total=total, counted=0,
            inputsHash=None, reason='Native tokenizer evidence unavailable.', totals=None)
        value['workload'] = dict(schemaVersion='openpond.trainingEstimateWorkload.v1', method='sft',
            identity=None, preprocessing=None, unavailableReason='Native tokenizer evidence unavailable.',
            trainingRows=population(8), evaluationRows=2, evaluationInitialRequests=population(2),
            evaluationGeneratedCompletionTokens=None, evaluationGeneratedTokensReason='Future outputs are unknown.',
            planned=dict(exampleExposures=None, optimizerSteps=None, exposuresHash=None, tokenTotals=None,
                         reason='Native scheduling identity unavailable.'))
        state['estimate_reply'] = 'valid'
        assert (await read())['workload'] == value['workload']
        # Retained GPU allocation quantity uses the whole-Pod rate once. A
        # duplicate phase or device-count multiplier must not become a price.
        aggregate = dict(phase='gpu_allocation', resource='gpu', expectedSeconds=3600,
            expectedUsd=value['gpu']['customerHourlyUsd'], planningRangeUsd=None,
            evidence='measured', reason='Conserved allocation quantity at the current rate.')
        value['cost']['components'] = [aggregate]
        assert (await read())['cost']['components'] == [aggregate]
        aggregate['expectedUsd'] *= 2
        with pytest.raises(ProtocolError): await read()
        aggregate['expectedUsd'] /= 2
        value['cost']['components'] = [aggregate, dict(aggregate, phase='optimization')]
        with pytest.raises(ProtocolError): await read()
        value['cost']['components'] = [aggregate, dict(aggregate)]
        with pytest.raises(ProtocolError): await read()
        value['cost']['components'] = []
        state['estimate_reply'] = 'workload_rows'
        with pytest.raises(ProtocolError): await read()
        assert state['posts'] == 0
    with Client(base_url=url,api_key='secret-fixture',team_id=TEAM,read_attempts=1) as client: asyncio.run(flow(client))
    async def run():
        async with AsyncClient(base_url=url,api_key='secret-fixture',team_id=TEAM,read_attempts=1) as client: await flow(client)
    asyncio.run(run())


def test_funding_identity_and_privacy_in_both_native_clients(server):
    origin, state = server
    fixture = json.loads((Path(__file__).resolve().parents[3]/'packages/sdk/fixtures/python-foundation/training-funding-http-workflow.json').read_text())
    for request_key, response_key, state_request, state_response in [('request','response','funding_request','funding'), ('handoffRequest','handoffResponse','funding_handoff_request','funding_handoff')]:
        request, value = fixture[request_key], fixture[response_key]
        value['requestHash'] = canonical_sha256(request)
        value['checkedAt'] = datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
        value['expiresAt'] = (datetime.now(timezone.utc)+timedelta(seconds=60)).isoformat().replace('+00:00','Z')
        state[state_request], state[state_response] = request, value
    async def check(asynchronous):
        client = AsyncClient(base_url=origin, api_key='secret-fixture', team_id=TEAM) if asynchronous else Client(base_url=origin, api_key='secret-fixture', team_id=TEAM)
        try:
            for handoff in (False, True):
                state['funding_reply'] = 'valid'
                request = fixture['handoffRequest' if handoff else 'request']
                method = client.training.funding_handoff if handoff else client.training.funding
                value = await method(request) if asynchronous else method(request)
                assert value['draft'] == request['draft']
                invalids = ['cap','draft','team','hash','expiry'] + (['url','permission'] if handoff else ['privacy'])
                for invalid in invalids:
                    state['funding_reply'] = invalid
                    with pytest.raises(ProtocolError):
                        if asynchronous: await method(request)
                        else: method(request)
        finally:
            if asynchronous: await client.close()
            else: client.close()
    asyncio.run(check(False)); asyncio.run(check(True))


def test_dataset_review_receipt_bindings_in_both_native_clients(server):
    origin, state = server
    fixture = json.loads((Path(__file__).resolve().parents[3]/'packages/sdk/fixtures/python-foundation/dataset-training-review-http-workflow.json').read_text())
    request = fixture['request']
    state['dataset_review_request'], state['dataset_review'] = request, fixture['response']
    async def flow(client, asynchronous):
        async def invoke(body):
            result = client.training.review_dataset(body)
            return await result if asynchronous else result
        state['dataset_review_reply'] = 'valid'
        assert await invoke(request) == fixture['response']
        for mode in ('dataset','team','operation','id','request','inventory','sharing','hash'):
            state['dataset_review_reply'] = mode
            with pytest.raises(ProtocolError): await invoke(request)
        before = state['dataset_review_posts']
        for invalid in ({**request,'shareWithWorkspace':False}, {**request,'taskIds':['duplicate','duplicate']}):
            with pytest.raises(ProtocolError): await invoke(invalid)
        assert state['dataset_review_posts'] == before
    with Client(base_url=origin,api_key='secret-fixture',team_id=TEAM) as client: asyncio.run(flow(client,False))
    async def run():
        async with AsyncClient(base_url=origin,api_key='secret-fixture',team_id=TEAM) as client: await flow(client,True)
    asyncio.run(run())


def test_model_serving_activation_recovery_and_stop_in_both_clients(server):
    # Both native clients retain the original write and reject substituted authority.
    url,state=server
    f=json.loads((Path(__file__).resolve().parents[3]/'packages/sdk/fixtures/python-foundation/training-model-serving-control-http-workflow.json').read_text())
    query={'teamId':TEAM,'versionHash':f['request']['versionHash']};state['model_serving_query']=query
    for asynchronous in (False,True):
        state.update(serving_control_request=f['request'],serving_control_reply=f['receipt'],serving_control_calls=[],serving_control_drop=True,model_serving=f['starting'])
        if asynchronous:
            async def run():
                async with AsyncClient(base_url=url,api_key='secret-fixture',team_id=TEAM,read_attempts=1) as client:
                    with pytest.raises(PonderError) as lost:await client.training.control_model_serving(f['modelProjectId'],f['request'])
                    assert lost.value.outcome_unknown and state['serving_control_calls']==[f['request']]
                    assert (await client.training.model_serving(f['modelProjectId'],query))['control']['operationId']==f['request']['operationId']
                    assert (await client.training.model_serving(f['modelProjectId'],query))['state']=='starting'
                    assert (await client.training.control_model_serving(f['modelProjectId'],f['request']))['control']['revision']==1
                    assert state['serving_control_calls']==[f['request'],f['request']]
                    for invalid in f['invalid']:
                        state['serving_control_reply']=invalid['response']
                        with pytest.raises(ProtocolError):await client.training.control_model_serving(f['modelProjectId'],f['request'])
                    state.update(serving_control_request=f['stopRequest'],serving_control_reply=f['stopReceipt'],model_serving=f['stopped'])
                    assert (await client.training.control_model_serving(f['modelProjectId'],f['stopRequest']))['control']['desiredState']=='stopped'
                    assert (await client.training.model_serving(f['modelProjectId'],query))['state']=='retiring'
                    priced=f['usageScenario']
                    state.update(serving_control_request=priced['request'],serving_control_reply=priced['receipt'],model_serving=priced['status'])
                    assert (await client.training.control_model_serving(f['modelProjectId'],priced['request']))['control']['usage']['customerCapUsd']=='1.000000'
                    assert (await client.training.model_serving(f['modelProjectId'],query))['usageBilling']['review']['contentHash']==priced['request']['usageApproval']['reviewHash']
                    state['serving_control_reply']=priced['invalidControl']
                    with pytest.raises(ProtocolError):await client.training.control_model_serving(f['modelProjectId'],priced['request'])
                    state['model_serving']=priced['invalidStatus']
                    with pytest.raises(ProtocolError):await client.training.model_serving(f['modelProjectId'],query)
            asyncio.run(run())
        else:
            with Client(base_url=url,api_key='secret-fixture',team_id=TEAM,read_attempts=1) as client:
                with pytest.raises(PonderError) as lost:client.training.control_model_serving(f['modelProjectId'],f['request'])
                assert lost.value.outcome_unknown and state['serving_control_calls']==[f['request']]
                assert client.training.model_serving(f['modelProjectId'],query)['control']['operationId']==f['request']['operationId']
                assert client.training.model_serving(f['modelProjectId'],query)['state']=='starting'
                assert client.training.control_model_serving(f['modelProjectId'],f['request'])['control']['revision']==1
                assert state['serving_control_calls']==[f['request'],f['request']]
                for invalid in f['invalid']:
                    state['serving_control_reply']=invalid['response']
                    with pytest.raises(ProtocolError):client.training.control_model_serving(f['modelProjectId'],f['request'])
                state.update(serving_control_request=f['stopRequest'],serving_control_reply=f['stopReceipt'],model_serving=f['stopped'])
                assert client.training.control_model_serving(f['modelProjectId'],f['stopRequest'])['control']['desiredState']=='stopped'
                assert client.training.model_serving(f['modelProjectId'],query)['state']=='retiring'
                priced=f['usageScenario']
                state.update(serving_control_request=priced['request'],serving_control_reply=priced['receipt'],model_serving=priced['status'])
                assert client.training.control_model_serving(f['modelProjectId'],priced['request'])['control']['usage']['customerCapUsd']=='1.000000'
                assert client.training.model_serving(f['modelProjectId'],query)['usageBilling']['review']['contentHash']==priced['request']['usageApproval']['reviewHash']
                state['serving_control_reply']=priced['invalidControl']
                with pytest.raises(ProtocolError):client.training.control_model_serving(f['modelProjectId'],priced['request'])
                state['model_serving']=priced['invalidStatus']
                with pytest.raises(ProtocolError):client.training.model_serving(f['modelProjectId'],query)


def test_exact_model_serving_identity_in_both_clients(server):
    # Both native clients reject another version, false routing and load evidence.
    url,state=server
    fixture=json.loads((Path(__file__).resolve().parents[3]/'packages/sdk/fixtures/python-foundation/training-model-serving-http-workflow.json').read_text())
    state['model_serving_query']=fixture['query']
    for asynchronous in (False,True):
        state['model_serving']=fixture['response']
        if asynchronous:
            async def run():
                async with AsyncClient(base_url=url,api_key='secret-fixture',team_id=TEAM,read_attempts=1) as client:
                    value=await client.training.model_serving(fixture['modelProjectId'],fixture['query'])
                    assert value['version']['candidate']['artifact']['contentHash']!=value['registry']['artifact']['contentHash']
                    for invalid in fixture['invalid']:
                        state['model_serving']=invalid['response']
                        with pytest.raises(ProtocolError):await client.training.model_serving(fixture['modelProjectId'],fixture['query'])
            asyncio.run(run())
        else:
            with Client(base_url=url,api_key='secret-fixture',team_id=TEAM,read_attempts=1) as client:
                value=client.training.model_serving(fixture['modelProjectId'],fixture['query'])
                assert value['version']['candidate']['artifact']['contentHash']!=value['registry']['artifact']['contentHash']
                for invalid in fixture['invalid']:
                    state['model_serving']=invalid['response']
                    with pytest.raises(ProtocolError):client.training.model_serving(fixture['modelProjectId'],fixture['query'])


def test_exact_model_save_retry_and_receipt_in_both_clients(server):
    # Lost writes are reconciled explicitly, with unchanged operation and bytes.
    url,state=server
    fixture=json.loads((Path(__file__).resolve().parents[3]/'packages/sdk/fixtures/python-foundation/training-model-save-http-workflow.json').read_text())
    command=fixture['command'];state['model_save_command']=command;state['saved_model']=fixture['savedModel']
    activation=json.loads((Path(__file__).resolve().parents[3]/'packages/sdk/fixtures/python-foundation/activation-reference-workflow.json').read_text())
    variant=next(row for row in activation['request']['variants'] if row['profile'] is not None)
    model=variant['profile']['model'];now=fixture['receipt']['version']['createdAt']
    content={'schemaVersion':'openpond.steeringProfilePublication.v1','id':'steering-http-fixture','revision':1,'teamId':TEAM,'ownerUserId':'user-fixture','projectId':None,'name':'Retained steering',
        'baseModel':{'schemaVersion':'openpond.baseModelPreference.v1','source':'managed','modelId':model['modelId'],'revision':model['revision'],'tokenizerRevision':None,'chatTemplateHash':None,'modelAssetId':None},
        'profile':variant['profile'],'source':{'executionId':'execution-fixture','inputHash':canonical_sha256(activation['request']),'runtimeHash':'a'*64,'resultHash':activation['result']['contentHash'],'variantId':variant['id']},
        'calibrationEvidence':[{'promptId':row['promptId'],'calibration':row['calibration']} for row in activation['result']['outcomes'] if row['variantId']==variant['id']], 'createdAt':now}
    published={**content,'contentHash':canonical_sha256(content)}
    record={'schemaVersion':'openpond.steeringProfileRecord.v1','publication':published,'revision':1,'archived':False,'updatedAt':now}
    state['steering_profile']={**record,'contentHash':canonical_sha256(record)}
    invalid=[]
    for mode in ('name','revision','artifact','job','operation'):
        value=copy.deepcopy(fixture['receipt'])
        if mode=='name':value['model']['name']='Another model'
        if mode=='revision':value['model']['revision']+=1
        if mode=='artifact':value['version']['candidate']['artifact']['contentHash']='e'*64
        if mode=='job':value['version']['jobId']='another-job'
        if mode=='operation':value['operationId']='another-operation'
        value['version']['contentHash']=canonical_sha256({k:v for k,v in value['version'].items() if k!='contentHash'})
        value['contentHash']=canonical_sha256({k:v for k,v in value.items() if k!='contentHash'})
        invalid.append(value)
    for asynchronous in (False,True):
        state['model_save_calls']=[];state['model_save_drop']=True;state['model_save_reply']=fixture['receipt']
        if asynchronous:
            async def run():
                async with AsyncClient(base_url=url,api_key='secret-fixture',team_id=TEAM,read_attempts=1) as client:
                    with pytest.raises(PonderError) as lost:await client.training.save_result_model(command['jobId'],command['request'])
                    assert lost.value.outcome_unknown and state['model_save_calls']==[command['request']]
                    assert (await client.training.saved_model(fixture['receipt']['model']['id'],{'teamId':TEAM}))['version']['candidate']['artifact']==command['request']['artifact']
                    assert (await client.training.model_version(fixture['receipt']['model']['id']))['version']['candidate']['artifact']==command['request']['artifact']
                    assert await client.training.get_steering_profile('steering-http-fixture')==state['steering_profile']
                    with pytest.raises(ProtocolError):await client.training.get_steering_profile('steering-http-fixture',{'teamId':'foreign-team'})
                    assert (await client.training.save_result_model(command['jobId'],command['request']))['operationId']==command['request']['operationId']
                    assert state['model_save_calls']==[command['request'],command['request']]
                    for value in invalid:
                        state['model_save_reply']=value
                        with pytest.raises(ProtocolError):await client.training.save_result_model(command['jobId'],command['request'])
            asyncio.run(run())
        else:
            with Client(base_url=url,api_key='secret-fixture',team_id=TEAM,read_attempts=1) as client:
                with pytest.raises(PonderError) as lost:client.training.save_result_model(command['jobId'],command['request'])
                assert lost.value.outcome_unknown and state['model_save_calls']==[command['request']]
                assert client.training.saved_model(fixture['receipt']['model']['id'],{'teamId':TEAM})['version']['candidate']['artifact']==command['request']['artifact']
                assert client.training.model_version(fixture['receipt']['model']['id'])['version']['candidate']['artifact']==command['request']['artifact']
                assert client.training.get_steering_profile('steering-http-fixture')==state['steering_profile']
                with pytest.raises(ProtocolError):client.training.get_steering_profile('steering-http-fixture',{'teamId':'foreign-team'})
                assert client.training.save_result_model(command['jobId'],command['request'])['operationId']==command['request']['operationId']
                assert state['model_save_calls']==[command['request'],command['request']]
                for value in invalid:
                    state['model_save_reply']=value
                    with pytest.raises(ProtocolError):client.training.save_result_model(command['jobId'],command['request'])


def test_external_activation_observation_identity_in_both_native_clients(server):
    """Native clients must reject substituted artifacts and retain external
    provenance; a valid schema/hash cannot promote a capture to managed work."""
    import inspect
    url,state=server
    document=json.loads((Path(__file__).resolve().parents[3]/'packages/sdk/fixtures/python-foundation/activation-reference-workflow.json').read_text())
    command={'schemaVersion':'openpond.modificationRecordingRequest.v1','teamId':TEAM,'operationId':'retain-cpu-reference',
             'name':'Synthetic CPU observation','projectId':None,'method':'neuron_steering',**document}
    scope='c'*64
    content={'schemaVersion':'openpond.modificationRecording.v1','id':'observation-'+canonical_sha256({'scope':scope,'operationId':command['operationId']}),
             'teamId':TEAM,'actorId':'user-fixture','operationId':command['operationId'],'commandHash':canonical_sha256(command),
             'name':command['name'],'projectId':None,'method':command['method'],'accountScopeHash':scope,'custody':'local',
             'provenance':'external_observation','measurementAttestation':'unattested','model':document['request']['model'],
             'inputHash':canonical_sha256(document['request']),'resultHash':document['result']['contentHash'],
             'artifact':{'contentHash':canonical_sha256(document),'sizeBytes':len(canonical_json(document).encode('utf-8'))},
             'counts':{'prompts':2,'variants':8,'outcomes':16,'captures':560},'createdAt':'2026-11-01T00:00:00Z'}
    recording={**content,'contentHash':canonical_sha256(content)}
    state['recording_command']=command;state['recording_read']={'recording':recording,'document':document}
    state['recording_page']={'teamId':TEAM,'actorId':'user-fixture','accountScopeHash':scope,'projectId':None,'items':[recording],'nextCursor':None}
    async def flow(client):
        async def call(method,*args):
            result=getattr(client.training,method)(*args)
            return await result if inspect.isawaitable(result) else result
        state['recording_reply']='valid'
        assert await call('record_modification_observation',command)==recording
        assert await call('modification_recording',recording['id'],{'teamId':TEAM})==state['recording_read']
        assert (await call('modification_recordings',{'teamId':TEAM}))['items']==[recording]
        before=state['recording_posts']
        with pytest.raises(ProtocolError):await call('record_modification_observation',{**command,'method':'inspect_activations'})
        assert state['recording_posts']==before
        state['recording_reply']='capture'
        with pytest.raises(ProtocolError):await call('modification_recording',recording['id'],{'teamId':TEAM})
        state['recording_reply']='scope'
        with pytest.raises(ProtocolError):await call('modification_recordings',{'teamId':TEAM})
        assert state['posts']==0
    with Client(base_url=url,api_key='secret-fixture',team_id=TEAM,read_attempts=1) as client:asyncio.run(flow(client))
    async def run():
        async with AsyncClient(base_url=url,api_key='secret-fixture',team_id=TEAM,read_attempts=1) as client:await flow(client)
    asyncio.run(run())


def test_managed_modification_workflow_binds_receipts_and_complete_capture_in_both_native_clients(server):
    """A resealed response cannot substitute an execution, input or capture;
    retained capture evidence does not claim provider cleanup or settlement."""
    import inspect
    url,state=server
    document=json.loads((Path(__file__).resolve().parents[3]/'packages/sdk/fixtures/python-foundation/activation-reference-workflow.json').read_text())
    content={'schemaVersion':'openpond.managedModificationExecution.v1','id':'execution-fixture','teamId':TEAM,'ownerUserId':'user-fixture',
        'projectId':None,'name':'Capture evidence','method':'neuron_steering','phase':'dispatching','revision':3,'sourceContentHash':'a'*64,
        'plan':{'contentHash':'b'*64,'inputHash':canonical_sha256(document['request']),'runtimeHash':'c'*64,'maximumSpendUsd':'2',
            'createdAt':'2026-11-01T00:00:00Z','expiresAt':'2026-11-01T00:05:00Z'},
        'request':document['request'],'result':document['result'],'resultRecordedAt':'2026-11-01T00:01:00Z','updatedAt':'2026-11-01T00:01:00Z'}
    async def flow(client):
        async def call(identity='execution-fixture'):
            result=client.training.get_modification_execution(identity)
            return await result if inspect.isawaitable(result) else result
        state['managed_modification']={**content,'contentHash':canonical_sha256(content)}
        assert (await call())['phase']=='dispatching'
        assert (await call(' execution-fixture '))['id']=='execution-fixture'
        history_query={'id':'execution-fixture','method':'neuron_steering','phase':'dispatching','limit':1}
        summary={key:copy.deepcopy(value) for key,value in content.items() if key not in ('schemaVersion','request','result','resultRecordedAt')}
        summary['plan']['maximumSpendUsd']='2.000000';summary['model']=document['request']['model']
        history={'schemaVersion':'openpond.managedModificationExecutionPage.v1','teamId':TEAM,'ownerUserId':'user-fixture',
            'query':history_query,'items':[summary],'nextCursor':None}
        async def read_history():
            result=client.training.list_modification_executions(history_query)
            return await result if inspect.isawaitable(result) else result
        state['managed_history']={**history,'contentHash':canonical_sha256(history)}
        assert (await read_history())['items'][0]['id']=='execution-fixture'
        for change in ('owner','filter','row','hash'):
            changed=copy.deepcopy(history)
            if change=='owner':changed['items'][0]['ownerUserId']='another-owner'
            if change=='filter':changed['query']['id']='another-execution'
            if change=='row':changed['items'][0]['id']='another-execution'
            state['managed_history']={**changed,'contentHash':'0'*64 if change=='hash' else canonical_sha256(changed)}
            with pytest.raises(ProtocolError):await read_history()

        with pytest.raises(ProtocolError):await call('x'*241)
        # Terminal phases come from the execution owner; capture presence alone
        # cannot infer cleanup or settlement, and failed runs may retain capture.
        for phase in ('completed','failed'):
            terminal={**content,'phase':phase}
            state['managed_modification']={**terminal,'contentHash':canonical_sha256(terminal)}
            assert (await call())['phase']==phase
        for change in ('id','capture','input','method'):
            changed=copy.deepcopy(content)
            if change=='id':changed['id']='another-execution'
            if change=='capture':changed['result']['captures'][0]['after']+=1
            if change=='input':changed['plan']['inputHash']='d'*64
            if change=='method':changed['method']='inspect_activations'
            state['managed_modification']={**changed,'contentHash':canonical_sha256(changed)}
            with pytest.raises(ProtocolError):await call()
        assert state['posts']==0
        state['modification_operations']={};state['modification_forged']=False
        prepare={'teamId':TEAM,'operationId':'prepare-modification','projectId':None,'name':'Bounded reference','method':'neuron_steering',
            'query':{'teamId':TEAM,'modelId':document['request']['model']['modelId'],'source':'managed','revision':document['request']['model']['revision'],'tokenizerRevision':'exact-tokenizer'},
            'request':document['request'],'maximumSpendUsd':'2'}
        async def mutate(method,*args):
            result=getattr(client.training,method)(*args)
            return await result if inspect.isawaitable(result) else result
        query=prepare['query']
        form={'baseModel':{'schemaVersion':'openpond.baseModelPreference.v1','modelId':query['modelId'],'source':query['source'],
                'revision':query['revision'],'tokenizerRevision':query['tokenizerRevision'],'chatTemplateHash':None,'modelAssetId':None},
            'prompts':[{'id':'prompt','text':'Retain exact prompt'}], 'coordinates':[{'id':'coordinate','layer':'0','neuron':'1','dose':'1'}],
            'doseMultipliers':'1', 'normalization':{'mode':'baseline_prompt_residual_median','statistic':'midpoint_median_fp32','sample':'non_padding_prompt_after_position_zero'}, 'tokenScope':{'phase':'decode_only','positions':'after_position_zero'},
            'maxNewTokens':'1','maximumCapturedValues':'65536','maximumForwardTokenWork':'1000000','maximumDurationSeconds':'300'}
        compile_input={'teamId':TEAM,'projectId':None,'method':prepare['method'],'query':query,'form':form}
        state['compiled_request']=document['request'];state['compile_forged']=False
        assert (await mutate('compile_modification_execution',compile_input))['inputHash']==canonical_sha256(document['request'])
        state['compile_forged']=True
        with pytest.raises(ProtocolError):await mutate('compile_modification_execution',compile_input)
        state['compile_forged']=False
        prepared=await mutate('prepare_modification_execution',prepare)
        start={'teamId':TEAM,'id':prepared['execution']['id'],'operationId':'start-modification','expectedRevision':1,
            'planHash':prepared['execution']['plan']['contentHash'],'action':'start','approvedMaximumSpendUsd':'2'}
        state['modification_drop']=True;before=state['modification_posts']
        with pytest.raises(PonderError):await mutate('start_modification_execution',start['id'],start)
        assert state['modification_posts']==before+1
        started=await mutate('start_modification_execution',start['id'],start)
        cancel={key:value for key,value in start.items() if key!='approvedMaximumSpendUsd'}
        cancel.update(operationId='cancel-modification',expectedRevision=2,action='cancel')
        assert (await mutate('cancel_modification_execution',start['id'],cancel))['execution']['phase']=='cancelled'
        assert await mutate('start_modification_execution',start['id'],start)==started
        assert await mutate('prepare_modification_execution',prepare)==prepared
        state['modification_forged']=True
        with pytest.raises(ProtocolError):await mutate('start_modification_execution',start['id'],start)
        state['modification_forged']=False
    with Client(base_url=url,api_key='secret-fixture',team_id=TEAM,read_attempts=1) as client:asyncio.run(flow(client))
    async def run():
        async with AsyncClient(base_url=url,api_key='secret-fixture',team_id=TEAM,read_attempts=1) as client:await flow(client)
    asyncio.run(run())
