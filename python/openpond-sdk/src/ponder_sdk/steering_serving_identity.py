"""Exact saved steering, routing/default and completed runner identities."""
from typing import Any
from .errors import ProtocolError
from .managed_serving_usage_identity import approval_matches, verify_usage_billing
from .wire import canonical_sha256, validate
from .steering_publication_identity import version as verify_version


def sealed(value: dict[str, Any]) -> None:
    if value['contentHash'] != canonical_sha256({key: item for key, item in value.items() if key != 'contentHash'}):
        raise ProtocolError('steering_serving_hash_mismatch')


def publication_ref(version: dict[str, Any]) -> dict[str, Any]:
    return {key: version['publication'][key] for key in ('id', 'revision', 'contentHash')}


def valid_control(value: dict[str, Any]) -> bool:
    return (value['modelId'] == 'personalized:model:' + value['modelProjectId']
            and (value['binding'] is None or value['poolId'] is not None)
            and (value['phase'] != 'active' or value['desiredState'] == 'active' and value['poolId'] is not None
                 and value['binding'] is not None and value['capacityState'] in ('pending', 'shared'))
            and (value['phase'] != 'stopping' or value['desiredState'] == 'stopped')
            and (value['capacityState'] != 'released' or value['binding'] is None
                 and value['activeRequests'] == 0 and value['unsettledRequests'] == 0)
            and (value['phase'] != 'stopped' or value['desiredState'] == 'stopped' and value['binding'] is None
                 and value['activeRequests'] == 0 and value['unsettledRequests'] == 0 and value['capacityState'] in ('shared', 'released')))


def serving_state(value: dict[str, Any]) -> str:
    control = value['control']
    if (control is not None and control['phase'] == 'stopping'
            or any(row['phase'] != 'stopped' or row['capacityState'] not in ('shared', 'released') for row in value['cleanup'])):
        return 'retiring'
    if value['availability']['state'] != 'qualified' or control is not None and control['phase'] == 'failed':
        return 'unavailable'
    if control is None or control['desiredState'] == 'stopped':
        return 'unavailable' if value['bindings'] else 'inactive'
    binding = control['binding']
    pools = {row['id']: row for row in value['pools']}
    if control['phase'] == 'active' and binding is not None and any(
            row['id'] == binding['id'] and row['revision'] == binding['revision'] and row['poolId'] == control['poolId']
            and pools.get(row['poolId'], {}).get('state') == 'ready' and pools.get(row['poolId'], {}).get('endpointRecorded') for row in value['bindings']):
        return 'active'
    return 'starting' if control['phase'] == 'starting' else 'unavailable'


def verify_resolved_steering(raw: Any, options: dict[str, Any]) -> dict[str, Any]:
    value = validate('ResolvedSteeringSelectionSchema', raw)
    options = validate('SteeringInferenceOptionsSchema', options, request=True)
    mode = 'inherit' if 'steering' not in options else 'off' if options['steering'] is None else 'override'
    effective = value['defaultPublication'] if mode == 'inherit' else options['steering']
    if (value['requested'] != mode or 'savedModel' in options and value['savedModel'] != options['savedModel']
            or value['effectivePublication'] != effective or (effective is None) != (value['profileHash'] is None)
            or effective is None and value['calibration'] is not None):
        raise ProtocolError('steering_selection_mismatch')
    return value


def verify_steering_inference_receipt(raw: Any, expected: dict[str, Any]) -> dict[str, Any]:
    value = validate('SteeringInferenceReceiptSchema', raw)
    sealed(value)
    verify_resolved_steering(value['selection'], expected['options'])
    keys = ('teamId', 'requestId', 'requestHash', 'selection', 'runtimeHash', 'poolId', 'routingBinding', 'workerImageDigest', 'engineGeneration', 'cacheNamespace')
    if any(value[key] != expected[key] for key in keys):
        raise ProtocolError('steering_inference_receipt_mismatch')
    return value


