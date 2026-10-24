"""Bounded native HTTP clients; mutations are never automatically replayed."""
from __future__ import annotations
import asyncio
import json
import math
import re
import time
from urllib.parse import urlsplit
from typing import Any
import httpx
from .errors import PonderError, ProtocolError
from .wire import canonical_json

TRAINING_MEDIA = 'application/vnd.openpond.training+json;version=2'
MODEL_MEDIA = 'application/vnd.openpond.model-project+json;version=2'


def configuration(base_url: str, api_key: str, team_id: str) -> tuple[str, dict[str,str]]:
    try:
        url=urlsplit(base_url);url.port
    except (ValueError,TypeError):raise ProtocolError('invalid_base_url') from None
    if url.scheme not in ('http','https') or not url.netloc or url.username or url.password or url.query or url.fragment:
        raise ProtocolError('invalid_base_url')
    if not isinstance(api_key,str) or not isinstance(team_id,str) or not api_key or not team_id or any(not 33<=ord(c)<=126 for c in api_key+team_id):
        raise ProtocolError('invalid_credentials_or_scope')
    return base_url.rstrip('/'), {'Authorization':'Bearer '+api_key, 'X-OpenPond-Team-Id':team_id}


def finite_int(value: str) -> int:
    result=int(value)
    try:
        number=float(result)
        if not math.isfinite(number):raise ValueError()
    except OverflowError:raise ValueError() from None
    # JSON.parse represents every numeric token as finite binary64, including
    # shortest decimal integer spellings that round to a nearby integer.
    return int(number)

def finite_float(value: str) -> float:
    result=float(value)
    if not math.isfinite(result):raise ValueError()
    return result

def parse_body(body: bytes, status: int) -> Any:
    try: value=json.loads(body.decode('utf-8'), parse_float=finite_float, parse_int=finite_int, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, UnicodeError): raise ProtocolError('invalid_json', status=status) from None
    if not 200<=status<300:
        code=value.get('code') if isinstance(value,dict) else None
        if not isinstance(code,str) or re.fullmatch(r'[a-z][a-z0-9_]{0,127}',code) is None: code='request_failed'
        raise PonderError(code,status=status)
    return value

class Transport:
    def __init__(self, base_url: str, api_key: str, team_id: str, *, timeout: float = 30, read_attempts: int = 3):
        self.base_url,self.headers=configuration(base_url,api_key,team_id)
        if not 0<timeout<=300 or not 1<=read_attempts<=3: raise ProtocolError('invalid_transport_limits')
        self.timeout=timeout; self.read_attempts=read_attempts
        try:self.client=httpx.Client(timeout=httpx.Timeout(timeout),follow_redirects=False,trust_env=False)
        except (httpx.InvalidURL,ValueError,RuntimeError):raise ProtocolError('native_client_initialization_failed') from None
    def close(self) -> None:
        try:self.client.close()
        except (httpx.HTTPError,httpx.StreamError,OSError,RuntimeError):raise PonderError('native_client_close_failed') from None
    def request(self, method: str, path: str, body: Any = None, *, media: str = TRAINING_MEDIA, response_limit: int = 8388608, request_limit: int = 1048576) -> Any:
        if not path.startswith('/v1/') or path.startswith('//'): raise ProtocolError('invalid_api_path')
        content=None if body is None else canonical_json(body).encode()
        if content is not None and len(content)>request_limit: raise ProtocolError('payload_too_large')
        attempts=self.read_attempts if method=='GET' else 1
        for attempt in range(attempts):
            try:
                deadline=time.monotonic()+self.timeout
                with self.client.stream(method,self.base_url+path,content=content,headers={**self.headers,'Accept':media,'Accept-Encoding':'identity',**({'Content-Type':media} if content is not None else {})}) as response:
                    data=bytearray()
                    if response.headers.get('content-encoding','identity')!='identity':raise ProtocolError('unsupported_content_encoding')
                    for chunk in response.iter_raw():
                        if time.monotonic()>deadline:raise PonderError('request_deadline',outcome_unknown=method!='GET')
                        if len(data)+len(chunk)>response_limit: raise ProtocolError('response_too_large')
                        data.extend(chunk)
                    return parse_body(bytes(data),response.status_code)
            except (httpx.InvalidURL,httpx.StreamError,UnicodeError,ValueError,RuntimeError):
                raise PonderError('native_request_failed',outcome_unknown=method!='GET') from None
            except httpx.TransportError:
                if attempt+1==attempts: raise PonderError('transport_failed',outcome_unknown=method!='GET') from None
            except PonderError as error:
                if method!='GET' and (error.status is None or error.status>=500):error.outcome_unknown=True
                if method!='GET' or attempt+1==attempts or error.status not in (408,429,500,502,503,504): raise
            time.sleep(0.25*2**attempt)
        raise ProtocolError('read_retry_exhausted')

