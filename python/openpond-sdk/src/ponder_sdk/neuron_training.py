"""Portable selective-neuron metadata verification; no torch or asset I/O.

Learned tensor possession and runtime behavior remain separate worker/storage
evidence. These checks bind the exact authored request and retained result.
"""
from __future__ import annotations
from typing import Any
from .errors import ProtocolError
from .wire import canonical_json, canonical_sha256, validate


def _fail(code: str = 'neuron_training_artifact_mismatch') -> None:
    raise ProtocolError(code)


def _bounded(raw: Any, maximum: int) -> None:
    if len(canonical_json(raw).encode('utf-8')) > maximum:
        _fail()


def _content_hash(value: dict[str, Any]) -> str:
    return canonical_sha256({key: item for key, item in value.items() if key != 'contentHash'})


def _close(a: float, b: float) -> bool:
    return abs(a - b) <= 1e-6 * max(1, abs(a), abs(b))


def verify_neuron_training_request(raw: Any) -> dict[str, Any]:
    _bounded(raw, 131_072)
    value = validate('NeuronTrainingRequestSchema', raw)
    model, selection, data, settings = (value[key] for key in ('model', 'selection', 'data', 'training'))
    coordinates = selection['explicitCoordinates']
    if (model['modelId'] != 'Qwen/Qwen3-8B' or model['revision'] != 'b968826d9c46dd6066d109eabc6255188de91218'
            or model['dtype'] != 'bfloat16' or model['hiddenSize'] != 4096 or model['intermediateSizes'] != [12288] * 36
            or model['adapter'] is not None
            or (len(data['background']) != 0 if value['parentArtifact'] else len(data['background']) == 0)
            or len({row['domain'] for row in data['background']}) != len(data['background'])
            or coordinates is not None and (len(coordinates) != selection['count']
                or len({(row['layer'], row['neuron']) for row in coordinates}) != selection['count'])
            or (settings['preservationWeight'] > 0) != (data['preservation'] is not None)
            or (settings['preservationWeight'] > 0) != (settings['preservationExamplesPerStep'] > 0)):
        _fail('neuron_training_request_mismatch')
    encoding_hash = canonical_sha256({
        'schemaVersion': 'openpond.neuronTrainingEncoding.v1',
        'implementation': 'supervised_trainer.prepare_example.v1',
        'modelHash': canonical_sha256(model), 'tokenizerHash': model['tokenizerHash'],
        'maxSequenceLength': settings['maxSequenceLength'], 'completionOnly': True,
        'enableThinking': False, 'truncation': 'left_prompt_preserve_final_target_v1',
        'selectionBoundaries': 'verified_last_user_template_offsets_v1',
    })
    if any(row['encodingHash'] != encoding_hash for row in [data['target'], *data['background'],
            *([data['preservation']] if data['preservation'] is not None else [])]):
        _fail('neuron_training_encoding_mismatch')
    return value


def verify_neuron_training_selection(raw: Any, request: dict[str, Any]) -> dict[str, Any]:
    request = verify_neuron_training_request(request)
    value = validate('NeuronTrainingSelectionResultSchema', raw)
    selection, entries = request['selection'], value['entries']
    coordinates = [{'layer': row['layer'], 'neuron': row['neuron']} for row in entries]
    if (value['contentHash'] != _content_hash(value) or value['modelHash'] != canonical_sha256(request['model'])
            or (value['contentHash'] != request['parentArtifact']['selectionHash'] if request['parentArtifact']
                else value['dataHash'] != canonical_sha256(request['data']))
            or value['selectionConfigHash'] != canonical_sha256(selection)
            or len(entries) != selection['count'] or value['eligibleCount'] < len(entries)
            or len({(row['layer'], row['neuron']) for row in entries}) != len(entries)
            or len(set(value['targetExampleIds'])) != len(value['targetExampleIds'])
            or len(value['targetExampleIds']) > selection['gradientExamples']
            or value['source'] != ('explicit' if selection['explicitCoordinates'] is not None else 'automatic')
            or selection['explicitCoordinates'] is not None and coordinates != selection['explicitCoordinates']):
        _fail()
    if value['source'] == 'automatic' and entries != sorted(entries, key=lambda row: (-row['score'], row['layer'], row['neuron'])):
        _fail()
    for row in entries:
        domains = row['backgroundByDomain']
        if (row['targetMeanAbsolute'] < row['targetActivityThreshold']
                or row['backgroundTargetRatio'] > selection['maximumBackgroundTargetRatio'] + 1e-6
                or not _close(row['backgroundTargetRatio'], row['backgroundMeanAbsolute'] / row['targetMeanAbsolute'])
                or not _close(row['score'], row['gradientNorm'] / max(row['backgroundMeanAbsolute'], 0.000001))
                or [item['domainIndex'] for item in domains] != list(range(
                    len(entries[0]['backgroundByDomain']) if request['parentArtifact'] else len(request['data']['background'])))):
            _fail()
        background = (max(item['meanAbsolute'] for item in domains) if selection['backgroundStatistic'] == 'max_domains'
                      else sum(item['meanAbsolute'] for item in domains) / len(domains))
        if not _close(background, row['backgroundMeanAbsolute']):
            _fail()
    return value


