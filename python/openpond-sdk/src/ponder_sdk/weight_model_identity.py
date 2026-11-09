"""Exact matrix/column artifacts and saved Model publication identities."""
from .weight_space_programming import verify_weight_space_request, verify_weight_space_artifact
from .alphaedit import verify_alphaedit_request, verify_alphaedit_artifact
from .neuron_training import verify_neuron_training_request, verify_neuron_training_artifact
from .errors import ProtocolError
from .wire import canonical_json, canonical_sha256, validate, verify_hash


def fail():
    raise ProtocolError('weight_model_version_mismatch')


def verify_weight_model_version(raw, *, team_id=None, model_project_id=None, owner_user_id=None):
    alpha = raw.get('schemaVersion') == 'openpond.alphaEditModelVersion.v1'
    wsp = raw.get('schemaVersion') == 'openpond.weightSpaceModelVersion.v1'
    value = validate('WeightSpaceModelVersionSchema' if wsp else 'AlphaEditModelVersionSchema' if alpha else 'NeuronTrainingModelVersionSchema', raw)
    verify_hash(value, 'contentHash')
    request = (verify_weight_space_request if wsp else verify_alphaedit_request if alpha else verify_neuron_training_request)(value['request'])
    artifact, base = value['artifact'], value['baseModel']
    manifest = (verify_weight_space_artifact if wsp else verify_alphaedit_artifact if alpha else verify_neuron_training_artifact)(artifact['manifest'], request, value['source']['runtimeHash'])
    if (team_id is not None and value['teamId'] != team_id
            or model_project_id is not None and value['modelProjectId'] != model_project_id
            or owner_user_id is not None and value['ownerUserId'] != owner_user_id
            or base['source'] != 'managed' or base['modelAssetId'] is not None or not base['tokenizerRevision']
            or base['modelId'] != request['model']['modelId'] or base['revision'] != request['model']['revision']
            or value['source']['inputHash'] != canonical_sha256(request) or artifact['contentHash'] != manifest['contentHash']):
        fail()
    payloads = [manifest['payloads']['patch'], *manifest['payloads']['state']] if alpha else [manifest['payload']]
    metadata = {'path': 'manifest.json', 'sha256': canonical_sha256(manifest), 'sizeBytes': len(canonical_json(manifest).encode('utf-8'))}
    expected = [metadata, *payloads]
    files = artifact['files']
    if (metadata['sizeBytes'] > 262144 or len(files) != len(expected) or len({row['path'] for row in files}) != len(expected)
            or sum(row['sizeBytes'] for row in files) > (request['limits']['maximumCheckpointBytes'] if wsp else request['training']['maxCheckpointBytes'])
            or any(row['artifactId'] != artifact['id'] for row in files)
            or any(not any(all(row[key] == item[key] for key in ('path', 'sha256', 'sizeBytes')) for row in files) for item in expected)):
        fail()
    return value


def verify_weight_result_save(raw, request, *, actor_id=None):
    alpha = raw.get('schemaVersion') == 'openpond.alphaEditResultSaveReceipt.v1'
    prefix = 'WeightSpace' if raw.get('schemaVersion') == 'openpond.weightSpaceResultSaveReceipt.v1' else 'AlphaEdit' if alpha else 'NeuronTraining'
    value = validate(prefix + 'ResultSaveReceiptSchema', raw)
    request = validate(prefix + 'ResultSaveRequestSchema', request, request=True)
    if bool(request['modelProjectId']) != (request['expectedModelRevision'] > 0):
        fail()
    verify_hash(value, 'contentHash')
    model = value['model']
    version = verify_weight_model_version(value['version'], team_id=request['teamId'], model_project_id=model['id'], owner_user_id=value['actorId'])
    if (value['teamId'] != request['teamId'] or model['teamId'] != request['teamId']
            or actor_id is not None and value['actorId'] != actor_id
            or value['operationId'] != request['operationId'] or value['requestHash'] != canonical_sha256(request)
            or version['source']['executionId'] != request['executionId'] or version['source']['resultHash'] != request['resultHash']
            or version['artifact']['contentHash'] != request['artifactHash'] or model['name'] != request['name']
            or model['revision'] != request['expectedModelRevision'] + 1
            or request['modelProjectId'] is not None and model['id'] != request['modelProjectId']
            or version['portableProjectId'] != model['portableProjectId']):
        fail()
    return value


def verify_resolved_weight_selection(raw, version):
    value = validate('ResolvedWeightModelSelectionSchema', raw)
    version = verify_weight_model_version(version)
    artifact = version['artifact']
    method = 'weight_space_programming' if version['schemaVersion']=='openpond.weightSpaceModelVersion.v1' else 'alphaedit' if version['schemaVersion'] == 'openpond.alphaEditModelVersion.v1' else 'selective_neuron_training'
    if (value['method'] != method or value['savedModel'] != {'modelProjectId': version['modelProjectId'], 'versionHash': version['contentHash']}
            or value['artifact'] != {'id': artifact['id'], 'contentHash': artifact['contentHash'], 'manifestSha256': canonical_sha256(artifact['manifest'])}
            or value['modelHash'] != canonical_sha256(version['request']['model'])):
        raise ProtocolError('weight_model_selection_mismatch')
    return value


def verify_weight_inference_receipt(raw, expected):
    value = validate('WeightModelInferenceReceiptSchema', raw)
    verify_hash(value, 'contentHash')
    verify_resolved_weight_selection(value['selection'], expected['version'])
    keys = ('teamId', 'requestId', 'requestHash', 'selection', 'poolId', 'routingBinding', 'runtimeHash',
            'workerImageDigest', 'engineGeneration', 'cacheNamespace')
    if any(value[key] != expected[key] for key in keys):
        raise ProtocolError('weight_model_inference_mismatch')
    return value
