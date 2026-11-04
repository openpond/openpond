"""Exact local Qwen3-8B snapshots shared by the portable modification loaders."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from ..wire import canonical_sha256, validate
from .artifacts import Check, file_hash, read_json, require

BASE_ID = 'Qwen/Qwen3-8B'
BASE_REVISION = 'b968826d9c46dd6066d109eabc6255188de91218'


def base_identity(raw):
    value = validate('NeuronSteeringModelSchema', raw)
    require(value['modelId'] == BASE_ID and value['revision'] == BASE_REVISION
            and value['hiddenSize'] == 4096 and value['intermediateSizes'] == [12288] * 36
            and value['dtype'] == 'bfloat16' and value['adapter'] is None
            and value['quantization'] == 'none', 'qwen3_identity')
    return value


@dataclass
class Qwen3Snapshot:
    model: Any
    tokenizer: Any
    identity: dict[str, Any]
    config: dict[str, Any]
    tokenizer_descriptor: dict[str, Any]

    def steering_reference(self, check: Check = lambda: None):
        """Bridge the exact snapshot to the existing serial steering executor."""
        self.verify(check)
        from .dense_model import DenseReferenceModel
        def forward(ids, mask, positions):
            return self.model(input_ids=ids, attention_mask=mask, position_ids=positions,
                              use_cache=False, return_dict=True).logits
        return DenseReferenceModel(self.model, identity=self.identity, config=self.config,
            tokenizer=self.tokenizer_descriptor, layers=self.model.model.layers,
            down_projections=[layer.mlp.down_proj for layer in self.model.model.layers], forward=forward)

    def verify(self, check: Check = lambda: None) -> None:
        import torch
        from transformers.models.qwen3.modeling_qwen3 import Qwen3ForCausalLM
        from .dense_model import tensor_state_hash
        identity = base_identity(self.identity)
        require(not getattr(self, '_poisoned', False), 'qwen3_snapshot_unusable')
        model = self.model
        require(type(model) is Qwen3ForCausalLM and not getattr(model, 'is_quantized', False)
                and not getattr(model, 'peft_config', None) and not model.is_gradient_checkpointing, 'qwen3_architecture')
        require(canonical_sha256(self.config) == identity['configHash']
                and canonical_sha256(self.tokenizer_descriptor) == identity['tokenizerHash'], 'qwen3_source_identity')
        require(model.config.model_type == self.config.get('model_type') == 'qwen3'
                and model.config.hidden_size == self.config.get('hidden_size') == 4096
                and model.config.intermediate_size == self.config.get('intermediate_size') == 12288
                and model.config.num_hidden_layers == self.config.get('num_hidden_layers') == 36
                and len(model.model.layers) == 36, 'qwen3_geometry')
        require(all(not module.training and not module._forward_hooks and not module._forward_pre_hooks
                    for module in model.modules()), 'qwen3_busy')
        parameters = list(model.parameters())
        require(parameters and len({p.device for p in parameters}) == 1
                and all(p.device.type in ('cpu', 'cuda') and p.dtype == torch.bfloat16
                        and not p.requires_grad and p.grad is None for p in parameters), 'qwen3_dense_frozen_base')
        for layer in model.model.layers:
            require(type(layer.mlp.down_proj) is torch.nn.Linear
                    and tuple(layer.mlp.down_proj.weight.shape) == (4096, 12288), 'qwen3_projection')
        require(tensor_state_hash(model, check) == identity['weightsHash'], 'qwen3_base_weights')


def load_qwen3_snapshot(directory, *, model_identity, tokenizer_descriptor, device='cuda:0',
                        check: Check = lambda: None) -> Qwen3Snapshot:
    """Load verified local safetensors only; no downloads or remote model code."""
    identity = base_identity(model_identity)
    root = Path(directory).resolve(strict=True)
    require(root.is_dir() and canonical_sha256(tokenizer_descriptor) == identity['tokenizerHash'], 'tokenizer_identity')
    rows = tokenizer_descriptor.get('files', [])
    require(2 <= len(rows) <= 64 and len({row['path'] for row in rows}) == len(rows), 'tokenizer_inventory')
    for row in rows:
        relative = PurePosixPath(row['path'])
        require(not relative.is_absolute() and '..' not in relative.parts and str(relative) == row['path']
                and '\\' not in row['path'], 'tokenizer_path')
        path = root.joinpath(*relative.parts)
        require(path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(root)
                and path.stat().st_size == row['sizeBytes'] and file_hash(path, check) == row['sha256'], 'tokenizer_bytes')
    require({'tokenizer.json', 'tokenizer_config.json'} <= {row['path'] for row in rows}, 'tokenizer_inventory')
    config = read_json(root / 'config.json', 1_048_576)
    require(canonical_sha256(config) == identity['configHash'], 'qwen3_config')
    import torch
    from transformers import AutoTokenizer
    from transformers.models.qwen3.modeling_qwen3 import Qwen3ForCausalLM
    tokenizer = AutoTokenizer.from_pretrained(str(root), local_files_only=True, trust_remote_code=False)
    model = Qwen3ForCausalLM.from_pretrained(str(root), local_files_only=True, trust_remote_code=False,
        use_safetensors=True, torch_dtype=torch.bfloat16, device_map={'': device}, attn_implementation='eager').eval()
    model.requires_grad_(False)
    snapshot = Qwen3Snapshot(model, tokenizer, identity, config, tokenizer_descriptor)
    snapshot.verify(check)
    return snapshot
