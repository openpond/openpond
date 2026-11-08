"""Failure story: aliases must never hit the catalogue or replay billed requests;
stream EOF must not masquerade as complete, and sync/async share owned pools."""
import asyncio
import json
import threading
from importlib.resources import files
from jsonschema import Draft202012Validator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import pytest
from ponder_sdk import Client, AsyncClient, PonderError

@pytest.fixture
def serving():
    validator=Draft202012Validator(json.loads(files("ponder_sdk").joinpath("fixtures/personalized-inference-request.schema.json").read_text()))
    state={'calls':0,'mode':'normal'}
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def do_POST(self):
            state['calls']+=1
            body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            validator.validate(body)
            assert self.headers['X-OpenPond-Team-Id']=='team-one'
            assert self.path=='/personalized/v1/chat/completions'
            assert self.headers['Authorization']=='Bearer serving-key'
            assert body['model']=='saved-model-one'
            if state['mode']=='reject':
                self.send_response(503);self.end_headers();return
            identity={'id':'request-one','model':'resolved-version-one','openpond':{'weightReceipt':{'versionHash':'exact-version'}}}
            usage={'prompt_tokens':2,'completion_tokens':3,'total_tokens':5}
            self.send_response(200)
            self.send_header('x-openpond-request-id','header-request-one')
            self.send_header('Content-Type','text/event-stream' if body['stream'] else 'application/json')
            self.end_headers()
            if not body['stream']:
                self.wfile.write(json.dumps({**identity,'choices':[{'index':0,'message':{'role':'assistant','content':'hello'},'finish_reason':'stop'}],'usage':usage}).encode());return
            assert 'stream_options' not in body
            self.wfile.write(('data: '+json.dumps({**identity,'choices':[{'index':0,'delta':{'content':'hello'}}]})+'\n\n').encode())
            if state['mode']=='truncated':return
            self.wfile.write(('data: '+json.dumps({**identity,'choices':[{'index':0,'delta':{},'finish_reason':'stop'}]})+'\n\n').encode())
            self.wfile.write(('data: '+json.dumps({**identity,'choices':[],'usage':usage})+'\n\ndata: [DONE]\n\n').encode())
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:yield 'http://127.0.0.1:'+str(server.server_port),state
    finally:server.shutdown();server.server_close();thread.join()

def test_sync_async_model_routing_receipts_and_stream_failure(serving):
    origin,state=serving
    config=dict(base_url=origin,api_key='workspace-key',team_id='team-one',serving_base_url=origin+'/personalized/v1',serving_api_key='serving-key',model_aliases={'support':'saved-model-one'})
    with Client(**config) as client:
        answer=client.models.support.generate(prompt='hello')
        assert answer.text=='hello' and answer.resolved_model_id=='resolved-version-one'
        assert answer.request_id=='header-request-one' and answer.evidence=={'weightReceipt':{'versionHash':'exact-version'}}
        events=list(client.models.support.stream(prompt='hello'))
        assert events[-1].result==answer
        assert answer.usage.total_tokens==5
        state['mode']='truncated'
        with pytest.raises(PonderError,match='model_stream_incomplete'):
            list(client.models.support.stream(prompt='hello'))
        state['mode']='reject';before=state['calls']
        with pytest.raises(PonderError):client.models.support.generate(prompt='hello')
        assert state['calls']==before+1
    async def run():
        state['mode']='normal'
        async with AsyncClient(**config) as client:
            assert await client.models.support.generate(prompt='hello')==answer
            assert [event async for event in client.models.support.stream(prompt='hello')][-1].result==answer
    asyncio.run(run())
