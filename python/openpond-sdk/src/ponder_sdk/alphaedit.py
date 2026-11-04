"""Portable AlphaEdit identity verification. No torch or model downloads.

Metadata validation does not prove tensor possession or edit quality; those
remain the existing artifact custodian and qualified numerical runtime's work.
"""
from typing import Any
from .errors import ProtocolError
from .wire import canonical_json, canonical_sha256, validate


def _model(raw):
    model = validate('AlphaEditModelSchema', raw)
    if (model['modelId'] != 'Qwen/Qwen3-8B' or model['revision'] != 'b968826d9c46dd6066d109eabc6255188de91218'
            or model['dtype'] != 'bfloat16' or model['hiddenSize'] != 4096
            or model['intermediateSizes'] != [12288] * 36):
        raise ProtocolError('alphaedit_model_mismatch')
    return model


def _config(raw):
    config = validate('AlphaEditConfigSchema', raw)
    layers, groups = config['layers'], config['contextTemplateGroups']
    contexts = [text for group in groups for text in group]
    if (layers != sorted(set(layers)) or config['lossLayer'] < layers[-1] or groups[0] != ['{}']
            or len(set(contexts)) != len(contexts)
            or any(text.count('{}') != 1 or '{' in text.replace('{}', '') or '}' in text.replace('{}', '') for text in contexts)):
        raise ProtocolError('alphaedit_config_mismatch')
    return config


def verify_alphaedit_request(raw: Any) -> dict[str, Any]:
    value = validate('AlphaEditTrainingRequestSchema', raw)
    _model(value['model']); _config(value['config'])
    return value


def verify_alphaedit_data(request: dict[str, Any], raw_edits: Any, raw_preservation: Any):
    request = verify_alphaedit_request(request)
    edits = validate('AlphaEditExamplesSchema', raw_edits)
    preservation = validate('AlphaEditPreservationExamplesSchema', raw_preservation)
    for kind, rows in (('edits', edits), ('preservation', preservation)):
        if (len({row['id'] for row in rows}) != len(rows) or len(canonical_json(rows).encode()) > 8_388_608
                or canonical_sha256(rows) != request['data'][kind]['examplesSha256']):
            raise ProtocolError('alphaedit_data_mismatch')
    if any(row['promptTemplate'].count('{}') != 1
           or '{' in row['promptTemplate'].replace('{}', '') or '}' in row['promptTemplate'].replace('{}', '') for row in edits):
        raise ProtocolError('alphaedit_data_mismatch')
    return edits, preservation


def alphaedit_tensor_inventory(config):
    config = _config(config)
    return {
        'patch': [{'name': f'layers.{layer}.mlp.down_proj.weight', 'shape': [4096, 12288], 'dtype': 'BF16'} for layer in config['layers']],
        'state': [{'name': f'layers.{layer}.{name}', 'shape': [12288, 12288], 'dtype': 'F32'}
                  for layer in config['layers'] for name in ('covariance', 'projector', 'cache_c')],
    }


def verify_alphaedit_artifact(raw: Any, request: dict[str, Any] | None = None, runtime_hash: str | None = None) -> dict[str, Any]:
    value = validate('AlphaEditArtifactSchema', raw)
    config = _config(value['config']); pins, payloads = value['pins'], value['payloads']
    _model(pins['baseModel'])
    inventory = alphaedit_tensor_inventory(config)
    ordered = lambda rows: sorted(rows, key=lambda row: row['name'])
    if (value['contentHash'] != canonical_sha256({key: item for key, item in value.items() if key != 'contentHash'})
            or pins['configHash'] != canonical_sha256(config) or pins['dataHash'] != canonical_sha256(pins['data'])
            or pins['preservationModelHash'] != canonical_sha256(pins['baseModel'])
            or payloads['patch']['sizeBytes'] < len(config['layers']) * 4096 * 12288 * 2
            or ordered(payloads['patch']['tensors']) != ordered(inventory['patch'])
            or len(payloads['state']) != len(config['layers'])):
        raise ProtocolError('alphaedit_artifact_mismatch')
    for layer, payload in zip(config['layers'], payloads['state'], strict=True):
        tensors = [row for row in inventory['state'] if row['name'].startswith(f'layers.{layer}.')]
        if (payload['path'] != f'state-{layer}.safetensors' or payload['sizeBytes'] < 3 * 12288 * 12288 * 4
                or ordered(payload['tensors']) != ordered(tensors)):
            raise ProtocolError('alphaedit_artifact_mismatch')
    if request is not None:
        request = verify_alphaedit_request(request)
        if (pins['baseModel'] != request['model'] or config != request['config'] or pins['data'] != request['data']
                or pins['recipeHash'] != canonical_sha256(request['training']) or pins['runtimeHash'] != runtime_hash
                or pins['parentArtifactHash'] != (request['parentArtifact']['contentHash'] if request['parentArtifact'] else None)
                or payloads['patch']['sizeBytes'] + sum(row['sizeBytes'] for row in payloads['state']) > request['training']['maxCheckpointBytes']):
            raise ProtocolError('alphaedit_artifact_mismatch')
    return value


