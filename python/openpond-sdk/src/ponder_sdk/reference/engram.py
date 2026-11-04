"""Load the learned paper-v1 Qwen3-8B memory; no trainer or managed services."""
from __future__ import annotations

from ..engram_adapter import engram_tensor_inventory, verify_engram_artifact
from ..wire import canonical_json
from .artifacts import Check, artifact_root, require, sealed_manifest, tensors
from .engram_history import RequestHistory
from .qwen3 import Qwen3Snapshot, base_identity


def load_engram(snapshot: Qwen3Snapshot, directory, *, expected_content_hash: str,
                maximum_bytes: int = 2_147_483_648, check: Check = lambda: None):
    """Attach validated full learned state to an exact, fresh frozen snapshot.

    This implementation accepts perHashDim=256 only. A 128-wide paper config,
    Spark/DeepSeek layer, quantized base or different Qwen checkpoint is refused.
    Each inference request must own a RequestHistory and execute under request().
    """
    root = artifact_root(directory, {'manifest.json', 'adapter.safetensors'}, maximum_bytes)
    manifest = verify_engram_artifact(sealed_manifest(root, expected_content_hash))
    config = manifest['config']
    base_identity(manifest['pins']['baseModel'])
    require(config['perHashDim'] == 256
            and canonical_json(manifest['pins']['baseModel']) == canonical_json(snapshot.identity), 'engram_supported_identity')
    require(manifest['payload']['tensors'] == engram_tensor_inventory(config, 4096), 'engram_tensor_inventory')
    snapshot.verify(check)
    state = tensors(root / 'adapter.safetensors', manifest['payload'], maximum_header=65_536, check=check)
    from ._engram_torch import EngramModule
    module = EngramModule(config, state, device=next(snapshot.model.parameters()).device)
    module.manifest = manifest
    module.attach(snapshot.model)
    return module


__all__ = ['load_engram', 'RequestHistory']
