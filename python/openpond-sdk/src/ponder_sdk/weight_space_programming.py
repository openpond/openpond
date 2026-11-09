"""Weight-space wire verification shared by clients, workers and patch loaders."""
from __future__ import annotations

from .errors import ProtocolError
from .wire import canonical_json, canonical_sha256, validate


def require(value):
    if not value:
        raise ProtocolError('weight_space_identity_mismatch')


def verify_weight_space_request(raw):
    from .reference.qwen3 import base_identity
    value = validate('WeightSpaceRequestSchema', raw)
    base_identity(value['model'])
    panels, limits = value['panels'], value['limits']
    require(limits['maximumIdleSeconds'] <= limits['maximumDurationSeconds']
            and len(canonical_json(value).encode()) <= 1_048_576
            and len({p['id'] for p in panels}) == len(panels)
            and any(p['role'] == 'development' for p in panels))
    for panel in panels:
        require(len({p['id'] for p in panel['prompts']}) == len(panel['prompts']))
        if value['frozenEvaluation'] is not None and panel['source'] is not None:
            require(value['frozenEvaluation']['id'] != panel['source']['id'])
    return value


def verify_weight_space_artifact(raw, request=None, runtime_hash=None):
    from .reference.qwen3 import base_identity
    value = validate('WeightSpaceArtifactSchema', raw)
    base_identity(value['model'])
    columns = value['columns']
    require(value['contentHash'] == canonical_sha256({k: v for k, v in value.items() if k != 'contentHash'})
            and [r['layer'] for r in columns] == sorted({r['layer'] for r in columns})
            and len(columns) == len(value['columnHashes'])
            and sum(len(r['columns']) for r in columns) <= 128)
    inventory = []
    candidate = []
    for row, digest in zip(columns, value['columnHashes']):
        require(row['columns'] == sorted(set(row['columns'])))
        count = len(row['columns'])
        inventory.extend([{'name': f"layer{row['layer']}.indices", 'dtype': 'I64', 'shape': [count]},
                          {'name': f"layer{row['layer']}.replacement", 'dtype': 'BF16', 'shape': [4096, count]}])
        candidate.append({**row, 'sha256': digest})
    require(value['payload']['tensors'] == sorted(inventory, key=lambda row: row['name'])
            and value['candidateHash'] == canonical_sha256({'schemaVersion': 'openpond.weightSpaceCandidate.v1',
                'model': value['model'], 'columns': candidate})
            and value['payload']['sizeBytes'] >= sum(len(r['columns']) for r in columns) * (4096 * 2 + 8)
            and value['reload']['effectiveColumnsHash'] == canonical_sha256(value['columnHashes'])
            and value['reload']['untouchedWeightsHashBefore'] == value['model']['weightsHash']
            and value['reload']['effectiveColumnsHash'] == value['reload']['reloadedColumnsHash']
            and value['reload']['untouchedWeightsHashBefore'] == value['reload']['untouchedWeightsHashAfter'])
    if request is not None:
        verify_weight_space_request(request)
        require(value['requestHash'] == canonical_sha256(request) and value['model'] == request['model']
                and value['teacher'] == request['teacher'] and value['runtimeHash'] == runtime_hash
                and sum(len(r['columns']) for r in columns) <= request['limits']['maximumPatchColumns']
                and value['payload']['sizeBytes'] <= request['limits']['maximumCheckpointBytes'])
    return value


