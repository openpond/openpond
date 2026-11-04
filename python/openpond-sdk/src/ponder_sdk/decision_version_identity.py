"""Immutable Decision Model and compact authoring-source metadata validation.

A metadata hash does not prove execution, committed bytes or current authority.
Those checks remain with the authenticated Model and artifact owners.
"""
from typing import Any
from .decision_identity import _bounded, _content_matches, _same_value, _text
from .decision_identity_artifact import verify_decision_adapter_artifact
from .decision_identity_training import verify_decision_training_request
from .errors import ProtocolError
from .wire import canonical_json, canonical_sha256, validate


def decision_source_preference() -> dict[str, Any]:
    """The released Nimble adapter and its own tokenizer, never a bare backbone."""
    return validate('ModelProjectBaseModelSchema', {
        'schemaVersion': 'openpond.baseModelPreference.v1', 'source': 'managed',
        'modelId': 'bespokelabs/Bespoke-Nimble-9B', 'revision': 'e93fabce8fcee46e7e8b45e2d955b8a4f0035917',
        'tokenizerRevision': 'e93fabce8fcee46e7e8b45e2d955b8a4f0035917',
        'chatTemplateHash': 'a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715', 'modelAssetId': None,
    })


def fail() -> None:
    raise ProtocolError('decision_model_version_mismatch')


def verify_decision_model_version(raw: Any, *, team_id: str | None = None,
                                  model_project_id: str | None = None, owner_user_id: str | None = None,
                                  version_hash: str | None = None) -> dict[str, Any]:
    _bounded(raw, 524_288)
    value = validate('DecisionModelVersionSchema', raw)
    for key in ('teamId', 'ownerUserId', 'modelProjectId', 'portableProjectId'):
        _text(value[key], 240, nonblank=True)
    _text(value['source']['executionId'], 240, nonblank=True)
    request = verify_decision_training_request(value['request'])
    artifact = value['artifact']
    manifest = verify_decision_adapter_artifact(artifact['manifest'], {
        'model': request['model'], 'inputHash': canonical_sha256(request),
        'recipeHash': canonical_sha256(request['training']), 'dataHash': canonical_sha256(request['data']),
        'runtimeHash': value['source']['runtimeHash'],
        'parentArtifactHash': request['parentArtifact']['contentHash'] if request['parentArtifact'] is not None else None,
    })
    inventory = {row['path']: row for row in artifact['files']}
    if (not _content_matches(value) or team_id is not None and value['teamId'] != team_id
            or model_project_id is not None and value['modelProjectId'] != model_project_id
            or owner_user_id is not None and value['ownerUserId'] != owner_user_id
            or version_hash is not None and value['contentHash'] != version_hash
            or not _same_value(value['baseModel'], request['model']['source'])
            or value['source']['inputHash'] != manifest['pins']['inputHash']
            or artifact['contentHash'] != manifest['contentHash'] or len(inventory) != 4
            or any(row['artifactId'] != artifact['id'] for row in artifact['files'])
            or sum(row['sizeBytes'] for row in artifact['files']) > request['training']['maxCheckpointBytes']):
        fail()
    tensor = inventory.get('adapter_model.safetensors')
    if (tensor is None or tensor['sha256'] != manifest['payload']['sha256']
            or tensor['sizeBytes'] != manifest['payload']['sizeBytes']):
        fail()
    for path, payload in (('manifest.json', manifest), ('adapter_config.json', manifest['adapterConfig']),
                          ('decision_contract.json', manifest['contract'])):
        file = inventory.get(path)
        if (file is None or file['sha256'] != canonical_sha256(payload)
                or file['sizeBytes'] != len(canonical_json(payload).encode('utf-8')) or file['sizeBytes'] > 262_144):
            fail()
    return value


def verify_saved_decision_experiment_source(source: Any, raw: Any, *, team_id: str | None = None,
                                            owner_user_id: str | None = None) -> dict[str, Any]:
    pin = validate('SavedDecisionExperimentSourceSchema', source)
    version = verify_decision_model_version(raw, team_id=team_id, owner_user_id=owner_user_id,
                                           model_project_id=pin['modelProjectId'], version_hash=pin['versionHash'])
    if (pin['artifact'] != {'id': version['artifact']['id'], 'contentHash': version['artifact']['contentHash']}
            or pin['modelHash'] != canonical_sha256(version['request']['model'])):
        raise ProtocolError('decision_experiment_source_mismatch')
    return version


def experiment_starting_model_from_decision_version(raw: Any, *, label: str, team_id: str | None = None,
                                                    owner_user_id: str | None = None) -> dict[str, Any]:
    version = verify_decision_model_version(raw, team_id=team_id, owner_user_id=owner_user_id)
    return validate('ExperimentStartingModelSchema', {
        'source': 'decision', 'label': label, 'inferenceModelId': None, 'baseModel': version['baseModel'],
        'decision': {'modelProjectId': version['modelProjectId'], 'versionHash': version['contentHash'],
                     'artifact': {'id': version['artifact']['id'], 'contentHash': version['artifact']['contentHash']},
                     'modelHash': canonical_sha256(version['request']['model'])},
    })


def decision_form_from_model_version(form: Any, raw: Any, *, team_id: str | None = None,
                                      owner_user_id: str | None = None) -> dict[str, Any]:
    current = validate('DecisionExperimentFormDraftSchema', form)
    version = verify_decision_model_version(raw, team_id=team_id, owner_user_id=owner_user_id)
    pin = experiment_starting_model_from_decision_version(version, label='Decision')['decision']
    return validate('DecisionExperimentFormDraftSchema', {**current, 'baseModel': version['baseModel'],
                    'parentArtifact': pin['artifact'], 'startingDecision': pin})


def verify_decision_result_save(raw: Any, command: Any, *, actor_id: str | None = None) -> dict[str, Any]:
    request = validate('DecisionResultSaveRequestSchema', command, request=True)
    if (request['modelProjectId'] is None and request['expectedModelRevision'] != 0
            or request['modelProjectId'] is not None and request['expectedModelRevision'] <= 0):
        raise ProtocolError('decision_model_save_mismatch')
    value = validate('DecisionResultSaveReceiptSchema', raw)
    model, version = value['model'], value['version']
    verify_decision_model_version(version, team_id=request['teamId'], model_project_id=model['id'], owner_user_id=value['actorId'])
    if (not _content_matches(value) or value['teamId'] != request['teamId'] or model['teamId'] != request['teamId']
            or actor_id is not None and value['actorId'] != actor_id or value['operationId'] != request['operationId']
            or value['requestHash'] != canonical_sha256(request) or version['source']['executionId'] != request['executionId']
            or version['source']['resultHash'] != request['resultHash'] or version['artifact']['contentHash'] != request['artifactHash']
            or model['name'] != request['name'] or model['revision'] != request['expectedModelRevision'] + 1
            or request['modelProjectId'] is not None and model['id'] != request['modelProjectId']
            or version['portableProjectId'] != model['portableProjectId']):
        raise ProtocolError('decision_model_save_mismatch')
    return value
