"""Install exact replacement BF16 matrices on a fresh Qwen3-8B base."""
from __future__ import annotations

from ..alphaedit import verify_alphaedit_artifact
from ..wire import canonical_json
from .artifacts import Check, artifact_root, require, sealed_manifest, tensors
from .qwen3 import Qwen3Snapshot


def load_alphaedit(snapshot: Qwen3Snapshot, directory, *, expected_content_hash: str,
                   maximum_bytes: int = 17_179_869_184, check: Check = lambda: None):
    """Validate the complete export, then copy replacement matrices once.

    patch.safetensors contains final BF16 down_proj weights, NOT additive deltas.
    The state-N files remain verified continuation metadata; inference does not
    compute covariance/projectors or load an optimizer. A second install on the
    edited base fails the original base-weights identity check.
    """
    from pathlib import Path
    root = Path(directory)
    manifest = verify_alphaedit_artifact(sealed_manifest(root, expected_content_hash))
    require(manifest['representation'] == 'exact_replacement_bf16_down_proj_matrices_v1'
            and canonical_json(manifest['pins']['baseModel']) == canonical_json(snapshot.identity), 'alphaedit_base_identity')
    payloads = manifest['payloads']
    root = artifact_root(root, {'manifest.json', 'patch.safetensors',
        *(row['path'] for row in payloads['state'])}, maximum_bytes)
    snapshot.verify(check)
    # Verify even the unused continuation tensors, streaming their F32 values.
    for descriptor in payloads['state']:
        tensors(root / descriptor['path'], descriptor, check=check, retain=False)
    patch = tensors(root / 'patch.safetensors', payloads['patch'], check=check)
    import torch
    # Stage every device copy before mutating the model. A failed read, finite
    # check or allocation cannot leave a partially installed replacement set.
    replacements = []
    for layer in manifest['config']['layers']:
        target = snapshot.model.model.layers[layer].mlp.down_proj.weight
        replacement = patch[f'layers.{layer}.mlp.down_proj.weight']
        require(replacement.dtype == target.dtype == torch.bfloat16
                and tuple(replacement.shape) == tuple(target.shape) == (4096, 12288), 'alphaedit_replacement_geometry')
        replacements.append((target, replacement.to(target.device)))
    originals = [(target, target.detach().clone()) for target, _ in replacements]
    with torch.no_grad():
        try:
            for target, replacement in replacements:
                target.copy_(replacement)
            for device in {target.device for target, _ in replacements if target.device.type == 'cuda'}:
                torch.cuda.synchronize(device)
        except BaseException:
            try:
                for target, original in originals:
                    target.copy_(original)
                for device in {target.device for target, _ in originals if target.device.type == 'cuda'}:
                    torch.cuda.synchronize(device)
            except BaseException as rollback_error:
                snapshot._poisoned = True
                raise RuntimeError('AlphaEdit device failure prevented rollback; discard this snapshot/model.') from rollback_error
            raise
    return snapshot.model
