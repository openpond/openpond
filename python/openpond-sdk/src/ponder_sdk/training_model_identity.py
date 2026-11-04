"""Exact saved versions and Model-save receipts across native HTTP clients."""
from typing import Any
from .errors import ProtocolError
from .wire import canonical_sha256


def verify_training_model_version(value: dict[str, Any], team_id: str, model_id: str, job_id: str | None = None) -> None:
    source = value['request']['source']['modelProject']
    candidate = value['candidate']
    if (value['contentHash'] != canonical_sha256({k: v for k, v in value.items() if k != 'contentHash'})
            or value['teamId'] != team_id or value['modelProjectId'] != model_id
            or job_id is not None and value['jobId'] != job_id
            or source['id'] != model_id or source['portableProjectId'] != value['portableProjectId']
            or (candidate['composition'] == 'base') != (candidate['parent'] is None)):
        raise ProtocolError('training_model_version_mismatch')


def verify_training_result_save(value: dict[str, Any], request: dict[str, Any], team_id: str, job_id: str) -> None:
    version = value['version']
    model = value['model']
    verify_training_model_version(version, team_id, model['id'], job_id)
    if (value['contentHash'] != canonical_sha256({k: v for k, v in value.items() if k != 'contentHash'})
            or value['requestHash'] != canonical_sha256(request) or value['teamId'] != team_id
            or model['teamId'] != team_id or request['teamId'] != team_id
            or value['operationId'] != request['operationId'] or model['name'] != request['name']
            or model['revision'] != request['expectedModelRevision'] + 1
            or model['portableProjectId'] != version['portableProjectId']
            or version['request']['submissionHash'] != request['submissionHash']
            or version['candidate']['artifact'] != request['artifact']
            or version['candidate']['checkpointId'] != request['checkpointId']):
        raise ProtocolError('training_result_save_mismatch')


def verify_training_saved_model(value: dict[str, Any], team_id: str, model_id: str) -> None:
    if value['teamId'] != team_id or value['model']['teamId'] != team_id or value['model']['id'] != model_id:
        raise ProtocolError('training_saved_model_mismatch')
    if value['version'] is not None:
        verify_training_model_version(value['version'], team_id, model_id)
        if value['version']['portableProjectId'] != value['model']['portableProjectId']:
            raise ProtocolError('training_saved_model_mismatch')
