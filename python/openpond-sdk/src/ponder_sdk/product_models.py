"""Named text inference over the client's owned HTTP pool; never auto-retried."""
from __future__ import annotations
import asyncio
import json
import codecs
import time
import re
from dataclasses import dataclass
from typing import Any, AsyncIterator, Iterator, Literal, TypedDict
from .errors import PonderError, ProtocolError
from typing_extensions import Required
from .transport import Transport, AsyncTransport, configuration, parse_body

class ModelBinding(TypedDict, total=False):
    id: Required[str]
    streaming: bool

class Message(TypedDict):
    role: Literal['system', 'user', 'assistant']
    content: str

@dataclass(frozen=True)
class ModelUsage:
    input_tokens: int
    output_tokens: int
    total_tokens: int

@dataclass(frozen=True)
class ModelResult:
    text: str
    request_id: str
    model_id: str
    resolved_model_id: str
    finish_reason: str | None
    usage: ModelUsage | None
    system_fingerprint: str | None
    evidence: dict[str, Any] | None = None

@dataclass(frozen=True)
class ModelEvent:
    type: Literal['text', 'finish']
    text: str = ''
    result: ModelResult | None = None

class ModelBase:
    def __init__(self, transport: Transport | AsyncTransport, binding: str | ModelBinding, base_url: str, api_key: str):
        self._transport = transport
        self.id = binding if isinstance(binding, str) else binding['id']
        self.streaming = True if isinstance(binding, str) else binding.get('streaming', True)
        if not isinstance(self.id, str) or re.fullmatch(r'[a-z0-9][a-z0-9._:-]{2,127}',self.id) is None:
            raise ProtocolError('invalid_model_id')
        self.base_url, self.headers = configuration(base_url, api_key, transport.headers['X-OpenPond-Team-Id'])
        self.headers = {**self.headers, 'Content-Type': 'application/json', 'Accept-Encoding': 'identity'}
    def body(self, *, prompt: str | None = None, messages: list[Message] | None = None, temperature: float | None = None, max_tokens: int | None = None, stream: bool = False) -> bytes:
        if (prompt is None) == (messages is None): raise ProtocolError('supply_prompt_or_messages')
        if prompt is not None and not isinstance(prompt, str): raise ProtocolError('invalid_prompt')
        content = messages if messages is not None else [{'role': 'user', 'content': prompt}]
        if not content or len(content)>128 or any(set(m) != {'role', 'content'} or m['role'] not in ('system','user','assistant') or not isinstance(m['content'],str) or len(m['content'])>200000 for m in content): raise ProtocolError('unsupported_model_input')
        value: dict[str, Any] = {'model': self.id, 'messages': content, 'stream': stream}
        if temperature is not None:
            if isinstance(temperature,bool) or not isinstance(temperature,(int,float)) or not 0<=temperature<=2: raise ProtocolError('invalid_temperature')
            value['temperature'] = temperature
        if max_tokens is not None:
            if type(max_tokens) is not int or not 1<=max_tokens<=4096: raise ProtocolError('invalid_max_tokens')
            value['max_tokens'] = max_tokens
        if stream:
            if not self.streaming: raise ProtocolError('streaming_unsupported')
        data = json.dumps(value, allow_nan=False).encode()
        if len(data)>1048576: raise ProtocolError('payload_too_large')
        return data
    def result(self, chunk: dict[str, Any], response, text: str | None = None, finish: str | None = None) -> ModelResult:
        try:
            if not isinstance(chunk['id'],str) or not isinstance(chunk['model'],str): raise ValueError()
            if text is None:
                choice = chunk['choices'][0]
                if len(chunk['choices'])!=1 or choice['message'].get('tool_calls'): raise ValueError()
                text = choice['message']['content'] or ''
                finish = choice.get('finish_reason')
            if chunk.get('openpond') is not None and not isinstance(chunk['openpond'],dict): raise ValueError()
            if not isinstance(text,str) or finish is not None and not isinstance(finish,str) or chunk.get('system_fingerprint') is not None and not isinstance(chunk['system_fingerprint'],str): raise ValueError()
            raw = chunk.get('usage')
            usage = None
            if raw is not None:
                counts = [raw[k] for k in ('prompt_tokens','completion_tokens','total_tokens')]
                if any(type(v) is not int or v<0 for v in counts): raise ValueError()
                usage = ModelUsage(*counts)
            return ModelResult(text, response.headers.get('x-openpond-request-id') or response.headers.get('x-request-id') or chunk['id'], self.id, chunk['model'], finish, usage, chunk.get('system_fingerprint'), chunk.get('openpond'))
        except (KeyError, TypeError, ValueError, IndexError): raise ProtocolError('model_response_invalid', outcome_unknown=True) from None
    def check(self, response, stream: bool):
        if response.headers.get('content-encoding','identity') != 'identity': raise ProtocolError('unsupported_content_encoding',outcome_unknown=True)
        if not 200<=response.status_code<300: raise PonderError('model_request_rejected',status=response.status_code,outcome_unknown=response.status_code==408 or response.status_code>=500)
        if stream and 'text/event-stream' not in response.headers.get('content-type',''): raise ProtocolError('model_stream_invalid',outcome_unknown=True)

