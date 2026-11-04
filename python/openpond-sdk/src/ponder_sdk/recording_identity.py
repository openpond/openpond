"""Local, immutable external observations. Hashes do not attest measurements."""
from __future__ import annotations
from typing import Any
from .errors import ProtocolError
from .neuron_steering import verify_activation_request, verify_activation_result
from .wire import canonical_json, canonical_sha256, validate, verify_hash


def verify_recording_request(raw: Any) -> dict[str, Any]:
    value = validate('ModificationRecordingRequestSchema', raw, request=True)
    if len(canonical_json(value).encode('utf-8')) > 8_388_608:
        raise ProtocolError('modification_recording_too_large')
    request = verify_activation_request(value['request'])
    verify_activation_result(value['result'], request)
    profiles = sum(row['profile'] is not None for row in request['variants'])
    if (profiles > 0 if value['method'] == 'inspect_activations' else profiles == 0 or profiles == len(request['variants'])):
        raise ProtocolError('modification_recording_method_mismatch')
    return value


def verify_recording(raw: Any, team_id: str, actor_id: str | None = None) -> dict[str, Any]:
    value = validate('ModificationRecordingSchema', raw)
    verify_hash(value, 'contentHash')
    identity = 'observation-' + canonical_sha256({'scope': value['accountScopeHash'], 'operationId': value['operationId']})
    if (value['teamId'] != team_id or actor_id is not None and value['actorId'] != actor_id or value['id'] != identity
            or value['counts']['outcomes'] != value['counts']['prompts'] * value['counts']['variants']):
        raise ProtocolError('modification_recording_scope_mismatch')
    return value


def verify_recording_read(raw: Any, team_id: str, actor_id: str | None = None) -> dict[str, Any]:
    value = validate('ModificationRecordingReadSchema', raw)
    record = verify_recording(value['recording'], team_id, actor_id)
    document = value['document']
    command = verify_recording_request({'schemaVersion': 'openpond.modificationRecordingRequest.v1',
        **{key: record[key] for key in ('teamId', 'operationId', 'name', 'projectId', 'method')}, **document})
    counts = {'prompts': len(command['request']['prompts']), 'variants': len(command['request']['variants']),
              'outcomes': len(command['result']['outcomes']), 'captures': len(command['result']['captures'])}
    if (record['commandHash'] != canonical_sha256(command) or record['artifact']['contentHash'] != canonical_sha256(document)
            or record['artifact']['sizeBytes'] != len(canonical_json(document).encode('utf-8'))
            or record['inputHash'] != canonical_sha256(document['request']) or record['resultHash'] != document['result']['contentHash']
            or record['model'] != document['request']['model'] or record['counts'] != counts):
        raise ProtocolError('modification_recording_artifact_mismatch')
    return value


def finish(schema: str, value: dict[str, Any], team_id: str, parameters: dict[str, Any], body: dict[str, Any]) -> None:
    if schema == 'ModificationRecordingSchema':
        record = verify_recording(value, team_id)
        if record['operationId'] != body['operationId'] or record['commandHash'] != canonical_sha256(body):
            raise ProtocolError('modification_recording_request_mismatch')
    elif schema == 'ModificationRecordingReadSchema':
        record = verify_recording_read(value, team_id)['recording']
        if record['id'] != parameters['id']:
            raise ProtocolError('modification_recording_scope_mismatch')
    else:
        if (value['teamId'] != team_id or value['projectId'] != body.get('projectId') or len(value['items']) > body['limit']
                or len({row['id'] for row in value['items']}) != len(value['items'])
                or body.get('cursor') and value['nextCursor'] == body['cursor']):
            raise ProtocolError('modification_recording_scope_mismatch')
        for row in value['items']:
            verify_recording(row, team_id, value['actorId'])
            if row['accountScopeHash'] != value['accountScopeHash'] or body.get('projectId') and row['projectId'] != body['projectId']:
                raise ProtocolError('modification_recording_scope_mismatch')
