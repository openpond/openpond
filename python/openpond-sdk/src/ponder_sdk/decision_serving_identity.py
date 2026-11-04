"""Exact Decision Model scoring and serving receipts, without chat coercion.

Pool/runtime/binding facts are server-attested. Arithmetic is verified against
all original candidates; a self-consistent metadata hash is not runtime proof.
"""
from typing import Any
from .decision_identity import _bounded, _content_matches, _same_value, _scoring_input, _text, verify_decision_scoring_result
from .decision_execution_identity import prepare_decision_expectation
from .decision_version_identity import verify_decision_model_version
from .errors import ProtocolError
from .managed_serving_usage_identity import approval_matches, verify_usage_billing
from .steering_serving_identity import serving_state
from .wire import canonical_sha256, validate, verify_hash


def fail(code: str = 'decision_model_serving_mismatch') -> None:
    raise ProtocolError(code)


def parse_decision_model_score_request(raw: Any) -> dict[str, Any]:
    _bounded(raw, 131_072)
    value = validate('DecisionModelScoreRequestSchema', raw, request=True)
    for key in ('teamId', 'requestId'):
        _text(value[key], 240, nonblank=True)
    _scoring_input(value['input'])
    return value


def resolved_decision_selection(raw: Any) -> dict[str, Any]:
    version = verify_decision_model_version(raw)
    return validate('ResolvedDecisionSelectionSchema', {
        'schemaVersion': 'openpond.resolvedDecisionSelection.v1',
        'savedModel': {'modelProjectId': version['modelProjectId'], 'versionHash': version['contentHash']},
        'modelHash': canonical_sha256(version['request']['model']),
        'artifact': {'id': version['artifact']['id'], 'contentHash': version['artifact']['contentHash'],
                     'payloadSha256': version['artifact']['manifest']['payload']['sha256']},
    })


def verify_resolved_decision_selection(raw: Any, version: Any) -> dict[str, Any]:
    value = validate('ResolvedDecisionSelectionSchema', raw)
    if not _same_value(value, resolved_decision_selection(version)):
        fail('decision_selection_mismatch')
    return value


def verify_decision_model_score_receipt(raw: Any, request: Any, *, model_project_id: str,
                                        actor_id: str | None = None, admission: dict[str, Any] | None = None) -> dict[str, Any]:
    if admission is not None:
        prepare_decision_expectation('score_decision_model', {'admission': admission})
    _bounded(raw, 1_048_576)
    command = parse_decision_model_score_request(request)
    value = validate('DecisionModelScoreReceiptSchema', raw)
    version = verify_decision_model_version(value['version'], team_id=command['teamId'], model_project_id=model_project_id,
                                           owner_user_id=value['actorId'], version_hash=command['versionHash'])
    verify_resolved_decision_selection(value['selection'], version)
    scoring = {'schemaVersion': 'openpond.decisionScoringRequest.v1', 'model': version['request']['model'],
               'artifact': {'id': version['artifact']['id'], 'contentHash': version['artifact']['contentHash']},
               'input': command['input'], 'limits': command['limits']}
    verify_decision_scoring_result(value['result'], scoring, value['runtimeHash'])
    if (not _content_matches(value) or value['teamId'] != command['teamId'] or value['modelProjectId'] != model_project_id
            or value['requestId'] != command['requestId'] or actor_id is not None and value['actorId'] != actor_id
            or value['requestHash'] != canonical_sha256({'modelProjectId': model_project_id, 'request': command})):
        fail('decision_model_score_mismatch')
    if admission is not None and (any(not _same_value(value[key], admission[key]) for key in
            ('poolId', 'routingBinding', 'runtimeHash', 'workerImageDigest'))
            or any(key in admission and value[key] != admission[key] for key in ('engineGeneration', 'cacheNamespace'))):
        fail('decision_model_score_mismatch')
    return value


def _valid_control(value: dict[str, Any]) -> bool:
    return (value['modelId'] == 'decision:model:' + value['modelProjectId']
            and (value['binding'] is None or value['poolId'] is not None)
            and (value['phase'] != 'active' or value['desiredState'] == 'active' and value['poolId'] is not None
                 and value['binding'] is not None and value['capacityState'] in ('pending', 'shared'))
            and (value['phase'] != 'stopping' or value['desiredState'] == 'stopped')
            and (value['capacityState'] != 'released' or value['binding'] is None
                 and value['activeRequests'] == 0 and value['unsettledRequests'] == 0)
            and (value['phase'] != 'stopped' or value['desiredState'] == 'stopped' and value['binding'] is None
                 and value['activeRequests'] == 0 and value['unsettledRequests'] == 0 and value['capacityState'] in ('shared', 'released')))


