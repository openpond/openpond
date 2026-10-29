"""Project-bound tool-learning calls reuse the client's native connection pool."""
from __future__ import annotations
from typing import Any
from .errors import ProtocolError
from .operations import OPERATIONS
from .tool_learning_validation import prepare, finish
from .transport import Transport, AsyncTransport
from .wire import validate


class ToolLearningResource:
    def __init__(self, transport: Transport, team_id: str, project_id: str):
        self._transport = transport
        self.team_id = team_id
        self.project_id = validate('ToolLearningIdSchema', project_id, request=True)

    def _execute(self, key: str, parameters: dict[str, Any], value: Any, query: dict[str, Any] | None, expected: Any = None) -> Any:
        operation = OPERATIONS[key]
        path, body, retained = prepare(operation, self.team_id, self.project_id, parameters, value, query)
        response = self._transport.request(operation['httpMethod'], path, body, media='application/json', request_limit=2097152, response_limit=2097152)
        try:
            return finish(operation, self.team_id, self.project_id, parameters, retained, response)
        except ProtocolError as error:
            error.outcome_unknown = operation['httpMethod'] != 'GET'
            raise


class AsyncToolLearningResource:
    def __init__(self, transport: AsyncTransport, team_id: str, project_id: str):
        self._transport = transport
        self.team_id = team_id
        self.project_id = validate('ToolLearningIdSchema', project_id, request=True)

    async def _execute(self, key: str, parameters: dict[str, Any], value: Any, query: dict[str, Any] | None, expected: Any = None) -> Any:
        operation = OPERATIONS[key]
        path, body, retained = prepare(operation, self.team_id, self.project_id, parameters, value, query)
        response = await self._transport.request(operation['httpMethod'], path, body, media='application/json', request_limit=2097152, response_limit=2097152)
        try:
            return finish(operation, self.team_id, self.project_id, parameters, retained, response)
        except ProtocolError as error:
            error.outcome_unknown = operation['httpMethod'] != 'GET'
            raise