class StreamState:
    def __init__(self, model: ModelBase, response):
        self.model=model; self.response=response; self.data=[]; self.size=0; self.text=''; self.last=None; self.finish=None; self.usage=None; self.done=False; self.output_bytes=0
    def line(self, line: str) -> list[ModelEvent]:
        self.size += len(line.encode("utf-8"))
        if self.size>1048576: raise ProtocolError('stream_frame_too_large',outcome_unknown=True)
        if line.startswith('data:'): self.data.append(line[5:].lstrip())
        if line: return []
        data='\n'.join(self.data); self.data=[]; self.size=0
        if not data: return []
        if data=='[DONE]':
            if self.last is None or not self.finish: raise ProtocolError('model_stream_incomplete',outcome_unknown=True)
            self.done=True
            return [ModelEvent('finish',result=self.model.result({**self.last,'usage':self.usage},self.response,self.text,self.finish))]
        try:
            chunk=json.loads(data)
            if self.last and (chunk['id']!=self.last['id'] or chunk['model']!=self.last['model']): raise ValueError()
            if not isinstance(chunk['id'],str) or not isinstance(chunk['model'],str) or len(chunk['choices'])>1: raise ValueError()
            self.last=chunk
            if chunk.get('usage') is not None: self.usage=chunk['usage']
            choice=next(iter(chunk['choices']),{})
            delta=choice.get('delta',{})
            if delta.get('tool_calls'): raise ValueError()
            if choice.get('finish_reason'): self.finish=choice['finish_reason']
            text=delta.get('content') or ''
            if not isinstance(text,str): raise ValueError()
            self.text+=text
            self.output_bytes+=len(text.encode("utf-8"))
            if self.output_bytes>8388608: raise ValueError()
            return [ModelEvent('text',text=text)] if text else []
        except (ValueError,KeyError,TypeError): raise ProtocolError('model_stream_invalid',outcome_unknown=True) from None

