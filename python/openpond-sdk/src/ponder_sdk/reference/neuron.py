"""Load selected-column F32 deltas; no selector, gradients or training state."""
from __future__ import annotations

from ..neuron_training import neuron_training_tensor_inventory, verify_neuron_training_artifact
from ..wire import canonical_json, canonical_sha256, validate
from .artifacts import Check, artifact_root, require, sealed_manifest, tensors
from .qwen3 import Qwen3Snapshot, base_identity


def load_neuron_patch(snapshot: Qwen3Snapshot, directory, *, expected_content_hash: str,
                      maximum_bytes: int = 268_435_456, request=None, check: Check = lambda: None):
    """Attach a validated inference patch to its exact frozen, unedited base.

    The optional original training request additionally checks training provenance;
    it is not needed to consume the sealed coordinate/delta export for inference.
    Use patch.request(enabled=True/False) around every model call, then detach().
    """
    root = artifact_root(directory, {'manifest.json', 'patch.safetensors'}, maximum_bytes)
    manifest = validate('NeuronTrainingArtifactSchema', sealed_manifest(root, expected_content_hash))
    pins, selection, payload = manifest['pins'], manifest['selection'], manifest['payload']
    base_identity(pins['baseModel'])
    require(canonical_json(pins['baseModel']) == canonical_json(snapshot.identity)
            and pins['dataHash'] == canonical_sha256(pins['data'])
            and selection['contentHash'] == canonical_sha256({k: v for k, v in selection.items() if k != 'contentHash'})
            and selection['modelHash'] == canonical_sha256(snapshot.identity)
            and selection['dataHash'] == pins['dataHash'] and selection['selectionConfigHash'] == pins['selectionConfigHash'], 'neuron_artifact_pins')
    if request is not None:
        verify_neuron_training_artifact(manifest, request, pins['runtimeHash'])
    coordinates = [(row['layer'], row['neuron']) for row in selection['entries']]
    require(len(set(coordinates)) == len(coordinates) and all(0 <= layer < 36 and 0 <= neuron < 12288 for layer, neuron in coordinates)
            and payload['tensors'] == neuron_training_tensor_inventory(selection), 'neuron_coordinate_inventory')
    snapshot.verify(check)
    values = tensors(root / 'patch.safetensors', payload, check=check,
                     metadata={'format': 'openpond-neuron-columns-v1'}, maximum_header=65_536)
    state = {}
    for layer in sorted({layer for layer, _ in coordinates}):
        indices, delta = values[f'layer{layer}.indices'], values[f'layer{layer}.delta']
        require(indices.tolist() == sorted(neuron for target, neuron in coordinates if target == layer), 'neuron_payload_coordinates')
        state[layer] = (indices, delta)
    from ._neuron_torch import FrozenColumnPatch
    patch = FrozenColumnPatch(snapshot.model, state,
        projections=[layer.mlp.down_proj for layer in snapshot.model.model.layers])
    patch.manifest = manifest
    return patch
