"""Bounded hooks for one exclusively owned, unbatched reference forward."""
from __future__ import annotations
import math
from typing import Any, Callable
import torch
from ..errors import ProtocolError
from .dense_model import DenseReferenceModel


def logits(adapter: DenseReferenceModel, ids: torch.Tensor, mask: torch.Tensor, positions: torch.Tensor) -> torch.Tensor:
    value = adapter.forward(ids, mask, positions)
    if (not isinstance(value, torch.Tensor) or tuple(value.shape) != (1, ids.shape[1], adapter.tokenizer['vocabSize'])
            or not torch.isfinite(value).all().item()):
        raise ProtocolError('activation_reference_logits_invalid')
    return value


def calibrate(adapter: DenseReferenceModel, ids: torch.Tensor, mask: torch.Tensor, positions: torch.Tensor,
              layers: set[int], check: Callable[[], None]) -> dict[int, tuple[float, int]]:
    samples: dict[int, tuple[float, int]] = {}
    handles = []
    def observer(index: int):
        def hook(_module: Any, _args: Any, output: Any) -> None:
            check()
            hidden = output if isinstance(output, torch.Tensor) else output[0] if isinstance(output, (tuple, list)) and output else None
            if (index in samples or not isinstance(hidden, torch.Tensor)
                    or tuple(hidden.shape) != (1, ids.shape[1], adapter.identity['hiddenSize'])):
                raise ProtocolError('activation_reference_layer_output_unsupported')
            norms = torch.linalg.vector_norm(hidden.float(), dim=-1)[(mask == 1) & (positions > 0)]
            if not norms.numel() or not torch.isfinite(norms).all().item():
                raise ProtocolError('activation_reference_calibration_empty_or_invalid')
            median = float(torch.quantile(norms, 0.5, interpolation='midpoint').item())
            if not math.isfinite(median) or median <= 0:
                raise ProtocolError('activation_reference_residual_scale_invalid')
            samples[index] = (median, norms.numel())
        return hook
    try:
        for index in sorted(layers):
            handles.append(adapter.layers[index].register_forward_hook(observer(index)))
        logits(adapter, ids, mask, positions)
        if set(samples) != layers:
            raise ProtocolError('activation_reference_missing_layer_observation')
        return samples
    finally:
        for handle in reversed(handles):
            handle.remove()


def forward(adapter: DenseReferenceModel, *, ids: torch.Tensor, mask: torch.Tensor, positions: torch.Tensor,
            profile: dict[str, Any] | None, scales: dict[int, tuple[float, int]], norms: dict[tuple[int, int], float],
            capture: dict[int, list[int]], record_positions: list[int], prompt_size: int,
            prompt_id: str, variant_id: str, records: list[dict[str, Any]], maximum_records: int,
            check: Callable[[], None]) -> torch.Tensor:
    entries: dict[int, list[dict[str, Any]]] = {}
    if profile is not None:
        for entry in profile['entries']:
            entries.setdefault(entry['layer'], []).append(entry)
    seen: set[int] = set()
    handles = []
    def intervention(index: int):
        def hook(_module: Any, args: tuple[Any, ...]):
            check()
            if index in seen or len(args) != 1 or not isinstance(args[0], torch.Tensor):
                raise ProtocolError('activation_reference_projection_call_unsupported')
            seen.add(index)
            before = args[0]
            if tuple(before.shape) != (1, ids.shape[1], adapter.identity['intermediateSizes'][index]):
                raise ProtocolError('activation_reference_projection_shape_changed')
            after = before
            active = mask == 1
            if profile is not None:
                scope = profile['tokenScope']
                if scope['phase'] == 'prompt_only':
                    active = active & (positions < prompt_size)
                elif scope['phase'] == 'decode_only':
                    active = active & (positions >= prompt_size)
                if scope['positions'] == 'after_position_zero':
                    active = active & (positions > 0)
                for entry in entries.get(index, []):
                    if entry['dose'] == 0 or not active.any().item():
                        continue
                    if after is before:
                        after = before.clone()
                    neuron = entry['neuron']
                    # FP32 scale arithmetic precedes conversion to inference dtype.
                    delta = (torch.tensor(entry['dose'], dtype=torch.float32, device=before.device)
                             * torch.tensor(scales[index][0], dtype=torch.float32, device=before.device)
                             / torch.tensor(norms[(index, neuron)], dtype=torch.float32, device=before.device)).to(before.dtype)
                    if not torch.isfinite(delta).item():
                        raise ProtocolError('activation_reference_delta_nonfinite')
                    column = after[..., neuron]
                    column[active] = column[active] + delta
                    if not torch.isfinite(column[active]).all().item():
                        raise ProtocolError('activation_reference_activation_nonfinite')
            for physical in record_positions:
                for neuron in capture.get(index, []):
                    if len(records) >= maximum_records:
                        raise ProtocolError('activation_reference_capture_budget_exceeded')
                    first, last = float(before[0, physical, neuron].float().item()), float(after[0, physical, neuron].float().item())
                    if not math.isfinite(first) or not math.isfinite(last):
                        raise ProtocolError('activation_reference_capture_nonfinite')
                    records.append({'promptId': prompt_id, 'variantId': variant_id, 'layer': index, 'neuron': neuron,
                                    'tokenIndex': int(positions[0, physical].item()), 'tokenId': int(ids[0, physical].item()),
                                    'before': first, 'after': last})
            return None if after is before else (after,)
        return hook
    expected = set(entries) | set(capture)
    try:
        for index in sorted(expected):
            handles.append(adapter.projections[index].register_forward_pre_hook(intervention(index)))
        value = logits(adapter, ids, mask, positions)
        if seen != expected:
            raise ProtocolError('activation_reference_missing_projection_observation')
        return value
    finally:
        for handle in reversed(handles):
            handle.remove()
