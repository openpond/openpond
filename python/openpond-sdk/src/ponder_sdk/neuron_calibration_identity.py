"""Original calibration custody identity, without importing a model runtime."""
from typing import Any
from .errors import ProtocolError
from .wire import canonical_sha256, validate
from .neuron_steering import verify_neuron_calibration


def sealed(value: dict[str, Any]) -> None:
    if value['contentHash'] != canonical_sha256({key: item for key, item in value.items() if key != 'contentHash'}):
        raise ProtocolError('neuron_calibration_hash_mismatch')


def verify_calibration_request(raw: Any) -> dict[str, Any]:
    value = validate('NeuronResidualCalibrationRequestSchema', raw, request=True)
    prompt, layers = value['prompt'], value['layers']
    if (len(set(layers)) != len(layers) or any(layer >= len(value['model']['intermediateSizes']) for layer in layers)
            or len(prompt['tokenIds']) != len(prompt['attentionMask']) or sum(prompt['attentionMask']) < 2
            or prompt['attentionMask'][-1] != 1 or prompt['attentionMask'] != sorted(prompt['attentionMask'])
            or len(prompt['tokenIds']) > value['maximumForwardTokenWork']):
        raise ProtocolError('neuron_calibration_request_mismatch')
    return value


def verify_calibration_export(raw: Any, request: dict[str, Any] | None = None) -> dict[str, Any]:
    if request is not None:
        request = verify_calibration_request(request)
    value = validate('NeuronResidualCalibrationExportSchema', raw)
    model, prompt = value['model'], value['prompt']
    artifact = verify_neuron_calibration(value['calibration'], model)
    samples = sum(prompt['attentionMask']) - 1
    layers = [row['layer'] for row in artifact['layers']]
    sealed(value)
    if (samples <= 0 or len(prompt['tokenIds']) != len(prompt['attentionMask'])
            or prompt['attentionMask'][-1] != 1 or prompt['attentionMask'] != sorted(prompt['attentionMask'])
            or artifact['source'] != {'id': prompt['id'], 'contentHash': canonical_sha256(prompt)}
            or any(row['sampleCount'] != samples for row in artifact['layers'])):
        raise ProtocolError('neuron_calibration_export_mismatch')
    if request is not None and (canonical_sha256(model) != canonical_sha256(request['model'])
            or canonical_sha256(prompt) != canonical_sha256(request['prompt'])
            or artifact['id'] != request['id'] or artifact['revision'] != request['revision']
            or sorted(layers) != sorted(request['layers'])):
        raise ProtocolError('neuron_calibration_export_mismatch')
    return value


def record(value: dict[str, Any], team_id: str, owner: str | None = None, calibration_id: str | None = None) -> None:
    sealed(value)
    verify_calibration_export(value['artifact'])
    if (value['teamId'] != team_id or owner is not None and value['ownerUserId'] != owner
            or calibration_id is not None and value['artifact']['calibration']['id'] != calibration_id):
        raise ProtocolError('neuron_calibration_record_mismatch')


def finish(schema: str, value: dict[str, Any], team_id: str, parameters: dict[str, Any], body: dict[str, Any]) -> None:
    if schema == 'NeuronCalibrationRecordSchema':
        record(value, team_id, calibration_id=parameters['id'])
    elif schema == 'NeuronCalibrationPageSchema':
        sealed(value)
        query = {'archived': False, 'limit': 25, **body}
        ids = [row['reference']['id'] for row in value['items']]
        if (value['teamId'] != team_id or value['query'] != query or len(ids) > query['limit'] or ids != sorted(set(ids))
                or value['nextCursor'] is not None and (len(ids) != query['limit'] or value['nextCursor'] == query.get('cursor'))
                or any(row['teamId'] != team_id or row['ownerUserId'] != value['ownerUserId'] or row['archived'] != query['archived']
                       or 'projectId' in query and row['projectId'] != query['projectId']
                       or 'modelHash' in query and row['modelHash'] != query['modelHash'] for row in value['items'])):
            raise ProtocolError('neuron_calibration_page_mismatch')
    else:
        sealed(value)
        record(value['record'], team_id, value['actorId'], parameters.get('id'))
        importing = 'artifact' in body
        if (value['teamId'] != team_id or value['operationId'] != body['operationId']
                or value['requestHash'] != canonical_sha256(body if importing else {'id': parameters['id'], 'request': body})):
            raise ProtocolError('neuron_calibration_receipt_mismatch')
        retained = value['record']
        if importing:
            if (retained['artifact'] != body['artifact'] or retained['projectId'] != body['projectId']
                    or retained['name'] != body['name'] or retained['archived'] or retained['revision'] != 1):
                raise ProtocolError('neuron_calibration_receipt_mismatch')
        elif (not retained['archived'] or retained['revision'] != body['expectedRevision'] + 1
              or retained['artifact']['contentHash'] != body['contentHash']):
            raise ProtocolError('neuron_calibration_receipt_mismatch')
