"""Tool-learning identities, project scope and resource boundaries.

Harness content seals are host-authenticated declarations, as for portable
Harness/Learning packages. Never substitute compact training canonical_sha256:
Harness uses a different canonical format. This client preserves those seals,
checks receipt identities and exact echoed configuration, and leaves their
admission to the canonical host. Mutations are never automatically replayed.
"""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote, urlencode
from .errors import ProtocolError
from .wire import canonical_json, validate


def bounded(value: Any, maximum: int = 65536) -> None:
    pending = [(value, 0, False)]
    ancestors: set[int] = set()
    nodes = 0
    while pending:
        item, depth, leaving = pending.pop()
        if leaving:
            ancestors.remove(id(item))
            continue
        nodes += 1
        if nodes > 100000 or depth > 48:
            raise ProtocolError('tool_learning_json_complexity')
        if type(item) in (dict, list):
            if id(item) in ancestors:
                raise ProtocolError('tool_learning_json_cycle')
            ancestors.add(id(item))
            pending.append((item, depth, True))
            if type(item) is dict:
                if any(type(key) is not str for key in item) or 'toJSON' in item:
                    raise ProtocolError('tool_learning_json_object')
                pending.extend((child, depth + 1, False) for child in item.values())
            else:
                if len(item) > 10000:
                    raise ProtocolError('tool_learning_json_array')
                pending.extend((child, depth + 1, False) for child in item)
        elif type(item) not in (str, int, float, bool, type(None)):
            raise ProtocolError('tool_learning_json_value')
    if len(canonical_json(value).encode('utf-8')) > maximum:
        raise ProtocolError('tool_learning_payload_too_large')


def scope(value: dict[str, Any], team: str, project: str) -> None:
    if value.get('scope') != {'teamId': team, 'projectId': project}:
        raise ProtocolError('tool_learning_scope_mismatch')


def same(actual: Any, expected: Any, code: str) -> None:
    if canonical_json(actual) != canonical_json(expected):
        raise ProtocolError(code)


def policy(value: dict[str, Any]) -> None:
    sampling = value['unchangedControls']
    if sampling['numerator'] > sampling['denominator']:
        raise ProtocolError('tool_learning_invalid_sampling')
    for field in ('permittedTools', 'workspaceRootHashes', 'permittedFields', 'purposes'):
        if len(value[field]) != len(set(value[field])):
            raise ProtocolError('tool_learning_duplicate_policy_entry')
    if min(value['maximumEpisodeBytes'], value['maximumQueueBytes']) < value['maximumEventBytes']:
        raise ProtocolError('tool_learning_invalid_capacity')


def text(value: str, maximum: int) -> None:
    # ECMAScript UTF-8 encoding replaces unpaired surrogates with U+FFFD.
    normalized = value.encode('utf-16-le', 'surrogatepass').decode('utf-16-le', 'replace')
    if len(normalized.encode('utf-8')) > maximum:
        raise ProtocolError('tool_learning_text_too_large')


def action(value: dict[str, Any]) -> None:
    bounded(value, 16384)
    kind = value['kind']
    if kind in ('python', 'shell', 'edit'):
        text(value[{'python': 'code', 'shell': 'command', 'edit': 'patch'}[kind]], 16384)
    if kind == 'edit':
        for file in value['baseFiles']:
            path = file['path']
            if path.startswith('/') or '\\' in path or len(path) > 1 and path[1] == ':' or any(part in ('', '.', '..') for part in path.split('/')):
                raise ProtocolError('tool_learning_invalid_relative_path')


def environment(value: dict[str, Any]) -> None:
    state = value['state']
    bounded(state, 8192)
    if len(state) > 32:
        raise ProtocolError('tool_learning_state_fields_exceeded')
    for item in state.values():
        if isinstance(item, str):
            text(item, 2000)


