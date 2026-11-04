"""Original fixed-calibration production under exclusive dense-model custody.

The export retains the measured tokenized source and original sealed artifact.
It does not import or reconstruct numerical scales from run outcome evidence.
"""
from __future__ import annotations
import hashlib
import threading
import time
from pathlib import Path
from typing import Any
import torch
from ..errors import ProtocolError
from ..neuron_steering import verify_neuron_calibration
from ..neuron_calibration_identity import verify_calibration_export, verify_calibration_request
from ..wire import canonical_sha256
from .dense_model import DenseReferenceModel
from .dense_hooks import calibrate as measure_calibration


def calibrate_reference(adapter: DenseReferenceModel, raw: Any, *, cancelled: threading.Event | None = None) -> dict[str, Any]:
    request = verify_calibration_request(raw)
    prompt, layers = request['prompt'], request['layers']
    if (canonical_sha256(request['model']) != canonical_sha256(adapter.identity)
            or len(set(layers)) != len(layers) or any(layer >= len(adapter.layers) for layer in layers)
            or len(prompt['tokenIds']) != len(prompt['attentionMask'])
            or sum(prompt['attentionMask']) < 2 or prompt['attentionMask'][-1] != 1
            or prompt['attentionMask'] != sorted(prompt['attentionMask'])
            or len(prompt['tokenIds']) > request['maximumForwardTokenWork']
            or any(token >= adapter.tokenizer['vocabSize'] for token in prompt['tokenIds'])):
        raise ProtocolError('neuron_calibration_request_mismatch')
    deadline = time.monotonic() + request['maximumDurationSeconds']
    def check() -> None:
        if cancelled is not None and cancelled.is_set():
            raise ProtocolError('activation_reference_cancelled')
        if time.monotonic() >= deadline:
            raise ProtocolError('activation_reference_deadline_exceeded')
    check()
    if not adapter.lock.acquire(blocking=False):
        raise ProtocolError('activation_reference_model_busy')
    try:
        with torch.inference_mode():
            adapter.verify(check)
            check()
            ids = torch.tensor([prompt['tokenIds']], dtype=torch.long, device=adapter.device)
            mask = torch.tensor([prompt['attentionMask']], dtype=torch.long, device=adapter.device)
            positions = (mask.cumsum(dim=-1) - 1).clamp_min(0)
            measured = measure_calibration(adapter, ids, mask, positions, set(layers), check)
            adapter.verify(check)
            check()
        content = {'schemaVersion': 'openpond.neuronResidualCalibration.v1', 'id': request['id'],
                   'revision': request['revision'], 'modelHash': canonical_sha256(adapter.identity),
                   'source': {'id': prompt['id'], 'contentHash': canonical_sha256(prompt)},
                   'statistic': 'midpoint_median_fp32', 'sample': 'non_padding_prompt_after_position_zero',
                   'layers': [{'layer': layer, 'median': value[0], 'sampleCount': value[1]}
                              for layer, value in sorted(measured.items())]}
        artifact = verify_neuron_calibration({**content, 'contentHash': canonical_sha256(content)}, adapter.identity)
        files = [Path(__file__), Path(__file__).with_name('dense_model.py'), Path(__file__).with_name('dense_hooks.py')]
        implementation_hash = hashlib.sha256(b''.join(file.read_bytes() for file in files)).hexdigest()
        export = {'schemaVersion': 'openpond.neuronResidualCalibrationExport.v1',
                  'model': adapter.identity, 'prompt': prompt, 'calibration': artifact,
                  'runtime': {'implementation': 'torch_dense_serial_calibration_v1', 'implementationHash': implementation_hash,
                              'torchVersion': str(torch.__version__), 'device': str(adapter.device)}}
        result = verify_calibration_export({**export, 'contentHash': canonical_sha256(export)}, request)
        check()
        return result
    finally:
        adapter.lock.release()
