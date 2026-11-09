"""True weight-patch serving lifecycle, distinct from adapter deployments."""
from .errors import ProtocolError
from .managed_serving_usage_identity import approval_matches, verify_usage_billing
from .wire import validate, verify_hash
from .weight_model_identity import verify_weight_model_version, verify_resolved_weight_selection
from .steering_serving_identity import valid_control, serving_state


def fail():
    raise ProtocolError('weight_model_serving_mismatch')


def verify_weight_model_serving(raw, team_id, model_id, version_hash, *, owner_user_id=None):
    prefix = 'WeightSpace' if raw.get('schemaVersion','').startswith('openpond.weightSpace') else 'AlphaEdit' if raw.get('schemaVersion') == 'openpond.alphaEditModelServing.v1' else 'NeuronTraining'
    value = validate(prefix + 'ModelServingSchema', raw)
    verify_usage_billing(value, team_id, model_id, version_hash, 'weight_space_programming' if prefix=='WeightSpace' else 'alphaedit' if prefix == 'AlphaEdit' else 'selective_neuron_training')
    verify_hash(value, 'contentHash')
    version = verify_weight_model_version(value['version'], team_id=team_id, model_project_id=model_id, owner_user_id=owner_user_id)
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
    if (any(row['teamId'] != team_id or row['modelProjectId'] != model_id or not valid_control(row) for row in controls)
            or len({row['operationId'] for row in value['cleanup']}) != len(value['cleanup'])
            or any(row['desiredState'] != 'stopped' for row in value['cleanup'])):
        fail()
    if control is not None and control['versionHash'] != version_hash and not (control['phase'] == 'stopped' and control['desiredState'] == 'stopped'):
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
        verify_resolved_weight_selection(evidence['selection'], version)
        if evidence['teamId'] != team_id or evidence['poolId'] in pools and pools[evidence['poolId']]['workerImageDigest'] != evidence['workerImageDigest']:
            fail()
    return value


def verify_weight_serving_control(raw, request, team_id, model_id, *, actor_id=None):
    prefix = 'WeightSpace' if raw.get('schemaVersion','').startswith('openpond.weightSpace') else 'AlphaEdit' if raw.get('schemaVersion') == 'openpond.alphaEditModelServingControlReceipt.v1' else 'NeuronTraining'
    value = validate(prefix + 'ModelServingControlReceiptSchema', raw)
    request = validate(prefix + 'ModelServingControlRequestSchema', request, request=True)
    verify_hash(value, 'contentHash')
    verify_weight_model_version(value['version'], team_id=team_id, model_project_id=model_id, owner_user_id=value['actorId'])
    control = value['control']
    if (not approval_matches(request, control) or value['request'] != request or value['teamId'] != team_id or request['teamId'] != team_id
            or actor_id is not None and value['actorId'] != actor_id
            or value['modelProjectId'] != model_id or value['version']['contentHash'] != request['versionHash']
            or control['teamId'] != team_id or control['modelProjectId'] != model_id or control['actorId'] != value['actorId']
            or control['operationId'] != request['operationId'] or control['versionHash'] != request['versionHash']
            or control['revision'] != request['expectedRevision'] + 1 or control['idleTimeoutSeconds'] != request['idleTimeoutSeconds']
            or not valid_control(control) or control['desiredState'] != ('active' if request['action'] == 'activate' else 'stopped')
            or request['action'] == 'activate' and control['phase'] not in ('starting', 'active')
            or request['action'] == 'stop' and control['phase'] not in ('stopping', 'stopped')):
        fail()
    return value