def event(value: dict[str, Any]) -> None:
    bounded(value)
    payload = value['payload']
    kind = value['eventKind']
    if kind == 'attempt':
        action(payload['action'])
        environment(payload['environment'])
        text(payload['intent'], 2000)
        sampling = payload['selection']
        if sampling['kind'] == 'unchanged_control' and sampling['numerator'] > sampling['denominator']:
            raise ProtocolError('tool_learning_invalid_sampling')
    elif kind == 'observation':
        text(payload['resultExcerpt'], 8192)
        if payload['outcome'] == 'failed':
            text(payload['message'], 2000)
        if payload['execution'] == 'not_executed' and payload['sideEffects'] != 'none':
            raise ProtocolError('tool_learning_invalid_execution')
        if payload['outcome'] == 'succeeded' and payload['execution'] != 'executed':
            raise ProtocolError('tool_learning_invalid_execution')
        if payload['outcome'] == 'failed':
            if payload['classification'] == 'validation_failure' and payload['execution'] != 'not_executed':
                raise ProtocolError('tool_learning_invalid_execution')
            if payload['classification'] == 'process_failure' and (payload['execution'] != 'executed' or payload['exitCode'] in (None, 0)):
                raise ProtocolError('tool_learning_invalid_process_failure')
    elif kind == 'recovery_link':
        if payload['failedAttempt']['id'] == payload['replacementAttempt']['id'] or payload['basis'] != 'unverified' and not payload['attributionEvidence']:
            raise ProtocolError('tool_learning_invalid_recovery_link')
    elif kind == 'verification':
        if payload['outcome'] != 'unknown' and (not payload['verifierRelease'] or not payload['verifierReceipt']):
            raise ProtocolError('tool_learning_missing_verifier_receipt')
        text(payload['reason'], 2000)
    elif kind == 'lineage':
        text(payload['reason'], 1000)


def prepare(operation: dict[str, Any], team: str, project: str, parameters: dict[str, Any], value: Any, query: dict[str, Any] | None) -> tuple[str, Any, Any]:
    method = operation['pythonMethod']
    bounded(value, 2097152 if method == 'append' else 65536)
    body = validate(operation['requestSchema'], value, request=True) if operation['requestSchema'] else None
    path = operation['path']
    for name, raw in parameters.items():
        identifier = validate('ToolLearningIdSchema', raw, request=True)
        path = path.replace('{' + name + '}', quote(identifier, safe=''))
    if '{' in path:
        raise ProtocolError('tool_learning_missing_resource_id')
    if body is not None and method in ('consult', 'consultation'):
        scope(body, team, project)
        action(body['action'])
        environment(body['environment'])
        text(body['intent'], 2000)
        text(body['failure']['message'], 8192)
        if method == 'consultation' and any(body[key] != parameters[key] for key in ('installationId', 'operationId')):
            raise ProtocolError('tool_learning_consultation_identity_mismatch')
    if method == 'register':
        if body['registration']['projectId'] != project:
            raise ProtocolError('tool_learning_project_mismatch')
        policy(body['registration']['collectionPolicy'])
    if method == 'append':
        ids = set()
        for item in body['events']:
            if item['installationId'] != body['installationId'] or item['eventId'] in ids:
                raise ProtocolError('tool_learning_append_scope_mismatch')
            ids.add(item['eventId'])
            event(item)
    effective_query = dict(query or {})
    if set(effective_query) - ({'after'} if method in ('installations', 'episodes') else set()):
        raise ProtocolError('tool_learning_invalid_query')
    if 'after' in effective_query:
        effective_query['after'] = validate('ToolLearningIdSchema', effective_query['after'], request=True)
    if method == 'installations':
        effective_query['projectId'] = project
    if effective_query:
        path += '?' + urlencode(effective_query)
    return path, None if operation['httpMethod'] == 'GET' else body, body


def installation(value: dict[str, Any], team: str, project: str, identifier: str) -> None:
    scope(value, team, project)
    if value['id'] != identifier:
        raise ProtocolError('tool_learning_installation_mismatch')
    policy(value['collectionPolicy'])
    coverage = value['coverage']
    if 'observed' in coverage.values() and not coverage['receipt']:
        raise ProtocolError('tool_learning_missing_coverage_receipt')


