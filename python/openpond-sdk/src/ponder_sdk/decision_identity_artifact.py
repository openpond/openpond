"""Portable decision adapter metadata; actual byte custody is separate."""
from typing import Any
from .decision_identity import (
    DECISION_MODEL_HASH, DECISION_PROMPT_CODE_SHA256, _content_matches,
    verify_decision_model_identity,
)
from .errors import ProtocolError
from .wire import canonical_json, canonical_sha256, validate


DECISION_ADAPTER_CONFIG_HASH = '8b8567308690ee462daa26d7115da0dedeeaa452ace5fe51774bde459a44a317'
DECISION_TENSOR_INVENTORY_HASH = '577e6341c3d51f7c6f72872ddde12906018adb9d29da2128e96d52c4ff1eb050'
DECISION_ARTIFACT_CONTRACT_HASH = '3e9ebd77b718b691210e6527f3fff878da215e8f6a2423d2bb48b86dcdd732b8'


def decision_adapter_config() -> dict[str, Any]:
    """The released hybrid-backbone PEFT export, never a generic LoRA recipe."""
    return {
        'base_model_name_or_path': 'Qwen/Qwen3.5-9B',
        'revision': 'c202236235762e1c871ad0ccb60c8ee5ba337b9a',
        'peft_type': 'LORA', 'peft_version': '0.21.0', 'task_type': 'CAUSAL_LM',
        'r': 16, 'lora_alpha': 32, 'lora_dropout': 0.05, 'bias': 'none', 'inference_mode': True,
        'fan_in_fan_out': False, 'use_dora': False, 'use_rslora': False, 'modules_to_save': None,
        'target_modules': ['o_proj', 'down_proj', 'k_proj', 'gate_proj', 'in_proj_b', 'in_proj_z',
                           'in_proj_a', 'out_proj', 'q_proj', 'in_proj_qkv', 'v_proj', 'up_proj'],
    }


def decision_artifact_contract(model: Any) -> dict[str, Any]:
    value = verify_decision_model_identity(model)
    return validate('DecisionArtifactContractSchema', {
        'schemaVersion': 'openpond.decisionArtifactContract.v1', 'task': 'schema_candidate_classification_v1',
        'modelHash': DECISION_MODEL_HASH, 'tokenizerHash': value['tokenizer']['contentHash'],
        'promptCodeSha256': DECISION_PROMPT_CODE_SHA256, 'stateEncoding': 'canonical_json_utf8_v1',
        'integerLevels': 'decimal_enum_strings_v1', 'objective': 'candidate_cross_entropy_v1',
        'labelsOutsidePrompt': True, 'temperature': 1, 'maximumPromptTokens': 2048,
        'enableThinking': False, 'truncation': False,
    })


def decision_adapter_tensor_inventory() -> list[dict[str, Any]]:
    """Exact ordered 496 F32 tensor names/shapes from the pinned source header."""
    rows = []
    for layer in range(32):
        modules = [('mlp.down_proj', 12_288, 4096), ('mlp.gate_proj', 4096, 12_288), ('mlp.up_proj', 4096, 12_288)]
        modules += ([('self_attn.q_proj', 4096, 8192), ('self_attn.k_proj', 4096, 1024),
                     ('self_attn.v_proj', 4096, 1024), ('self_attn.o_proj', 4096, 4096)] if layer % 4 == 3 else
                    [('linear_attn.in_proj_a', 4096, 32), ('linear_attn.in_proj_b', 4096, 32),
                     ('linear_attn.in_proj_qkv', 4096, 8192), ('linear_attn.in_proj_z', 4096, 4096),
                     ('linear_attn.out_proj', 4096, 4096)])
        for name, input_size, output_size in modules:
            prefix = f'base_model.model.model.language_model.layers.{layer}.{name}'
            rows.extend([
                {'name': prefix + '.lora_A.weight', 'shape': [16, input_size], 'dtype': 'F32'},
                {'name': prefix + '.lora_B.weight', 'shape': [output_size, 16], 'dtype': 'F32'},
            ])
    return sorted(rows, key=lambda row: row['name'])


def verify_decision_adapter_artifact(raw: Any, expected: dict[str, Any] | None = None) -> dict[str, Any]:
    """Bind manifest metadata; the artifact owner must seal the actual files."""
    value = validate('DecisionAdapterArtifactSchema', raw)
    verify_decision_model_identity(value['model'])
    pins, payload = value['pins'], value['payload']
    if (not _content_matches(value)
            or canonical_sha256(value['adapterConfig']) != DECISION_ADAPTER_CONFIG_HASH
            or canonical_json(value['adapterConfig']) != canonical_json(decision_adapter_config())
            or canonical_sha256(value['contract']) != DECISION_ARTIFACT_CONTRACT_HASH
            or canonical_json(value['contract']) != canonical_json(decision_artifact_contract(value['model']))
            or canonical_sha256(payload['tensors']) != DECISION_TENSOR_INVENTORY_HASH
            or canonical_json(payload['tensors']) != canonical_json(decision_adapter_tensor_inventory())
            or payload['sizeBytes'] < sum(row['shape'][0] * row['shape'][1] * 4 for row in payload['tensors'])):
        raise ProtocolError('decision_artifact_mismatch')
    if expected is not None:
        keys = ('inputHash', 'recipeHash', 'dataHash', 'runtimeHash', 'parentArtifactHash')
        if ('model' not in expected or any(key not in expected for key in keys)
                or canonical_json(value['model']) != canonical_json(expected['model'])
                or any(pins[key] != expected[key] for key in keys)):
            raise ProtocolError('decision_artifact_mismatch')
    return value
