"""Reviewed decision training encoding and sealed result metadata parity.

This verifies the recorded frozen-backbone evidence and four-file inventory;
actual execution, state measurement and committed bytes remain owner checks.
"""
from typing import Any
from .decision_identity import (
    DECISION_MODEL_HASH, DECISION_PROMPT_CODE_SHA256, _bounded, _content_matches,
    _hash, _text, verify_decision_model_identity,
)
from .decision_identity_artifact import verify_decision_adapter_artifact
from .errors import ProtocolError
from .wire import canonical_json, canonical_sha256, validate


def decision_supervised_encoding(model: Any, maximum_prompt_tokens: int) -> dict[str, Any]:
    value = verify_decision_model_identity(model)
    return validate('DecisionSupervisedEncodingSchema', {
        'schemaVersion': 'openpond.decisionSupervisedEncoding.v1',
        'implementation': 'nimble_reference_candidate_logits_v1',
        'modelHash': DECISION_MODEL_HASH, 'tokenizerHash': value['tokenizer']['contentHash'],
        'promptCodeSha256': DECISION_PROMPT_CODE_SHA256, 'maximumPromptTokens': maximum_prompt_tokens,
        'stateEncoding': 'canonical_json_utf8_v1', 'integerLevels': 'decimal_enum_strings_v1',
        'labelsOutsidePrompt': True, 'objective': 'candidate_cross_entropy_v1', 'temperature': 1,
        'enableThinking': False, 'truncation': False, 'microBatchSize': 1,
    })


def verify_decision_training_request(raw: Any) -> dict[str, Any]:
    _bounded(raw, 131_072)
    value = validate('DecisionTrainingRequestSchema', raw)
    encoding = decision_supervised_encoding(value['model'], value['training']['maximumPromptTokens'])
    if value['data']['encodingHash'] != canonical_sha256(encoding):
        raise ProtocolError('decision_encoding_mismatch')
    _text(value['data']['batch']['id'], 500)
    if value['parentArtifact'] is not None:
        _text(value['parentArtifact']['id'], 500)
    return value


def verify_decision_training_result(raw: Any, request: dict[str, Any], runtime_hash: str) -> dict[str, Any]:
    _bounded(raw, 524_288)
    request = verify_decision_training_request(request)
    value = validate('DecisionTrainingResultSchema', raw)
    manifest = verify_decision_adapter_artifact(value['artifact']['manifest'], {
        'model': request['model'], 'inputHash': canonical_sha256(request),
        'recipeHash': canonical_sha256(request['training']), 'dataHash': canonical_sha256(request['data']),
        'runtimeHash': _hash(runtime_hash),
        'parentArtifactHash': request['parentArtifact']['contentHash'] if request['parentArtifact'] is not None else None,
    })
    artifact, training = value['artifact'], request['training']
    _text(artifact['id'], 500)
    files = {row['path']: row for row in artifact['files']}
    initial = request['parentArtifact']['contentHash'] if request['parentArtifact'] is not None else request['model']['originalAdapter']['contentHash']

    def fail() -> None:
        raise ProtocolError('decision_training_result_mismatch')

    if (not _content_matches(value) or value['inputHash'] != manifest['pins']['inputHash']
            or value['modelHash'] != canonical_sha256(request['model']) or value['runtimeHash'] != runtime_hash
            or value['dataHash'] != manifest['pins']['dataHash'] or value['initialAdapterSourceHash'] != initial
            or value['optimizerSteps'] != training['maxSteps']
            or value['questionRowsProcessed'] != value['optimizerSteps'] * training['gradientAccumulationSteps']
            or value['examplesProcessed'] > value['questionRowsProcessed'] or value['targetTokens'] != value['questionRowsProcessed']
            or value['forwardTokenWork'] < value['questionRowsProcessed']
            or value['forwardTokenWork'] > value['questionRowsProcessed'] * training['maximumPromptTokens']
            or value['durationMs'] > training['maxDurationSeconds'] * 1000
            or value['frozenBackboneState']['sourceManifestHash'] != request['model']['backbone']['source']['contentHash']
            or value['frozenBackboneState']['before'] != value['frozenBackboneState']['after']
            or artifact['contentHash'] != manifest['contentHash'] or len(files) != 4
            or any(row['artifactId'] != artifact['id'] for row in artifact['files'])
            or sum(row['sizeBytes'] for row in artifact['files']) > training['maxCheckpointBytes']):
        fail()
    tensor = files.get('adapter_model.safetensors')
    if (tensor is None or tensor['sha256'] != manifest['payload']['sha256']
            or tensor['sizeBytes'] != manifest['payload']['sizeBytes']):
        fail()
    for path, metadata in (('manifest.json', manifest), ('adapter_config.json', manifest['adapterConfig']),
                           ('decision_contract.json', manifest['contract'])):
        file = files.get(path)
        # These files are canonical JSON UTF-8 without a trailing newline.
        if (file is None or file['sha256'] != canonical_sha256(metadata)
                or file['sizeBytes'] != len(canonical_json(metadata).encode('utf-8')) or file['sizeBytes'] > 262_144):
            fail()
    if canonical_json(request['model']) != canonical_json(manifest['model']):
        fail()
    return value