class ProductModel(ModelBase):
    def generate(self, *, prompt: str | None = None, messages: list[Message] | None = None, temperature: float | None = None, max_tokens: int | None = None) -> ModelResult:
        body=self.body(prompt=prompt,messages=messages,temperature=temperature,max_tokens=max_tokens)
        deadline=time.monotonic()+self._transport.timeout
        try:
            with self._transport.client.stream('POST',self.base_url+'/chat/completions',headers=self.headers,content=body) as response:
                self.check(response,False)
                data=bytearray()
                for chunk in response.iter_bytes():
                    if time.monotonic()>deadline: raise PonderError('request_deadline',outcome_unknown=True)
                    data.extend(chunk)
                    if len(data)>8388608: raise ProtocolError('response_too_large',outcome_unknown=True)
                return self.result(parse_body(bytes(data),response.status_code),response)
        except PonderError as error:
            if error.status is None or error.status==408 or error.status>=500: error.outcome_unknown=True
            raise
        except Exception: raise PonderError('model_outcome_unknown',outcome_unknown=True) from None
    def stream(self, *, prompt: str | None = None, messages: list[Message] | None = None, temperature: float | None = None, max_tokens: int | None = None) -> Iterator[ModelEvent]:
        body=self.body(prompt=prompt,messages=messages,temperature=temperature,max_tokens=max_tokens,stream=True)
        deadline=time.monotonic()+self._transport.timeout
        try:
            with self._transport.client.stream('POST',self.base_url+'/chat/completions',headers=self.headers,content=body) as response:
                self.check(response,True); state=StreamState(self,response)
                decoder=codecs.getincrementaldecoder('utf-8')();buffer=''
                for chunk in response.iter_bytes():
                    if time.monotonic()>deadline: raise PonderError('request_deadline',outcome_unknown=True)
                    buffer=(buffer+decoder.decode(chunk)).replace('\r\n','\n')
                    while '\n' in buffer:
                        line,buffer=buffer.split('\n',1)
                        yield from state.line(line)
                        if state.done: return
                    if len(buffer.encode("utf-8"))>1048576: raise ProtocolError('stream_frame_too_large',outcome_unknown=True)
                raise ProtocolError('model_stream_incomplete',outcome_unknown=True)
        except PonderError as error:
            if error.status is None or error.status==408 or error.status>=500: error.outcome_unknown=True
            raise
        except Exception: raise PonderError('model_outcome_unknown',outcome_unknown=True) from None

class AsyncProductModel(ModelBase):
    async def generate(self, *, prompt: str | None = None, messages: list[Message] | None = None, temperature: float | None = None, max_tokens: int | None = None) -> ModelResult:
        try:
            return await asyncio.wait_for(self._generate(prompt=prompt,messages=messages,temperature=temperature,max_tokens=max_tokens),timeout=self._transport.timeout)
        except asyncio.TimeoutError: raise PonderError('request_deadline',outcome_unknown=True) from None

    async def _generate(self, *, prompt: str | None = None, messages: list[Message] | None = None, temperature: float | None = None, max_tokens: int | None = None) -> ModelResult:
        body=self.body(prompt=prompt,messages=messages,temperature=temperature,max_tokens=max_tokens)
        try:
            async with self._transport.client.stream('POST',self.base_url+'/chat/completions',headers=self.headers,content=body) as response:
                self.check(response,False)
                data=bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data)>8388608: raise ProtocolError('response_too_large',outcome_unknown=True)
                return self.result(parse_body(bytes(data),response.status_code),response)
        except asyncio.CancelledError: raise
        except PonderError as error:
            if error.status is None or error.status==408 or error.status>=500: error.outcome_unknown=True
            raise
        except Exception: raise PonderError('model_outcome_unknown',outcome_unknown=True) from None
    async def stream(self, *, prompt: str | None = None, messages: list[Message] | None = None, temperature: float | None = None, max_tokens: int | None = None) -> AsyncIterator[ModelEvent]:
        body=self.body(prompt=prompt,messages=messages,temperature=temperature,max_tokens=max_tokens,stream=True)
        deadline=time.monotonic()+self._transport.timeout
        try:
            async with self._transport.client.stream('POST',self.base_url+'/chat/completions',headers=self.headers,content=body) as response:
                self.check(response,True); state=StreamState(self,response)
                iterator=response.aiter_bytes();decoder=codecs.getincrementaldecoder('utf-8')();buffer=''
                while True:
                    try: chunk=await asyncio.wait_for(iterator.__anext__(),timeout=max(0.001,deadline-time.monotonic()))
                    except StopAsyncIteration: break
                    buffer=(buffer+decoder.decode(chunk)).replace('\r\n','\n')
                    while '\n' in buffer:
                        line,buffer=buffer.split('\n',1)
                        for event in state.line(line): yield event
                        if state.done: return
                    if len(buffer.encode("utf-8"))>1048576: raise ProtocolError('stream_frame_too_large',outcome_unknown=True)
                raise ProtocolError('model_stream_incomplete',outcome_unknown=True)
        except asyncio.CancelledError: raise
        except PonderError as error:
            if error.status is None or error.status==408 or error.status>=500: error.outcome_unknown=True
            raise
        except Exception: raise PonderError('model_outcome_unknown',outcome_unknown=True) from None
