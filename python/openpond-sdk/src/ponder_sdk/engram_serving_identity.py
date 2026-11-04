"""Exact memory-module serving identities; no adapter/checkpoint coercion."""
from typing import Any
from .errors import ProtocolError
from .managed_serving_usage_identity import approval_matches, verify_usage_billing
from .wire import canonical_sha256, validate, verify_hash
from .engram_identity import version as verify_version
from .steering_serving_identity import valid_control, serving_state


def fail() -> None:
    raise ProtocolError('engram_model_serving_mismatch')


def verify_resolved_engram(raw: Any, options: dict[str, Any]) -> dict[str, Any]:
    value = validate('ResolvedEngramSelectionSchema', raw)
    options = validate('EngramInferenceOptionsSchema', options, request=True)
    requested = 'inherit' if 'engram' not in options else 'on' if options['engram'] else 'off'
    if (value['requested'] != requested or value['effectiveEnabled'] != options.get('engram', value['defaultEnabled'])
            or 'savedModel' in options and value['savedModel'] != options['savedModel']):
        raise ProtocolError('engram_selection_mismatch')
    return value


def verify_engram_inference_receipt(raw: Any, expected: dict[str, Any]) -> dict[str, Any]:
    value = validate('EngramInferenceReceiptSchema', raw)
    verify_hash(value, 'contentHash')
    verify_resolved_engram(value['selection'], expected['options'])
    keys = ('teamId', 'requestId', 'requestHash', 'selection', 'runtimeHash', 'poolId',
            'routingBinding', 'workerImageDigest', 'engineGeneration', 'cacheNamespace')
    if any(value[key] != expected[key] for key in keys):
        raise ProtocolError('engram_inference_receipt_mismatch')
    return value


def verify_engram_model_serving(value: dict[str, Any], team_id: str, model_id: str, version_hash: str) -> None:
    value = validate('EngramModelServingSchema', value)
    verify_usage_billing(value, team_id, model_id, version_hash, 'engram')
    verify_hash(value, 'contentHash')
    version = value['version']
    verify_version(version, team_id, model_id)
    availability = value['availability']
    if (value['teamId'] != team_id or value['modelProjectId'] != model_id or version['contentHash'] != version_hash
            or value['state'] != serving_state(value)
            or (availability['state'] == 'qualified') != (availability['reason'] == 'qualified')
            or availability['state'] == 'qualified' and availability['runtimeHash'] is None):
        fail()
    for rows in (value['pools'], value['bindings']):
        if len({row['id'] for row in rows}) != len(rows):
            fail()
    control = value['control']
    controls = value['cleanup'] + ([control] if control is not None else [])
    if any(row['teamId'] != team_id or row['modelProjectId'] != model_id or not valid_control(row) for row in controls):
        fail()
    if (len({row['operationId'] for row in value['cleanup']}) != len(value['cleanup'])
            or any(row['desiredState'] != 'stopped' for row in value['cleanup'])):
        fail()
    if control is not None and (control['versionHash'] != version_hash and not (control['phase'] == 'stopped' and control['desiredState'] == 'stopped')
            or control['versionHash'] == version_hash and control['defaultEnabled'] != value['defaultEnabled']):
        fail()
    pools = {row['id']: row for row in value['pools']}
    if any(row['versionHash'] != version_hash or row['modelId'] != 'personalized:model:' + model_id or row['poolId'] not in pools for row in value['bindings']):
        fail()
    if control is not None and control['binding'] is not None and not any(row['id'] == control['binding']['id']
            and row['revision'] == control['binding']['revision'] and row['poolId'] == control['poolId']
            and row['modelId'] == control['modelId'] for row in value['bindings']):
        fail()
    if any(row['workersMin'] > row['workersMax'] for row in value['pools']):
        fail()
    evidence = value['lastVerifiedInference']
    if evidence is not None:
        verify_hash(evidence, 'contentHash')
        selection = evidence['selection']
        options = {'savedModel': selection['savedModel']}
        if selection['requested'] != 'inherit':
            options['engram'] = selection['requested'] == 'on'
        verify_resolved_engram(selection, options)
        artifact = version['artifact']
        if (evidence['teamId'] != team_id or selection['savedModel'] != {'modelProjectId': model_id, 'versionHash': version_hash}
                or selection['module'] != {'id': artifact['id'], 'contentHash': artifact['contentHash'],
                    'payloadSha256': artifact['manifest']['payload']['sha256']}
                or selection['modelHash'] != canonical_sha256(artifact['manifest']['pins']['baseModel'])
                or evidence['poolId'] in pools and pools[evidence['poolId']]['workerImageDigest'] != evidence['workerImageDigest']):
            fail()


def verify_engram_serving_control(value: dict[str, Any], request: dict[str, Any], team_id: str, model_id: str) -> None:
    value = validate('EngramModelServingControlReceiptSchema', value)
    request = validate('EngramModelServingControlRequestSchema', request, request=True)
    verify_hash(value, 'contentHash')
    verify_version(value['version'], team_id, model_id)
    control = value['control']
    if (not approval_matches(request, control) or value['request'] != request or value['teamId'] != team_id or request['teamId'] != team_id
            or value['modelProjectId'] != model_id or value['version']['contentHash'] != request['versionHash']
            or control['teamId'] != team_id or control['modelProjectId'] != model_id or control['actorId'] != value['actorId']
            or control['operationId'] != request['operationId'] or control['versionHash'] != request['versionHash']
            or control['revision'] != request['expectedRevision'] + 1 or control['idleTimeoutSeconds'] != request['idleTimeoutSeconds']
            or control['defaultEnabled'] != request['defaultEnabled'] or not valid_control(control)
            or control['desiredState'] != ('active' if request['action'] == 'activate' else 'stopped')
            or request['action'] == 'activate' and control['phase'] not in ('starting', 'active')
            or request['action'] == 'stop' and control['phase'] not in ('stopping', 'stopped')):
        raise ProtocolError('engram_serving_control_mismatch')