def neuron_training_tensor_inventory(selection: dict[str, Any]) -> list[dict[str, Any]]:
    value = validate('NeuronTrainingSelectionResultSchema', selection)
    counts: dict[int, int] = {}
    for row in value['entries']:
        counts[row['layer']] = counts.get(row['layer'], 0) + 1
    rows = []
    for layer, count in counts.items():
        rows.extend([{'name': f'layer{layer}.indices', 'dtype': 'I64', 'shape': [count]},
                     {'name': f'layer{layer}.delta', 'dtype': 'F32', 'shape': [4096, count]}])
    return sorted(rows, key=lambda row: row['name'])


def verify_neuron_training_artifact(raw: Any, request: dict[str, Any], runtime_hash: str) -> dict[str, Any]:
    _bounded(raw, 262_144)
    request = verify_neuron_training_request(request)
    value = validate('NeuronTrainingArtifactSchema', raw)
    selection = verify_neuron_training_selection(value['selection'], request)
    pins, payload = value['pins'], value['payload']
    if (value['contentHash'] != _content_hash(value) or pins['baseModel'] != request['model']
            or pins['data'] != request['data'] or pins['inputHash'] != canonical_sha256(request)
            or pins['dataHash'] != canonical_sha256(request['data'])
            or pins['selectionConfigHash'] != canonical_sha256(request['selection'])
            or pins['trainingConfigHash'] != canonical_sha256(request['training']) or pins['runtimeHash'] != runtime_hash
            or pins['parentArtifactHash'] != (request['parentArtifact']['contentHash'] if request['parentArtifact'] else None)
            or payload['tensors'] != neuron_training_tensor_inventory(selection)
            or payload['sizeBytes'] > request['training']['maxCheckpointBytes']):
        _fail()
    parent, continuation = request['parentArtifact'], value.get('continuation')
    if parent:
        if (not continuation or continuation['parentArtifactHash'] != parent['contentHash']
                or continuation['parentSelectionHash'] != parent['selectionHash']
                or continuation['parentPayloadSha256'] != parent['payloadSha256']
                or continuation['parentPatchStateSha256'] != continuation['initialPatchStateSha256']
                or continuation['finalPatchStateSha256'] == continuation['initialPatchStateSha256']):
            _fail()
    elif continuation is not None:
        _fail()
    return value


def verify_neuron_training_result(raw: Any, request: dict[str, Any], runtime_hash: str) -> dict[str, Any]:
    _bounded(raw, 1_048_576)
    request = verify_neuron_training_request(request)
    value = validate('NeuronTrainingResultSchema', raw)
    manifest = verify_neuron_training_artifact(value['artifact']['manifest'], request, runtime_hash)
    files = {row['path']: row for row in value['artifact']['files']}
    metadata, tensor = files.get('manifest.json'), files.get('patch.safetensors')
    settings, work = request['training'], value['work']
    preserve = settings['preservationWeight'] > 0
    if (value['contentHash'] != _content_hash(value) or value['inputHash'] != canonical_sha256(request)
            or value['modelHash'] != canonical_sha256(request['model']) or value['dataHash'] != canonical_sha256(request['data'])
            or value['runtimeHash'] != runtime_hash
            or not request['parentArtifact'] and value['preparedRowsHash'] != value['selection']['preparedRowsHash']
            or value['selection'] != manifest['selection'] or value['artifact']['contentHash'] != manifest['contentHash']
            or value['baseWeightsHashBefore'] != request['model']['weightsHash']
            or value['baseWeightsHashAfter'] != value['baseWeightsHashBefore']
            or value['trainableParameterCount'] != request['selection']['count'] * (request['model']['hiddenSize'] + 1)
            or value['optimizerSteps'] != settings['maxSteps']
            or value['examplesProcessed'] != value['optimizerSteps'] * settings['gradientAccumulationSteps']
            or value['durationMs'] > settings['maxDurationSeconds'] * 1000
            or value['forwardTokenWork'] > settings['maximumForwardTokenWork'] or value['forwardTokenWork'] != sum(work.values())
            or value['backwardTokenWork'] != work['selectionGradient'] + work['training'] + work['preservationEdited']
            or value['targetTokens'] > work['training']
            or (work['selectionTarget'] != 0 or work['selectionBackground'] != 0 or work['selectionGradient'] != 0
                if request['parentArtifact'] else work['selectionTarget'] <= 0 or work['selectionBackground'] <= 0)
            or work['selectionGradient'] != work['selectionTarget'] or work['verification'] <= 0
            or preserve != (value['meanPreservationKl'] is not None) or work['preservationOriginal'] != work['preservationEdited']
            or not preserve and (value['preservationTokens'] != 0 or work['preservationOriginal'] != 0)
            or preserve and (value['preservationTokens'] <= 0 or work['preservationOriginal'] <= 0)
            or not tensor or not metadata or tensor['sha256'] != manifest['payload']['sha256']
            or tensor['sizeBytes'] != manifest['payload']['sizeBytes'] or metadata['sha256'] != canonical_sha256(manifest)
            or metadata['sizeBytes'] != len(canonical_json(manifest).encode('utf-8'))
            or any(row['artifactId'] != value['artifact']['id'] for row in value['artifact']['files'])
            or sum(row['sizeBytes'] for row in value['artifact']['files']) > settings['maxCheckpointBytes']):
        _fail('neuron_training_result_mismatch')
    return value