def finish(operation: dict[str, Any], team: str, project: str, parameters: dict[str, Any], body: Any, raw: Any) -> Any:
    bounded(raw, 2097152)
    result = validate(operation['responseSchema'], raw)
    method = operation['pythonMethod']
    identifier = parameters.get('installationId')
    if method == 'register':
        registration = body['registration']
        installed = result['installation']
        installation(installed, team, project, registration['installationId'])
        if result['apiKey'] != body['credential']['apiKey'] or installed['credential'] is None or installed['credential']['expiresAt'] != body['credential']['expiresAt']:
            raise ProtocolError('tool_learning_credential_mismatch')
        for field in ('client', 'clientVersion', 'machineSourceId', 'adapterRelease', 'collectionPolicy'):
            same(installed[field], registration[field], 'tool_learning_registration_mismatch')
    elif method in ('installation', 'set_state'):
        installation(result, team, project, identifier)
        if method == 'set_state' and result['state'] != body['state']:
            raise ProtocolError('tool_learning_state_mismatch')
    elif method == 'installations':
        identities = []
        for item in result['items']:
            installation(item, team, project, item['id'])
            identities.append(item['id'])
        if len(identities) != len(set(identities)) or result['nextCursor'] is not None and (not identities or result['nextCursor'] != identities[-1]):
            raise ProtocolError('tool_learning_installation_page_mismatch')
    elif method in ('episodes', 'episode', 'routing', 'configure_routing', 'manifest'):
        scope(result, team, project)
        if result['installationId'] != identifier:
            raise ProtocolError('tool_learning_installation_mismatch')
        if method == 'episodes':
            identities = [item['episodeId'] for item in result['items']]
            if len(identities) != len(set(identities)) or result['nextCursor'] is not None and (not identities or result['nextCursor'] != identities[-1]):
                raise ProtocolError('tool_learning_episode_page_mismatch')
        elif method == 'episode':
            if result['episodeId'] != parameters['episodeId'] or result['state'] != result['assembly']['state']:
                raise ProtocolError('tool_learning_episode_mismatch')
            for item in result['events']:
                if item['installationId'] != identifier or item['episodeId'] != parameters['episodeId']:
                    raise ProtocolError('tool_learning_episode_scope_mismatch')
                event(item)
        elif method == 'configure_routing':
            if result['operationId'] != body['operationId']:
                raise ProtocolError('tool_learning_operation_mismatch')
            same(result['configuration'], body, 'tool_learning_routing_mismatch')
        elif method == 'manifest':
            bounded(result)
            issued = datetime.fromisoformat(result['issuedAt'].replace('Z', '+00:00')).timestamp()
            expires = datetime.fromisoformat(result['expiresAt'].replace('Z', '+00:00')).timestamp()
            now = datetime.now(timezone.utc).timestamp()
            capabilities = [item['id'] for item in result['capabilities']]
            if not 0 < expires - issued <= 300 or expires <= now or issued > now + 30 or len(capabilities) != len(set(capabilities)):
                raise ProtocolError('tool_learning_invalid_manifest')
    elif method in ('purge', 'project'):
        if result['installationId'] != identifier or result['operationId'] != body['operationId'] or method == 'project' and result['projectId'] != project:
            raise ProtocolError('tool_learning_operation_mismatch')
    elif method == 'append':
        if result['teamId'] != team or result['projectId'] != project or result['installationId'] != body['installationId'] or result['operationId'] != body['operationId']:
            raise ProtocolError('tool_learning_append_scope_mismatch')
        expected = {item['eventId']: item['contentHash'] for item in body['events']}
        actual = {item['eventId']: item['contentHash'] for item in result['events']}
        if actual != expected or len(result['events']) != len(expected):
            raise ProtocolError('tool_learning_append_receipt_mismatch')
    elif method in ('consult', 'consultation'):
        bounded(result)
        for field in ('operationId', 'installationId', 'capabilityId', 'manifestHash', 'modelRelease', 'actionHash', 'contextHash'):
            same(result[field], body[field], 'tool_learning_consultation_mismatch')
    if method in ('routing', 'configure_routing', 'manifest'):
        for capability in result['capabilities']:
            text(capability['routingInstruction'], 2000)
    if method in ('consult', 'consultation') and result['state'] == 'completed':
        decision = result['decision']
        for issue in decision.get('issues', []):
            text(issue['feedback'], 2000)
        for missing in decision.get('missing', []):
            text(missing['reason'], 500)
    return result
