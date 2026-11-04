"""Frozen paper-v1 arithmetic and request hooks, imported only by load_engram."""
from __future__ import annotations

from contextlib import contextmanager
import math
import threading

import torch
from torch import nn
from torch.nn import functional as F

from .artifacts import execution_owner, require
from .engram_history import GROUPS, RequestHistory


class LayerMemory(nn.Module):
    def __init__(self, state, layer, device):
        super().__init__()
        for name in ('projection.weight', 'gate_memory', 'gate_hidden'):
            self.register_buffer(name.replace('.', '_'), state[f'layers.{layer}.{name}'].to(device))

    def forward(self, hidden, chunks, alpha):
        memory = F.linear(chunks, self.projection_weight)
        logits = (chunks * self.gate_memory).sum(dim=-1)
        logits = logits + ((hidden.float() * self.gate_hidden) * memory).sum(dim=-1) / math.sqrt(hidden.shape[-1])
        output = (hidden.float() + alpha * torch.sigmoid(logits).unsqueeze(-1) * memory).to(hidden.dtype)
        require(bool(torch.isfinite(output).all()), 'engram_output_nonfinite')
        return output


class EngramModule(nn.Module):
    def __init__(self, config, state, *, device):
        super().__init__()
        self.config = config
        self.memory = nn.ModuleDict()
        self.occupancy = nn.ModuleDict()
        for group, _, _ in GROUPS:
            tables, flags = nn.Module(), nn.Module()
            for head in range(4):
                tables.register_buffer(f'h{head}', state[f'shared.embeddings.{group}.{head}.weight'].to(device))
                flags.register_buffer(f'h{head}', state[f'shared.occupancy.{group}.h{head}'].to(device))
            self.memory[group], self.occupancy[group] = tables, flags
        self.layers = nn.ModuleDict({str(layer): LayerMemory(state, layer, device) for layer in config['injectLayers']})
        self._owner = threading.Lock()
        self._active = None
        self._context_owner = None
        self._handles = []
        self._attached = None
        self.eval()

    def retrieve(self, prepared):
        device = self.memory['suffix2'].h0.device
        chunks = []
        for group, _, _ in GROUPS:
            indices = torch.tensor(prepared.indices[group], dtype=torch.long, device=device)
            valid = torch.tensor(prepared.valid[group], dtype=torch.bool, device=device)
            joint = valid & torch.stack([getattr(self.occupancy[group], f'h{head}')[indices[:, head]]
                                         for head in range(4)], dim=1).all(dim=1)
            for head in range(4):
                chunks.append(F.embedding(indices[:, head], getattr(self.memory[group], f'h{head}')) * joint.unsqueeze(-1))
        return torch.cat(chunks, dim=-1).unsqueeze(0)

    def attach(self, model):
        from transformers.models.qwen3.modeling_qwen3 import Qwen3Attention, Qwen3ForCausalLM
        require(self._attached is None and self._active is None and type(model) is Qwen3ForCausalLM, 'engram_attachment')
        require(all(type(model.model.layers[layer].self_attn) is Qwen3Attention
                    for layer in self.config['injectLayers']), 'engram_attention_type')
        try:
            self._handles.append(model.register_forward_pre_hook(self._model_pre_hook, with_kwargs=True))
            self._handles.append(model.register_forward_hook(self._model_post_hook, with_kwargs=True))
            for layer in self.config['injectLayers']:
                self._handles.append(model.model.layers[layer].self_attn.register_forward_pre_hook(self._pre_hook(layer), with_kwargs=True))
        except BaseException:
            for handle in self._handles:
                handle.remove()
            self._handles = []
            raise
        object.__setattr__(self, '_attached', model)

    def detach(self):
        require(self._active is None and not self._owner.locked(), 'engram_busy')
        for handle in self._handles:
            handle.remove()
        self._handles = []
        object.__setattr__(self, '_attached', None)

    def forward(self, input_ids, *, history: RequestHistory, enabled=True, past_key_values=None, use_cache=True):
        """One exact prefill/decode call; each generation owns a fresh history."""
        require(isinstance(input_ids, torch.Tensor) and input_ids.dtype == torch.long
                and input_ids.ndim == 2 and input_ids.shape[0] == 1 and input_ids.shape[1] > 0
                and input_ids.device == self.memory['suffix2'].h0.device
                and type(use_cache) is bool and (past_key_values is None or use_cache), 'engram_forward_input')
        first = 0 if past_key_values is None else past_key_values.get_seq_length()
        positions = list(range(first, first + input_ids.shape[1]))
        with torch.inference_mode(), self.request(request_id=history.request_id, token_ids=input_ids[0].detach().cpu().tolist(),
                          attention_mask=[1] * input_ids.shape[1], positions=positions, history=history, enabled=enabled):
            return self._attached(input_ids=input_ids,
                attention_mask=torch.ones((1, positions[-1] + 1), dtype=torch.long, device=input_ids.device),
                position_ids=torch.tensor([positions], dtype=torch.long, device=input_ids.device),
                past_key_values=past_key_values, use_cache=use_cache, return_dict=True)

    def _model_pre_hook(self, module, args, kwargs):
        active = self._active
        require(active is not None and self._context_owner == execution_owner()
                and not active['modelSeen'], 'engram_request_required')
        prepared = active['prepared']
        ids = kwargs.get('input_ids', args[0] if args else None)
        require(len(args) <= 1 and isinstance(ids, torch.Tensor) and ids.dtype == torch.long
                and tuple(ids.shape) == (1, len(prepared.token_ids))
                and ids.detach().cpu().tolist() == [list(prepared.token_ids)]
                and kwargs.get('inputs_embeds') is None and kwargs.get('return_dict') is not False, 'engram_input_context')
        for key in ('position_ids', 'cache_position'):
            positions = kwargs.get(key)
            if positions is not None:
                require(isinstance(positions, torch.Tensor) and positions.dtype == torch.long and positions.ndim in (1, 2)
                        and positions.reshape(-1).detach().cpu().tolist() == list(prepared.positions), 'engram_position_context')
        mask = kwargs.get('attention_mask')
        if mask is not None:
            require(isinstance(mask, torch.Tensor) and tuple(mask.shape) == (1, prepared.positions[-1] + 1)
                    and bool((mask == 1).all()), 'engram_attention_mask')
        active['history'].verify_cache_input(kwargs.get('past_key_values'), prepared.positions[0])
        active['modelSeen'] = True

    def _model_post_hook(self, module, args, kwargs, output):
        require(self._active is not None and self._context_owner == execution_owner()
                and hasattr(output, 'past_key_values'), 'engram_cache_result')
        self._active['cacheResult'] = output.past_key_values
        self._active['cacheObserved'] = True

    def _pre_hook(self, layer):
        def inject(module, args, kwargs):
            active = self._active
            require(active is not None and self._context_owner == execution_owner()
                    and layer not in active['seen'], 'engram_request_context')
            keyword = 'hidden_states' in kwargs
            hidden = kwargs.get('hidden_states', args[0] if args else None)
            require(isinstance(hidden, torch.Tensor) and tuple(hidden.shape) == (1, len(active['prepared'].token_ids), 4096)
                    and hidden.device == self.memory['suffix2'].h0.device, 'engram_attention_shape')
            active['seen'].add(layer)
            if not active['enabled']:
                return None
            with torch.inference_mode():
                changed = self.layers[str(layer)](hidden, active['chunks'], self.config['alpha'])
            return (args, {**kwargs, 'hidden_states': changed}) if keyword else ((changed, *args[1:]), kwargs)
        return inject

    @contextmanager
    def request(self, *, request_id, token_ids, attention_mask, positions, history: RequestHistory, enabled=True):
        require(type(enabled) is bool and self._attached is not None
                and self._owner.acquire(blocking=False), 'engram_concurrency')
        try:
            require(self._active is None, 'engram_busy')
            self._context_owner = execution_owner()
            history.bind_adapter(self, enabled=enabled)
            prepared = history.prepare(request_id=request_id, token_ids=token_ids, attention_mask=attention_mask, positions=positions)
            self._active = {'prepared': prepared, 'chunks': self.retrieve(prepared) if enabled else None,
                'enabled': enabled, 'seen': set(), 'history': history, 'modelSeen': False,
                'cacheObserved': False, 'cacheResult': None}
            try:
                yield
                require(self._context_owner == execution_owner(), 'engram_request_owner_changed')
                require(self._active['cacheObserved'] and self._active['seen'] == set(self.config['injectLayers']), 'engram_incomplete_forward')
                history.commit_cache(self._active['cacheResult'], prepared.positions[-1] + 1)
                history.commit(prepared)
            except BaseException:
                history.release()
                raise
            finally:
                self._active = None
        finally:
            self._context_owner = None
            self._owner.release()