def verify_weight_space_command_result(raw, command):
    value = validate('WeightSpaceCommandResultSchema', raw)
    require(value['contentHash'] == canonical_sha256({k: v for k, v in value.items() if k != 'contentHash'})
            and value['sessionId'] == command['sessionId'] and value['operationId'] == command['operationId']
            and value['requestHash'] == canonical_sha256(command)
            and value['parentCandidateHash'] == command['candidateHash']
            and value['revision'] == command['expectedRevision'] + 1)
    if value['status'] == 'rejected':
        require(value['code'] is not None and value['candidateHash'] == command['candidateHash'])
    else:
        require(value['code'] is None)
        if command['action'] not in ('program', 'code', 'select'):
            require(value['candidateHash'] == command['candidateHash'])
        if command['action'] == 'select':
            require(value['candidateHash'] == command['targetCandidateHash'])
        if command['action'] == 'evaluate':
            require(value['evaluation'] is not None)
        if command['action'] == 'catalog':
            require(value['catalog'] is not None)
    require(value['catalog'] is None or command['action'] == 'catalog')
    require([row['layer'] for row in value['changedColumns']] == sorted({row['layer'] for row in value['changedColumns']})
            and sum(len(row['columns']) for row in value['changedColumns']) <= 128)
    require(all(row['columns'] == sorted(set(row['columns'])) for row in value['changedColumns']))
    summaries = list(value['tensors'].values())
    require(len(summaries) <= 8 and sum(len(row['values']) for row in summaries) <= 4096)
    for row in summaries:
        import math
        count = math.prod(row['shape'])
        require(count <= 1_048_576 and len(row['values']) <= count and row['truncated'] == (len(row['values']) < count)
                and row['minimum'] <= row['maximum'] and row['norm'] >= 0)
    if value['catalog'] is not None:
        catalog = value['catalog']
        names = [row['name'] for row in catalog['items']]
        require(len(names) <= command['limit'] and names == sorted(set(names))
                and (catalog['nextOffset'] is None or len(names) == command['limit'] and catalog['nextOffset'] == command['offset']+command['limit']))
    if value['status'] == 'rejected':
        require(value['evaluation'] is None and value.get('finalEvaluation') is None and value['catalog'] is None and value['tensors'] == {})
    if value['evaluation'] is not None:
        require(command['action'] == 'evaluate' and value['evaluation']['panelId'] == command['panelId']
                and value['evaluation']['candidateHash'] == command['candidateHash'])
    if value.get('finalEvaluation') is not None:
        final = value['finalEvaluation']
        require(command['action'] == 'finalize' and value['status'] == 'succeeded'
                and final['candidateHash'] == command['candidateHash'] and final['panelId'] == final['source']['id'])
        baseline = final['baseline']
        require(baseline['candidateHash'] != final['candidateHash'] and len(baseline['rows']) == len(final['rows'])
                and all(a['id'] == b['id'] and a['inputHash'] == b['inputHash'] for a, b in zip(baseline['rows'], final['rows'])))
    return value


def verify_weight_space_result(raw, request, runtime_hash):
    value = validate('WeightSpaceResultSchema', raw)
    manifest = verify_weight_space_artifact(value['artifact']['manifest'], request, runtime_hash)
    files = {row['path']: row for row in value['artifact']['files']}
    require(value['contentHash'] == canonical_sha256({k: v for k, v in value.items() if k != 'contentHash'})
            and value['inputHash'] == canonical_sha256(request) and value['runtimeHash'] == runtime_hash
            and value['candidateHash'] == manifest['candidateHash'] and value['historyHash'] == manifest['historyHash']
            and value['artifact']['contentHash'] == manifest['contentHash'] and set(files) == {'manifest.json', 'patch.safetensors'}
            and all(row['artifactId'] == value['artifact']['id'] for row in files.values())
            and files['manifest.json']['sha256'] == canonical_sha256(manifest)
            and files['manifest.json']['sizeBytes'] == len(canonical_json(manifest).encode())
            and files['patch.safetensors']['sha256'] == manifest['payload']['sha256']
            and files['patch.safetensors']['sizeBytes'] == manifest['payload']['sizeBytes']
            and value['commands'] <= request['limits']['maximumCommands']
            and value['candidates'] <= request['limits']['maximumCandidates']
            and value['forwardTokenWork'] <= request['limits']['maximumForwardTokenWork']
            and value['durationMs'] <= request['limits']['maximumDurationSeconds'] * 1000)
    return value
