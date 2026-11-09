"""Install an exact agent-authored BF16 column patch on its verified original base."""
from __future__ import annotations

from .artifacts import artifact_root, require, sealed_manifest, tensors
from .weight_space_tensors import tensor_hash
from ..weight_space_programming import verify_weight_space_artifact
from ..wire import canonical_json


def load_weight_space_patch(snapshot, directory, *, expected_content_hash, maximum_bytes=16_777_216, check=lambda: None):
    import torch
    from pathlib import Path
    root = artifact_root(Path(directory), {'manifest.json', 'patch.safetensors'}, maximum_bytes)
    manifest = verify_weight_space_artifact(sealed_manifest(root, expected_content_hash))
    require(canonical_json(snapshot.identity) == canonical_json(manifest['model']), 'weight_space_base_identity')
    snapshot.verify(check)
    payload = tensors(root / 'patch.safetensors', manifest['payload'], check=check)
    staged, originals = [], []
    for row, digest in zip(manifest['columns'], manifest['columnHashes']):
        check()
        indices = payload[f"layer{row['layer']}.indices"]
        replacement = payload[f"layer{row['layer']}.replacement"]
        require(indices.tolist() == row['columns'] and tensor_hash(replacement) == digest, 'weight_space_column_identity')
        target = snapshot.model.model.layers[row['layer']].mlp.down_proj.weight
        ids = indices.to(target.device)
        staged.append((target, ids, replacement.to(target.device)))
        originals.append((target, ids, target.index_select(1, ids).detach().clone()))
    try:
        with torch.no_grad():
            for target, ids, replacement in staged:
                target.index_copy_(1, ids, replacement)
            for device in {target.device for target, _, _ in staged if target.device.type == 'cuda'}:
                torch.cuda.synchronize(device)
    except BaseException:
        try:
            with torch.no_grad():
                for target, ids, original in originals:
                    target.index_copy_(1, ids, original)
                for device in {target.device for target, _, _ in originals if target.device.type == 'cuda'}:
                    torch.cuda.synchronize(device)
        except BaseException:
            snapshot._poisoned = True
            raise RuntimeError('weight_space_patch_rollback_failed') from None
        raise
    return snapshot.model