def verify_saved_model_serving(value: dict[str, Any], team_id: str, model_id: str, version_hash: str) -> None:
    if value['schemaVersion'] in ('openpond.alphaEditModelServing.v1','openpond.neuronTrainingModelServing.v1','openpond.weightSpaceModelServing.v1'):
        from .weight_serving_identity import verify_weight_model_serving
        verify_weight_model_serving(value,team_id,model_id,version_hash)
        return
    if value['schemaVersion'] == 'openpond.decisionModelServing.v1':
        from .decision_serving_identity import verify_decision_model_serving
        verify_decision_model_serving(value, team_id, model_id, version_hash)
        return
    if value['schemaVersion'] == 'openpond.trainingModelServing.v1':
        from .training_serving_identity import verify_training_model_serving
        verify_training_model_serving(value, team_id, model_id, version_hash)
        return
    if value['schemaVersion'] == 'openpond.engramModelServing.v1':
        from .engram_serving_identity import verify_engram_model_serving
        verify_engram_model_serving(value, team_id, model_id, version_hash)
        return
    def fail() -> None:
        raise ProtocolError('steering_model_serving_mismatch')
    verify_usage_billing(value, team_id, model_id, version_hash, 'steering')
    sealed(value)
    version = value['version']
    verify_version(version, team_id, model_id)
    availability = value['availability']
    if (value['teamId'] != team_id or value['modelProjectId'] != model_id or version['contentHash'] != version_hash
            or value['defaultPublication'] is not None and value['defaultPublication'] != publication_ref(version)
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
            or control['versionHash'] == version_hash and control['defaultPublication'] != value['defaultPublication']):
        fail()
    pools = {row['id']: row for row in value['pools']}
    if any(row['versionHash'] != version_hash or row['modelId'] != 'personalized:model:' + model_id or row['poolId'] not in pools for row in value['bindings']):
        fail()
    if control is not None and control['binding'] is not None and not any(row['id'] == control['binding']['id']
            and row['revision'] == control['binding']['revision'] and row['poolId'] == control['poolId'] and row['modelId'] == control['modelId'] for row in value['bindings']):
        fail()
    if any(row['workersMin'] > row['workersMax'] for row in value['pools']):
        fail()
    evidence = value['lastVerifiedInference']
    if evidence is not None:
        sealed(evidence)
        selection = evidence['selection']
        options = {} if selection['savedModel'] is None else {'savedModel': selection['savedModel']}
        if selection['requested'] != 'inherit':
            options['steering'] = None if selection['requested'] == 'off' else selection['effectivePublication']
        verify_resolved_steering(selection, options)
        known_publication, profile = publication_ref(version), version['publication']['profile']
        calibration = profile['normalization']['calibration'] if profile['normalization']['mode'] == 'fixed_residual_reference' else None
        if (selection['defaultPublication'] is not None and selection['defaultPublication'] != known_publication
                or selection['effectivePublication'] == known_publication and (selection['profileHash'] != profile['contentHash']
                    or selection['calibration'] != calibration)):
            fail()
        if (evidence['teamId'] != team_id or selection['savedModel'] != {'modelProjectId': model_id, 'versionHash': version_hash}
                or selection['modelHash'] != canonical_sha256(version['publication']['profile']['model'])
                or evidence['poolId'] in pools and pools[evidence['poolId']]['workerImageDigest'] != evidence['workerImageDigest']):
            fail()


def verify_steering_serving_control(value: dict[str, Any], request: dict[str, Any], team_id: str, model_id: str) -> None:
    sealed(value)
    verify_version(value['version'], team_id, model_id)
    control = value['control']
    if (not approval_matches(request, control) or value['request'] != request or value['teamId'] != team_id or request['teamId'] != team_id
            or value['modelProjectId'] != model_id or value['version']['contentHash'] != request['versionHash']
            or request['defaultPublication'] is not None and request['defaultPublication'] != publication_ref(value['version'])
            or control['teamId'] != team_id or control['modelProjectId'] != model_id or control['actorId'] != value['actorId']
            or control['operationId'] != request['operationId'] or control['versionHash'] != request['versionHash']
            or control['revision'] != request['expectedRevision'] + 1 or control['idleTimeoutSeconds'] != request['idleTimeoutSeconds']
            or control['defaultPublication'] != request['defaultPublication'] or not valid_control(control)
            or control['desiredState'] != ('active' if request['action'] == 'activate' else 'stopped')
            or request['action'] == 'activate' and control['phase'] not in ('starting', 'active')
            or request['action'] == 'stop' and control['phase'] not in ('stopping', 'stopped')):
        raise ProtocolError('steering_serving_control_mismatch')
