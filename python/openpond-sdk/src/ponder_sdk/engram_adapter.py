"""Portable Engram metadata verification; importing this module needs no torch.

Tensor possession and trained behavior require the artifact/runtime owners.
"""
from typing import Any
from .errors import ProtocolError
from .wire import canonical_json, canonical_sha256, validate


def verify_engram_request(raw: Any) -> dict[str, Any]:
    value = validate('EngramTrainingRequestSchema', raw)
    encoding = {
        'schemaVersion': 'openpond.engramSupervisedEncoding.v1',
        'implementation': 'supervised_trainer.prepare_example.v1',
        'modelHash': canonical_sha256(value['model']),
        'tokenizerHash': value['model']['tokenizerHash'],
        'maxSequenceLength': value['training']['maxSequenceLength'],
        'completionOnly': True, 'enableThinking': False,
        'truncation': 'left_prompt_preserve_final_target_v1',
    }
    if value['data']['encodingHash'] != canonical_sha256(encoding):
        raise ProtocolError('engram_encoding_mismatch')
    return value


def engram_tensor_inventory(config: dict[str, Any], hidden_size: int) -> list[dict[str, Any]]:
    config = validate('EngramAdapterConfigSchema', config)
    if type(hidden_size) is not int or not 1 <= hidden_size <= 1_000_000:
        raise ProtocolError('engram_artifact_mismatch')
    rows = []
    for group in ('suffix2', 'suffix3', 'previous3'):
        for head in range(config['numHashes']):
            rows.append({'name': f'shared.embeddings.{group}.{head}.weight', 'dtype': 'F32',
                         'shape': [config['tableSize'], config['perHashDim']]})
            rows.append({'name': f'shared.occupancy.{group}.h{head}', 'dtype': 'BOOL', 'shape': [config['tableSize']]})
    width = 3 * config['numHashes'] * config['perHashDim']
    for layer in config['injectLayers']:
        rows.extend([
            {'name': f'layers.{layer}.projection.weight', 'dtype': 'F32', 'shape': [hidden_size, width]},
            {'name': f'layers.{layer}.gate_memory', 'dtype': 'F32', 'shape': [width]},
            {'name': f'layers.{layer}.gate_hidden', 'dtype': 'F32', 'shape': [hidden_size]},
        ])
    return sorted(rows, key=lambda row: row['name'])


def verify_engram_artifact(raw: Any, request: dict[str, Any] | None = None,
                           runtime_hash: str | None = None) -> dict[str, Any]:
    value = validate('EngramAdapterArtifactSchema', raw)
    pins, payload = value['pins'], value['payload']
    if (value['contentHash'] != canonical_sha256({key: item for key, item in value.items() if key != 'contentHash'})
            or pins['adapterConfigHash'] != canonical_sha256(value['config'])
            or pins['dataHash'] != canonical_sha256(pins['data'])
            or sorted(payload['tensors'], key=lambda row: row['name']) != engram_tensor_inventory(value['config'], pins['baseModel']['hiddenSize'])):
        raise ProtocolError('engram_artifact_mismatch')
    if request is not None:
        request = verify_engram_request(request)
        if (value['config'] != request['config'] or pins['baseModel'] != request['model']
                or pins['data'] != request['data'] or pins['recipeHash'] != canonical_sha256(request['training'])
                or pins['runtimeHash'] != runtime_hash
                or pins['parentArtifactHash'] != (request['parentArtifact']['contentHash'] if request['parentArtifact'] else None)
                or payload['sizeBytes'] > request['training']['maxCheckpointBytes']):
            raise ProtocolError('engram_artifact_mismatch')
    return value


def verify_engram_result(raw: Any, request: dict[str, Any], runtime_hash: str) -> dict[str, Any]:
    request = verify_engram_request(request)
    value = validate('EngramTrainingResultSchema', raw)
    manifest = verify_engram_artifact(value['artifact']['manifest'], request, runtime_hash)
    files = {row['path']: row for row in value['artifact']['files']}
    metadata, tensor = files.get('manifest.json'), files.get('adapter.safetensors')
    if (value['contentHash'] != canonical_sha256({key: item for key, item in value.items() if key != 'contentHash'})
            or value['inputHash'] != canonical_sha256(request)
            or value['modelHash'] != canonical_sha256(request['model'])
            or value['dataHash'] != canonical_sha256(request['data']) or value['runtimeHash'] != runtime_hash
            or value['optimizerSteps'] != request['training']['maxSteps']
            or value['examplesProcessed'] != value['optimizerSteps'] * request['training']['gradientAccumulationSteps']
            or value['targetTokens'] > value['forwardTokenWork']
            or value['durationMs'] > request['training']['maxDurationSeconds'] * 1000
            or value['baseWeightsHashBefore'] != request['model']['weightsHash']
            or value['baseWeightsHashAfter'] != value['baseWeightsHashBefore']
            or value['artifact']['contentHash'] != manifest['contentHash']
            or metadata is None or tensor is None
            or metadata['sizeBytes'] > 262_144
            or metadata['sha256'] != canonical_sha256(manifest)
            or metadata['sizeBytes'] != len(canonical_json(manifest).encode('utf-8'))
            or tensor['sha256'] != manifest['payload']['sha256'] or tensor['sizeBytes'] != manifest['payload']['sizeBytes']
            or any(row['artifactId'] != value['artifact']['id'] for row in files.values())
            or sum(row['sizeBytes'] for row in files.values()) > request['training']['maxCheckpointBytes']):
        raise ProtocolError('engram_training_result_mismatch')
    return value
