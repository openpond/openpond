"""Explicit trusted adapter for the serial dense-decoder numerical reference."""
from __future__ import annotations
import hashlib
import threading
import weakref
from typing import Any, Callable, Sequence
import torch
from torch import nn
from ..errors import ProtocolError
from ..wire import canonical_json, canonical_sha256, validate

_locks: weakref.WeakKeyDictionary[nn.Module, threading.Lock] = weakref.WeakKeyDictionary()
_registry_lock = threading.Lock()


def tensor_state_hash(model: nn.Module, check: Callable[[], None] | None = None) -> str:
    """Hash sorted state names, dtype/shape headers and contiguous raw bytes.

    Each header and tensor has an unsigned eight-byte big-endian length prefix.
    The format is distinct from checkpoint-file and registry artifact hashes.
    """
    digest = hashlib.sha256(b'openpond.torchStateDict.v1\0')
    for name, tensor in sorted(model.state_dict().items()):
        if check is not None:
            check()
        if not isinstance(tensor, torch.Tensor) or tensor.is_sparse or tensor.is_quantized:
            raise ProtocolError('activation_reference_state_unsupported')
        header = canonical_json({'name': name, 'shape': list(tensor.shape), 'dtype': str(tensor.dtype)}).encode()
        data = tensor.detach().cpu().contiguous().reshape(-1).view(torch.uint8).numpy().tobytes()
        digest.update(len(header).to_bytes(8, 'big')); digest.update(header)
        digest.update(len(data).to_bytes(8, 'big')); digest.update(data)
    return digest.hexdigest()


class DenseReferenceModel:
    """Host-owned model and explicit layer/projection mapping; never profile code.

    forward returns [1, sequence, vocabulary] logits without retained KV state.
    Models must be used exclusively through this reference while a run holds its
    lock. This adapter does not qualify a packed-batch production engine.
    """
    def __init__(self, model: nn.Module, *, identity: dict[str, Any], config: dict[str, Any], tokenizer: dict[str, Any],
                 layers: Sequence[nn.Module], down_projections: Sequence[nn.Linear],
                 forward: Callable[[torch.Tensor, torch.Tensor, torch.Tensor], torch.Tensor]):
        self.model = model
        self.identity = validate('NeuronSteeringModelSchema', identity)
        self.layers = tuple(layers); self.projections = tuple(down_projections); self.forward = forward
        self.config = config; self.tokenizer = tokenizer
        if (canonical_sha256(config) != identity['configHash'] or canonical_sha256(tokenizer) != identity['tokenizerHash']
                or len(self.layers) != len(identity['intermediateSizes']) or len(self.projections) != len(self.layers)
                or len({id(layer) for layer in self.layers}) != len(self.layers)
                or len({id(layer) for layer in self.projections}) != len(self.projections)
                or type(tokenizer.get('vocabSize')) is not int or tokenizer['vocabSize'] <= 0):
            raise ProtocolError('activation_reference_model_identity_invalid')
        modules = {id(module) for module in model.modules()}
        expected_dtype = {'float32': torch.float32, 'float16': torch.float16, 'bfloat16': torch.bfloat16}[identity['dtype']]
        devices = set()
        for index, projection in enumerate(self.projections):
            if (type(projection) is not nn.Linear or id(projection) not in modules or id(self.layers[index]) not in modules
                    or projection.weight.dtype != expected_dtype or projection.in_features != identity['intermediateSizes'][index]
                    or projection.out_features != identity['hiddenSize']):
                raise ProtocolError('activation_reference_projection_unsupported')
            devices.add(projection.weight.device)
        if len(devices) != 1:
            raise ProtocolError('activation_reference_sharding_unsupported')
        self.device = next(iter(devices))
        with _registry_lock:
            self.lock = _locks.setdefault(model, threading.Lock())

    def verify(self, check: Callable[[], None]) -> None:
        if any(module.training for module in self.model.modules()):
            raise ProtocolError('activation_reference_requires_eval_mode')
        if (canonical_sha256(self.config) != self.identity['configHash'] or canonical_sha256(self.tokenizer) != self.identity['tokenizerHash']
                or tensor_state_hash(self.model, check) != self.identity['weightsHash']):
            raise ProtocolError('activation_reference_weights_changed')