class AsyncTransport:
    def __init__(self, base_url: str, api_key: str, team_id: str, *, timeout: float = 30, read_attempts: int = 3):
        self.base_url,self.headers=configuration(base_url,api_key,team_id)
        if not 0<timeout<=300 or not 1<=read_attempts<=3: raise ProtocolError('invalid_transport_limits')
        self.timeout=timeout;self.read_attempts=read_attempts
        try:self.client=httpx.AsyncClient(timeout=httpx.Timeout(timeout),follow_redirects=False,trust_env=False)
        except (httpx.InvalidURL,ValueError,RuntimeError):raise ProtocolError('native_client_initialization_failed') from None
    async def close(self) -> None:
        try:await self.client.aclose()
        except (httpx.HTTPError,httpx.StreamError,OSError,RuntimeError):raise PonderError('native_client_close_failed') from None
    async def request(self, method: str, path: str, body: Any = None, *, media: str = TRAINING_MEDIA, response_limit: int = 8388608, request_limit: int = 1048576) -> Any:
        try:
            return await asyncio.wait_for(self._request(method,path,body,media=media,response_limit=response_limit,request_limit=request_limit),timeout=self.timeout)
        except RuntimeError:
            raise PonderError('native_async_runtime_unavailable',outcome_unknown=method!='GET') from None
        except asyncio.TimeoutError:
            raise PonderError('request_deadline',outcome_unknown=method!='GET') from None

    async def _request(self, method: str, path: str, body: Any = None, *, media: str = TRAINING_MEDIA, response_limit: int = 8388608, request_limit: int = 1048576) -> Any:
        if not path.startswith('/v1/') or path.startswith('//'): raise ProtocolError('invalid_api_path')
        content=None if body is None else canonical_json(body).encode()
        if content is not None and len(content)>request_limit: raise ProtocolError('payload_too_large')
        attempts=self.read_attempts if method=='GET' else 1
        for attempt in range(attempts):
            try:
                deadline=time.monotonic()+self.timeout
                async with self.client.stream(method,self.base_url+path,content=content,headers={**self.headers,'Accept':media,'Accept-Encoding':'identity',**({'Content-Type':media} if content is not None else {})}) as response:
                    data=bytearray()
                    if response.headers.get('content-encoding','identity')!='identity':raise ProtocolError('unsupported_content_encoding')
                    async for chunk in response.aiter_raw():
                        if time.monotonic()>deadline:raise PonderError('request_deadline',outcome_unknown=method!='GET')
                        if len(data)+len(chunk)>response_limit: raise ProtocolError('response_too_large')
                        data.extend(chunk)
                    return parse_body(bytes(data),response.status_code)
            except (httpx.InvalidURL,httpx.StreamError,UnicodeError,ValueError,RuntimeError):
                raise PonderError('native_request_failed',outcome_unknown=method!='GET') from None
            except httpx.TransportError:
                if attempt+1==attempts: raise PonderError('transport_failed',outcome_unknown=method!='GET') from None
            except PonderError as error:
                if method!='GET' and (error.status is None or error.status>=500):error.outcome_unknown=True
                if method!='GET' or attempt+1==attempts or error.status not in (408,429,500,502,503,504): raise
            await asyncio.sleep(0.25*2**attempt)
        raise ProtocolError('read_retry_exhausted')