def verify_alphaedit_result(raw: Any, request: dict[str, Any], runtime_hash: str) -> dict[str, Any]:
    request = verify_alphaedit_request(request)
    value = validate('AlphaEditTrainingResultSchema', raw)
    manifest = verify_alphaedit_artifact(value['artifact']['manifest'], request, runtime_hash)
    files = {row['path']: row for row in value['artifact']['files']}
    comparison, context_count = value['comparisons'], sum(len(group) for group in request['config']['contextTemplateGroups'])
    reload = comparison['reload']
    equivalent = (reload['baseWeightsHash'] == request['model']['weightsHash']
        and reload['editedWeightsHash'] == value['editedWeightsHashAfter']
        and reload['untouchedWeightsHash'] == value['untouchedWeightsHashAfter']
        and reload['maximumAbsoluteTargetNllDifference'] <= reload['absoluteTolerance']
        and reload['maximumAbsoluteLogProbabilityDifference'] <= reload['absoluteTolerance']
        and reload['maximumNextTokenKl'] <= reload['absoluteTolerance'])
    metadata, patch = files.get('manifest.json'), files.get('patch.safetensors')
    payloads = [manifest['payloads']['patch'], *manifest['payloads']['state']]
    if (value['contentHash'] != canonical_sha256({key: item for key, item in value.items() if key != 'contentHash'})
            or value['inputHash'] != canonical_sha256(request) or value['modelHash'] != canonical_sha256(request['model'])
            or value['runtimeHash'] != runtime_hash or value['dataHash'] != canonical_sha256(request['data'])
            or value['untouchedWeightsHashBefore'] != value['untouchedWeightsHashAfter']
            or len(value['targetLosses']) != value['editsProcessed'] or len({row['id'] for row in value['targetLosses']}) != value['editsProcessed']
            or value['latentOptimizerSteps'] != sum(row['optimizerSteps'] for row in value['targetLosses'])
            or any(row['optimizerSteps'] > request['training']['maxSteps'] for row in value['targetLosses'])
            or comparison['startingState'] != ('parent' if request['parentArtifact'] else 'base')
            or len(comparison['edits']) != value['editsProcessed']
            or [row['id'] for row in comparison['edits']] != [row['id'] for row in value['targetLosses']]
            or any(row['contextCount'] != context_count or row['targetTokens'] % context_count != 0
                or row['targetTokens'] > context_count * (request['training']['maxSequenceLength'] - 1)
                or abs(row['afterMeanTargetNll'] - row['reloadedMeanTargetNll']) > reload['maximumAbsoluteTargetNllDifference'] + 1e-12
                for row in comparison['edits'])
            or comparison['preservation']['examples'] != comparison['preservation']['comparedPositions']
            or comparison['preservation']['meanNextTokenKl'] > comparison['preservation']['maximumNextTokenKl'] + 1e-12
            or reload['comparedTargetTokens'] != sum(row['targetTokens'] for row in comparison['edits'])
            or reload['comparedPreservationPositions'] != comparison['preservation']['comparedPositions']
            or reload['meanNextTokenKl'] > reload['maximumNextTokenKl'] + 1e-12
            or reload['equivalent'] != equivalent
            or value['forwardTokenWork'] < 3 * (reload['comparedTargetTokens'] + reload['comparedPreservationPositions'])
            or value['forwardTokenWork'] > request['training']['maxForwardTokenWork']
            or value['durationMs'] > request['training']['maxDurationSeconds'] * 1000
            or [row['layer'] for row in value['layerEvidence']] != request['config']['layers']
            or any(row['sequentialKeyCount'] != value['editsProcessed'] for row in value['layerEvidence'])
            or value['artifact']['contentHash'] != manifest['contentHash'] or metadata is None or patch is None
            or len(files) != len(value['artifact']['files']) or len(files) != len(request['config']['layers']) + 2
            or metadata['sha256'] != canonical_sha256(manifest)
            or metadata['sizeBytes'] != len(canonical_json(manifest).encode()) or metadata['sizeBytes'] > 262_144
            or any(payload['path'] not in files or files[payload['path']]['sha256'] != payload['sha256']
                   or files[payload['path']]['sizeBytes'] != payload['sizeBytes'] for payload in payloads)
            or any(row['artifactId'] != value['artifact']['id'] for row in files.values())
            or sum(row['sizeBytes'] for row in files.values()) > request['training']['maxCheckpointBytes']):
        raise ProtocolError('alphaedit_result_mismatch')
    return value
