"""Local-only exact Qwen3.5-9B and released PEFT inference integration."""
from __future__ import annotations

from .artifacts import read_json, require

# The pinned full source has exactly these 15 auxiliary MTP keys. The supported
# HF conditional-generation class instantiates the other 760, including vision.
OMITTED_MTP_KEYS = frozenset({
    'mtp.fc.weight', 'mtp.layers.0.input_layernorm.weight', 'mtp.layers.0.mlp.down_proj.weight',
    'mtp.layers.0.mlp.gate_proj.weight', 'mtp.layers.0.mlp.up_proj.weight', 'mtp.layers.0.post_attention_layernorm.weight',
    'mtp.layers.0.self_attn.k_norm.weight', 'mtp.layers.0.self_attn.k_proj.weight', 'mtp.layers.0.self_attn.o_proj.weight',
    'mtp.layers.0.self_attn.q_norm.weight', 'mtp.layers.0.self_attn.q_proj.weight', 'mtp.layers.0.self_attn.v_proj.weight',
    'mtp.norm.weight', 'mtp.pre_fc_norm_embedding.weight', 'mtp.pre_fc_norm_hidden.weight',
})


def load_model(roots, artifact_directory, *, device, check):
    import torch
    from peft import PeftModel, get_peft_model_state_dict
    from safetensors import safe_open
    from transformers import AutoTokenizer, Qwen3_5ForConditionalGeneration
    from ..decision_identity_artifact import decision_adapter_tensor_inventory
    tokenizer = AutoTokenizer.from_pretrained(str(roots['tokenizer']), local_files_only=True, trust_remote_code=False)
    require(type(tokenizer.pad_token_id) is int and tokenizer.chat_template
            == (roots['tokenizer'] / 'chat_template.jinja').read_text(), 'decision_tokenizer')
    check()
    base, information = Qwen3_5ForConditionalGeneration.from_pretrained(str(roots['backbone']),
        local_files_only=True, trust_remote_code=False, use_safetensors=True, dtype=torch.bfloat16,
        attn_implementation='sdpa', output_loading_info=True, device_map={'': device})
    require(not information.get('missing_keys') and not information.get('mismatched_keys')
            and not information.get('error_msgs') and set(information.get('unexpected_keys', [])) <= OMITTED_MTP_KEYS,
            'decision_backbone_load')
    require(type(base) is Qwen3_5ForConditionalGeneration and base.config.model_type == 'qwen3_5'
            and not getattr(base, 'is_quantized', False), 'decision_architecture')
    source_keys = set(read_json(roots['backbone'] / 'model.safetensors.index.json')['weight_map'])
    require(len(source_keys) == 775 and {key for key in source_keys if key.startswith('mtp')} == OMITTED_MTP_KEYS
            and source_keys - OMITTED_MTP_KEYS == set(base.state_dict()) and len(base.state_dict()) == 760,
            'decision_source_tensors')
    base.requires_grad_(False)
    base.eval()
    base.config.use_cache = False
    require(all(not p.requires_grad and p.grad is None and p.dtype == torch.bfloat16
                and p.device.type in ('cpu', 'cuda') for p in base.parameters()), 'decision_frozen_backbone')
    model = PeftModel.from_pretrained(base, str(artifact_directory), is_trainable=False,
                                      local_files_only=True, autocast_adapter_dtype=True).eval()
    model.config.use_cache = False
    state = get_peft_model_state_dict(model, adapter_name='default')
    inventory = decision_adapter_tensor_inventory()
    require(set(state) == {row['name'] for row in inventory}, 'decision_adapter_inventory')
    with safe_open(str(artifact_directory / 'adapter_model.safetensors'), framework='pt', device='cpu') as payload:
        for row in inventory:
            check()
            tensor = state[row['name']]
            require(list(tensor.shape) == row['shape'] and tensor.dtype == torch.float32
                    and bool(torch.isfinite(tensor).all()), 'decision_adapter_tensor')
            expected = payload.get_slice(row['name'])
            for start in range(0, row['shape'][0], 256):
                check()
                require(torch.equal(tensor[start:start + 256].detach().cpu(), expected[start:start + 256]),
                        'decision_adapter_not_loaded')
    require(all(not p.requires_grad and p.grad is None for p in model.parameters()), 'decision_frozen_model')
    check()
    return model, tokenizer