def verify_decision_model_serving(raw: Any, team_id: str, model_project_id: str, version_hash: str, *,
                                   owner_user_id: str | None = None) -> dict[str, Any]:
    value = validate('DecisionModelServingSchema', raw)
    verify_usage_billing(value, team_id, model_project_id, version_hash, 'decision')
    verify_hash(value, 'contentHash')
    version = verify_decision_model_version(value['version'], team_id=team_id, model_project_id=model_project_id,
                                           owner_user_id=owner_user_id, version_hash=version_hash)
    availability, control = value['availability'], value['control']
    if (value['teamId'] != team_id or value['modelProjectId'] != model_project_id or value['state'] != serving_state(value)
            or (availability['state'] == 'qualified') != (availability['reason'] == 'qualified')
            or availability['state'] == 'qualified' and availability['runtimeHash'] is None):
        fail()
    for rows in (value['pools'], value['bindings']):
        if len({row['id'] for row in rows}) != len(rows):
            fail()
    controls = value['cleanup'] + ([control] if control is not None else [])
    if any(row['teamId'] != team_id or row['modelProjectId'] != model_project_id or not _valid_control(row) for row in controls):
        fail()
    if (len({row['operationId'] for row in value['cleanup']}) != len(value['cleanup'])
            or any(row['desiredState'] != 'stopped' for row in value['cleanup'])
            or control is not None and control['versionHash'] != version_hash and not (control['phase'] == 'stopped' and control['desiredState'] == 'stopped')):
        fail()
    pools = {row['id']: row for row in value['pools']}
    if any(row['versionHash'] != version_hash or row['modelId'] != 'decision:model:' + model_project_id or row['poolId'] not in pools for row in value['bindings']):
        fail()
    if control is not None and control['binding'] is not None and not any(
            row['id'] == control['binding']['id'] and row['revision'] == control['binding']['revision']
            and row['poolId'] == control['poolId'] and row['modelId'] == control['modelId'] for row in value['bindings']):
        fail()
    if any(row['workersMin'] > row['workersMax'] for row in value['pools']):
        fail()
    score = value['lastVerifiedScore']
    if score is not None:
        verify_resolved_decision_selection(score['selection'], version)
        # No original raw score input is present in a serving read. Verify the
        # retained identity here; full T1 arithmetic needs the original command.
        if (not _content_matches(score) or not _content_matches(score['result']) or score['teamId'] != team_id
                or score['modelProjectId'] != model_project_id or score['actorId'] != version['ownerUserId']
                or score['version']['contentHash'] != version_hash or not _same_value(score['version'], version)
                or score['result']['modelHash'] != canonical_sha256(version['request']['model'])
                or score['result']['runtimeHash'] != score['runtimeHash']
                or score['result']['artifact'] != {'id': version['artifact']['id'], 'contentHash': version['artifact']['contentHash']}
                or score['poolId'] in pools and pools[score['poolId']]['workerImageDigest'] != score['workerImageDigest']):
            fail()
    return value


def verify_decision_serving_control(raw: Any, request: Any, team_id: str, model_project_id: str, *,
                                     actor_id: str | None = None) -> dict[str, Any]:
    value = validate('DecisionModelServingControlReceiptSchema', raw)
    request = validate('DecisionModelServingControlRequestSchema', request, request=True)
    verify_hash(value, 'contentHash')
    verify_decision_model_version(value['version'], team_id=request['teamId'], model_project_id=model_project_id,
                                 owner_user_id=value['actorId'], version_hash=request['versionHash'])
    control = value['control']
    if (not approval_matches(request, control) or not _same_value(value['request'], request) or value['teamId'] != team_id or request['teamId'] != team_id
            or value['modelProjectId'] != model_project_id or actor_id is not None and value['actorId'] != actor_id
            or control['teamId'] != value['teamId'] or control['modelProjectId'] != model_project_id or control['actorId'] != value['actorId']
            or control['operationId'] != request['operationId'] or control['versionHash'] != request['versionHash']
            or control['revision'] != request['expectedRevision'] + 1 or control['idleTimeoutSeconds'] != request['idleTimeoutSeconds']
            or control['desiredState'] != ('active' if request['action'] == 'activate' else 'stopped') or not _valid_control(control)
            or request['action'] == 'activate' and control['phase'] not in ('starting', 'active')
            or request['action'] == 'stop' and control['phase'] not in ('stopping', 'stopped')):
        fail('decision_serving_control_mismatch')
    return value
