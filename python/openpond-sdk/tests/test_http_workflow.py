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
import pytest
from ponder_sdk import Client,AsyncClient,PonderError,ProtocolError,canonical_sha256,canonical_json

SOURCE=json.loads(files('ponder_sdk').joinpath('fixtures/policy-optimize.valid.json').read_text())['source']
TEAM='team-fixture'
CREDENTIAL={'action':'create','scope':TEAM,'sourceId':'source-fixture','name':'fixture','expiresAt':'2027-01-01T00:00:00Z','operationId':'credential-operation','apiKey':'opk_key_'+'a'*16+'_'+'b'*48}
REQUEST={'schemaVersion':'openpond.trainingPreparationRequest.v1','teamId':TEAM,'operationId':'operation-fixture','projectId':None,'configuration':{'id':SOURCE['modelProject']['id'],'expectedRevision':3,'expectedEtag':'a'*64},'batch':{'id':'batch-fixture','revision':1,'contentHash':'b'*64},'name':'A reviewed batch','maximumSpendUsd':1}

def receipt(request):
    plan={'schemaVersion':'openpond.trainingPreparationPlan.v1','id':'prep-fixture','creatorUserId':'user-fixture','request':request,'requestHash':canonical_sha256(request),'source':SOURCE,'submissionHash':'c'*64,'createdAt':'2026-10-23T12:00:00Z'}
    return {'schemaVersion':'openpond.trainingPreparationReceipt.v1','plan':{**plan,'contentHash':canonical_sha256(plan)},'revision':1,'state':'prepared','jobId':None}

@pytest.fixture
def server():
    state={'receipt':None,'posts':0,'tool_posts':0,'tool_reply':'valid'}
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
            state['posts']+=1
            data=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            if self.path=='/v1/training/preparations':
                state['receipt']=receipt(data)
                # Admission was durably retained, but its reply never arrives.
                self.connection.shutdown(2);self.connection.close();return
            retained=state['receipt']
            if data['expectedRevision']!=retained['revision']:
                self.reply(409,{'code':'revision_conflict','error':'private upstream content secret-fixture'});return
            retained={**retained,'revision':retained['revision']+1,'state':'submitted' if self.path.endswith('/start') else 'cancelled','jobId':'job-fixture' if self.path.endswith('/start') else None}
            state['receipt']=retained;self.reply(200,retained)
        def do_GET(self):
            self.auth()
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
        if asynchronous:
            async def run():
                async with AsyncClient(base_url=url,api_key='secret-fixture',team_id=TEAM,read_attempts=1) as client:
                    assert await client.models.configuration_candidates()==[]
                    with pytest.raises(ProtocolError):await client.learning.list_source_credentials(CREDENTIAL)
                    assert state['posts']==0
                    with pytest.raises(PonderError) as error:await client.training.prepare_run(REQUEST)
                    assert error.value.outcome_unknown and state['posts']==1
                    retained=await client.training.get_preparation('prep-fixture')
                    page=await client.training.list_preparations({'limit':1})
                    assert page['items']==[retained]
                    with pytest.raises(ProtocolError):await client.training.get_preparation('wrong-team')
                    control={'teamId':TEAM,'planHash':retained['plan']['contentHash'],'expectedRevision':1}
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
                with pytest.raises(PonderError) as error:client.training.prepare_run(REQUEST)
                assert error.value.outcome_unknown and state['posts']==1
                retained=client.training.get_preparation('prep-fixture')
                assert client.training.list_preparations({'limit':1})['items']==[retained]
                with pytest.raises(ProtocolError):client.training.get_preparation('wrong-team')
                control={'teamId':TEAM,'planHash':retained['plan']['contentHash'],'expectedRevision':1}
                assert client.training.start_preparation('prep-fixture',control)['jobId']=='job-fixture'
                with pytest.raises(PonderError) as stale:client.training.start_preparation('prep-fixture',control)
                assert stale.value.status==409 and 'secret' not in str(stale.value)
        assert state['posts']==3

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
