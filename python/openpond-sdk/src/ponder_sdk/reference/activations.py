"""Serial full-context numerical reference, separate from managed serving.

No model download or provider operation is performed here. Hosts supply an
explicit loaded dense model and trusted stateless forward adapter. Packed
batching, KV/prefix caches, quantization and LoRA need separate runtime work.
"""
from __future__ import annotations
import hashlib
import math
import threading
import time
from pathlib import Path
from typing import Any, Sequence
import torch
from ..errors import ProtocolError
from ..wire import canonical_sha256
from ..neuron_steering import verify_activation_request, verify_activation_result, verify_neuron_calibration
from .dense_model import DenseReferenceModel
from .dense_hooks import calibrate, forward


class ActivationReferenceExecutor:
    def __init__(self, adapter: DenseReferenceModel, *, maximum_absolute_dose: float = 16):
        if not math.isfinite(maximum_absolute_dose) or maximum_absolute_dose <= 0:
            raise ValueError('A finite positive reference dose limit is required')
        self.adapter = adapter
        self.maximum_absolute_dose = maximum_absolute_dose

    def calibrate(self, raw: Any, *, cancelled: threading.Event | None = None) -> dict[str, Any]:
        """Measure and export an original fixed artifact, separately from runs."""
        from .calibration import calibrate_reference
        return calibrate_reference(self.adapter, raw, cancelled=cancelled)

    def run(self, raw: Any, *, calibrations: Sequence[dict[str, Any]] = (), cancelled: threading.Event | None = None) -> dict[str, Any]:
        request = verify_activation_request(raw)
        adapter = self.adapter
        if canonical_sha256(request['model']) != canonical_sha256(adapter.identity):
            raise ProtocolError('activation_reference_model_mismatch')
        for variant in request['variants']:
            if variant['profile'] is not None and any(abs(entry['dose']) > self.maximum_absolute_dose for entry in variant['profile']['entries']):
                raise ProtocolError('activation_reference_dose_limit_exceeded')
        vocabulary = adapter.tokenizer['vocabSize']
        if any(token >= vocabulary for prompt in request['prompts'] for token in prompt['tokenIds']) or any(token >= vocabulary for token in request['eosTokenIds']):
            raise ProtocolError('activation_reference_token_out_of_range')
        fixed: dict[tuple[str, int, str], dict[str, Any]] = {}
        for raw_calibration in calibrations:
            value = verify_neuron_calibration(raw_calibration, adapter.identity)
            key = (value['id'], value['revision'], value['contentHash'])
            if key in fixed:
                raise ProtocolError('activation_reference_duplicate_calibration')
            fixed[key] = value
        for variant in request['variants']:
            profile = variant['profile']
            if profile is not None and profile['normalization']['mode'] == 'fixed_residual_reference':
                ref = profile['normalization']['calibration']
                artifact = fixed.get((ref['id'], ref['revision'], ref['contentHash']))
                if artifact is None or not {entry['layer'] for entry in profile['entries']} <= {row['layer'] for row in artifact['layers']}:
                    raise ProtocolError('activation_reference_calibration_unavailable')
        started = time.monotonic()
        deadline = started + request['maximumDurationSeconds']
        def check() -> None:
            if cancelled is not None and cancelled.is_set():
                raise ProtocolError('activation_reference_cancelled')
            if time.monotonic() >= deadline:
                raise ProtocolError('activation_reference_deadline_exceeded')
        if not adapter.lock.acquire(blocking=False):
            raise ProtocolError('activation_reference_model_busy')
        records: list[dict[str, Any]] = []
        outcomes: list[dict[str, Any]] = []
        # Request validation rejects duplicate coordinates even across layer rows;
        # merge distinct neurons in repeated layer rows without losing captures.
        capture: dict[int, list[int]] = {}
        for row in request['capture']:
            capture.setdefault(row['layer'], []).extend(row['neurons'])
        try:
            with torch.inference_mode():
                adapter.verify(check)
                for prompt in request['prompts']:
                    for variant in request['variants']:
                        check()
                        began = time.monotonic()
                        ids = torch.tensor([prompt['tokenIds']], dtype=torch.long, device=adapter.device)
                        mask = torch.tensor([prompt['attentionMask']], dtype=torch.long, device=adapter.device)
                        positions = (mask.cumsum(dim=-1) - 1).clamp_min(0)
                        prompt_size = int(mask.sum().item())
                        profile = variant['profile']
                        samples: dict[int, tuple[float, int]] = {}
                        column_norms: dict[tuple[int, int], float] = {}
                        work = 0
                        if profile is not None:
                            layers = {entry['layer'] for entry in profile['entries']}
                            if profile['normalization']['mode'] == 'baseline_prompt_residual_median':
                                samples = calibrate(adapter, ids, mask, positions, layers, check)
                                work += ids.shape[1]
                            else:
                                ref = profile['normalization']['calibration']
                                samples = {row['layer']: (row['median'], row['sampleCount'])
                                           for row in fixed[(ref['id'], ref['revision'], ref['contentHash'])]['layers'] if row['layer'] in layers}
                            for entry in profile['entries']:
                                norm = float(torch.linalg.vector_norm(adapter.projections[entry['layer']].weight[:, entry['neuron']].float()).item())
                                if not math.isfinite(norm) or norm <= 0:
                                    raise ProtocolError('activation_reference_column_norm_invalid')
                                column_norms[(entry['layer'], entry['neuron'])] = norm
                        generated: list[int] = []
                        initial_count = len(records)
                        stopped = False
                        for step in range(request['maxNewTokens'] + 1):
                            check()
                            visible = mask[0].nonzero(as_tuple=True)[0].tolist() if step == 0 else [ids.shape[1] - 1]
                            values = forward(adapter, ids=ids, mask=mask, positions=positions, profile=profile,
                                             scales=samples, norms=column_norms, capture=capture, record_positions=visible,
                                             prompt_size=prompt_size, prompt_id=prompt['id'], variant_id=variant['id'], records=records,
                                             maximum_records=request['maximumCapturedValues'] // 2, check=check)
                            work += ids.shape[1]
                            if stopped or step == request['maxNewTokens']:
                                break
                            token = int(values[0, -1].argmax().item())
                            generated.append(token)
                            stopped = token in request['eosTokenIds']
                            ids = torch.cat((ids, torch.tensor([[token]], dtype=torch.long, device=adapter.device)), dim=1)
                            mask = torch.cat((mask, torch.ones((1, 1), dtype=torch.long, device=adapter.device)), dim=1)
                            positions = (mask.cumsum(dim=-1) - 1).clamp_min(0)
                        outcomes.append({'promptId': prompt['id'], 'variantId': variant['id'],
                                         'profileHash': profile['contentHash'] if profile is not None else None,
                                         'generatedTokenIds': generated, 'forwardTokenWork': work,
                                         'calibration': [{'layer': layer, 'median': sample[0], 'sampleCount': sample[1],
                                                          'columnNorms': [{'neuron': neuron, 'norm': norm}
                                                                          for (target, neuron), norm in sorted(column_norms.items()) if target == layer]}
                                                         for layer, sample in sorted(samples.items())],
                                         'durationMs': (time.monotonic() - began) * 1000, 'captureCount': len(records) - initial_count})
                adapter.verify(check)
                check()
            files = [Path(__file__), Path(__file__).with_name('dense_model.py'), Path(__file__).with_name('dense_hooks.py')]
            implementation_hash = hashlib.sha256(b''.join(file.read_bytes() for file in files)).hexdigest()
            content = {'schemaVersion': 'openpond.activationReferenceResult.v1', 'requestHash': canonical_sha256(request),
                       'modelHash': canonical_sha256(adapter.identity), 'runtime': {'implementation': 'torch_dense_serial_reference_v1',
                       'implementationHash': implementation_hash, 'torchVersion': str(torch.__version__), 'device': str(adapter.device)},
                       'outcomes': outcomes, 'captures': records}
            return verify_activation_result({**content, 'contentHash': canonical_sha256(content)}, request)
        finally:
            adapter.lock.release()
