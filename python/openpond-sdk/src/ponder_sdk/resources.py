from __future__ import annotations
from typing import Any, TypedDict
from .models import LearningResource
from .operations import prepare,finish
from .transport import Transport,AsyncTransport,MODEL_MEDIA,TRAINING_MEDIA
from .errors import PonderError,ProtocolError

class LearningPage(TypedDict):
    items: list[LearningResource]
    nextCursor: str | None

def limits(operation: dict[str,Any]) -> dict[str,Any]:
    path=operation['path'];media=operation['requestMediaType']
    if media not in ('application/json',MODEL_MEDIA,TRAINING_MEDIA):raise ProtocolError('unsupported_operation_media')
    if path.startswith('/v1/learning/'):
        return {'media':media,'request_limit':16777216,'response_limit':16777216}
    if path.startswith('/v1/model-projects'):
        return {'media':media,'request_limit':524288,'response_limit':8388608}
    large='/harness-sources/' in path or path=='/v1/training/artifacts'
    return {'media':media,'request_limit':67108864 if large or path.startswith('/v1/dataset-workspaces') else 1048576,'response_limit':67108864 if large else 138412032 if '/operations/' in path and path.startswith('/v1/dataset-workspaces') else 8388608}

class Resource:
    def __init__(self,transport: Transport,team_id: str):self._transport=transport;self.team_id=team_id
    def _execute(self,key: str,parameters:dict[str,Any],input:Any,query:dict[str,Any]|None,expected:Any) -> Any:
        operation,path,body,normalized_input,effective_query=prepare(key,self.team_id,parameters,input,query,expected)
        response=self._transport.request(operation['httpMethod'],path,body,**limits(operation))
        try:return finish(operation,self.team_id,parameters,normalized_input,effective_query,response,expected)
        except ProtocolError as error:
            error.outcome_unknown=operation['httpMethod']!='GET'
            raise

class AsyncResource:
    def __init__(self,transport: AsyncTransport,team_id: str):self._transport=transport;self.team_id=team_id
    async def _execute(self,key: str,parameters:dict[str,Any],input:Any,query:dict[str,Any]|None,expected:Any) -> Any:
        operation,path,body,normalized_input,effective_query=prepare(key,self.team_id,parameters,input,query,expected)
        response=await self._transport.request(operation['httpMethod'],path,body,**limits(operation))
        try:return finish(operation,self.team_id,parameters,normalized_input,effective_query,response,expected)
        except ProtocolError as error:
            error.outcome_unknown=operation['httpMethod']!='GET'
            raise
