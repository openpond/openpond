"""Request-owned selected-column inference hooks; imported by load_neuron_patch."""
from contextlib import contextmanager
import threading

import torch

from .artifacts import execution_owner, require


class FrozenColumnPatch:
    def __init__(self, model, state, *, projections):
        self._owner = threading.Lock()
        self._active = False
        self._enabled = False
        self._context_owner = None
        self._handles = []
        self._model = model
        try:
            self._handles.append(model.register_forward_pre_hook(self._guard))
            for layer, (indices, delta) in sorted(state.items()):
                projection = projections[layer]
                require(indices.dtype == torch.int64 and indices.ndim == 1 and indices.numel() > 0
                        and indices.tolist() == sorted(set(indices.tolist())) and int(indices.min()) >= 0
                        and int(indices.max()) < projection.in_features and delta.dtype == torch.float32
                        and tuple(delta.shape) == (projection.out_features, len(indices))
                        and bool(torch.isfinite(delta).all()), 'neuron_tensor_geometry')
                idx, learned = indices.to(projection.weight.device), delta.to(projection.weight.device)
                def hook(_module, args, output, idx=idx, learned=learned):
                    require(self._active and self._context_owner == execution_owner(), 'neuron_request_required')
                    if not self._enabled:
                        return output
                    with torch.inference_mode():
                        result = output + args[0].index_select(-1, idx) @ learned.t().to(output.dtype)
                    require(bool(torch.isfinite(result).all()), 'neuron_output_nonfinite')
                    return result
                self._handles.append(projection.register_forward_hook(hook))
        except BaseException:
            for handle in self._handles:
                handle.remove()
            self._handles = []
            raise

    def _guard(self, _module, _args):
        require(self._active and self._context_owner == execution_owner(), 'neuron_request_required')

    @contextmanager
    def request(self, *, enabled=True):
        require(type(enabled) is bool and self._handles and self._owner.acquire(blocking=False), 'neuron_concurrency')
        try:
            self._active, self._enabled = True, enabled
            self._context_owner = execution_owner()
            yield
            require(self._context_owner == execution_owner(), 'neuron_request_owner_changed')
        finally:
            self._active = self._enabled = False
            self._context_owner = None
            self._owner.release()

    def detach(self):
        require(not self._active and not self._owner.locked(), 'neuron_busy')
        for handle in self._handles:
            handle.remove()
        self._handles = []
