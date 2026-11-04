"""Immutable steering publication/Model identity; no serving readiness inference."""
from typing import Any
from .wire import canonical_sha256
from .errors import ProtocolError
from .neuron_steering import verify_neuron_profile
from .training_model_identity import verify_training_model_version


def sealed(value: dict[str, Any]) -> None:
    if value['contentHash'] != canonical_sha256({k: v for k, v in value.items() if k != 'contentHash'}):
        raise ProtocolError('steering_publication_hash_mismatch')


def publication(value: dict[str, Any], team_id: str, owner: str | None = None, profile_id: str | None = None) -> None:
    sealed(value)
    verify_neuron_profile(value['profile'])
    if (value['teamId'] != team_id or owner is not None and value['ownerUserId'] != owner
            or profile_id is not None and value['id'] != profile_id
            or value['baseModel']['modelId'] != value['profile']['model']['modelId']
            or value['baseModel']['revision'] != value['profile']['model']['revision']
            or len({row['promptId'] for row in value['calibrationEvidence']}) != len(value['calibrationEvidence'])):
        raise ProtocolError('steering_publication_mismatch')


def record(value: dict[str, Any], team_id: str, owner: str | None = None, profile_id: str | None = None) -> None:
    sealed(value)
    publication(value['publication'], team_id, owner, profile_id)


def version(value: dict[str, Any], team_id: str, model_id: str) -> None:
    if value['schemaVersion'] in ('openpond.alphaEditModelVersion.v1','openpond.neuronTrainingModelVersion.v1'):
        from .weight_model_identity import verify_weight_model_version
        verify_weight_model_version(value, team_id=team_id, model_project_id=model_id)
        return
    if value['schemaVersion'] == 'openpond.decisionModelVersion.v1':
        from .decision_version_identity import verify_decision_model_version
        verify_decision_model_version(value, team_id=team_id, model_project_id=model_id)
        return
    if value['schemaVersion'] == 'openpond.engramModelVersion.v1':
        from .engram_identity import version as engram_version
        engram_version(value, team_id, model_id)
        return
    if value['schemaVersion'] == 'openpond.trainingModelVersion.v1':
        verify_training_model_version(value, team_id, model_id)
        return
    sealed(value)
    publication(value['publication'], team_id)
    if value['teamId'] != team_id or value['modelProjectId'] != model_id:
        raise ProtocolError('saved_model_version_mismatch')


def finish(schema: str, value: dict[str, Any], team_id: str, parameters: dict[str, Any], body: dict[str, Any] | None) -> None:
    if schema == 'SavedModelVersionReadSchema':
        if value['teamId'] != team_id or value['model']['teamId'] != team_id or value['model']['id'] != parameters['modelProjectId']:
            raise ProtocolError('saved_model_version_mismatch')
        if body and 'versionHash' in body and (value['version'] is None or value['version']['contentHash'] != body['versionHash']):
            raise ProtocolError('saved_model_version_mismatch')
        if value['version'] is not None:
            version(value['version'], team_id, parameters['modelProjectId'])
            if value['version']['portableProjectId'] != value['model']['portableProjectId']:
                raise ProtocolError('saved_model_version_mismatch')
    elif schema == 'SteeringProfileRecordSchema':
        record(value, team_id, profile_id=parameters['id'])
    elif schema == 'SteeringProfilePageSchema':
        sealed(value)
        query = {'archived': False, 'limit': 25, **(body or {})}
        if value['teamId'] != team_id or value['query'] != query or len(value['items']) > query['limit']:
            raise ProtocolError('steering_profile_page_mismatch')
        ids = [item['id'] for item in value['items']]
        if ids != sorted(set(ids)) or any(item['teamId'] != team_id or item['ownerUserId'] != value['ownerUserId'] or item['archived'] != query['archived'] or 'projectId' in query and item['projectId'] != query['projectId'] or 'modelProjectId' in query and item['modelProjectId'] != query['modelProjectId'] for item in value['items']):
            raise ProtocolError('steering_profile_page_mismatch')
        if value['nextCursor'] is not None and (len(ids) != query['limit'] or value['nextCursor'] == query.get('cursor')):
            raise ProtocolError('steering_profile_page_mismatch')
    else:
        assert body is not None
        sealed(value)
        record(value['record'], team_id, value['actorId'], parameters.get('id'))
        saving = 'executionId' in body
        if (value['teamId'] != team_id or value['operationId'] != body['operationId']
                or value['requestHash'] != canonical_sha256(body if saving else {'id': parameters['id'], 'request': body})):
            raise ProtocolError('steering_profile_receipt_mismatch')
        if saving:
            source = value['record']['publication']
            model = value['model']
            if (model is None or value['version'] is None or source['source']['executionId'] != body['executionId']
                    or source['source']['variantId'] != body['variantId'] or source['source']['resultHash'] != body['resultHash']
                    or source['profile']['contentHash'] != body['profileHash'] or source['name'] != body['name']
                    or model['name'] != body['name'] or body['modelProjectId'] is not None and model['id'] != body['modelProjectId']
                    or model['revision'] != body['expectedModelRevision'] + 1):
                raise ProtocolError('steering_profile_receipt_mismatch')
            version(value['version'], team_id, model['id'])
            if value['version']['publication'] != source or value['version']['portableProjectId'] != model['portableProjectId']:
                raise ProtocolError('steering_profile_receipt_mismatch')
        elif (not value['record']['archived'] or value['record']['revision'] != body['expectedRevision'] + 1
                or value['record']['publication']['contentHash'] != body['contentHash'] or value['model'] is not None or value['version'] is not None):
            raise ProtocolError('steering_profile_receipt_mismatch')
