"""Manual CPU numerical/lifecycle boundary; outside routine SDK test discovery.

Protects additive sign/column placement, padding/absolute-token semantics,
zero-dose parity and cleanup when a real model forward is interrupted.
"""
import copy
import math
from pathlib import Path
from runpy import run_path
import threading
import pytest
import torch
from ponder_sdk.errors import ProtocolError
from ponder_sdk.wire import canonical_sha256
from ponder_sdk.reference.activations import ActivationReferenceExecutor
from ponder_sdk.reference.dense_model import tensor_state_hash
from ponder_sdk.activation_forms import ActivationFormTokenizer, compile_activation_form
from ponder_sdk.neuron_steering import verify_activation_result

make_example = run_path(str(Path(__file__).parents[1] / 'examples/activation_reference.py'))['make_example']
make_form_example = run_path(str(Path(__file__).parents[1] / 'examples/activation_reference.py'))['make_form_example']


def test_signed_zero_padding_and_decode_with_exact_tensor_state():
    torch.set_num_threads(1)
    adapter, request = make_example()
    original = tensor_state_hash(adapter.model)
    result = ActivationReferenceExecutor(adapter).run(request)
    outcomes = {(row['promptId'], row['variantId']): row for row in result['outcomes']}
    def values(prompt, variant, layer=0):
        return {(row['tokenIndex'], row['neuron']): (row['before'], row['after']) for row in result['captures']
                if row['promptId'] == prompt and row['variantId'] == variant and row['layer'] == layer}
    for prompt in ('plain', 'left-padded'):
        assert outcomes[(prompt, 'off')]['generatedTokenIds'] == outcomes[(prompt, 'zero')]['generatedTokenIds']
        assert values(prompt, 'off') == values(prompt, 'zero')
        for variant, sign in (('positive', 1), ('negative', -1)):
            row = outcomes[(prompt, variant)]
            median = row['calibration'][0]['median']
            column = adapter.projections[0].weight[:, 1].detach().double()
            expected = sign * median * column / math.sqrt(sum(float(item) ** 2 for item in column))
            current = values(prompt, variant)
            # Reconstruct the whole down-projection input for an actual token;
            # independently check the resulting residual contribution direction.
            before = torch.tensor([current[(1, neuron)][0] for neuron in range(6)])
            after = torch.tensor([current[(1, neuron)][1] for neuron in range(6)])
            observed = adapter.projections[0](after) - adapter.projections[0](before)
            torch.testing.assert_close(observed.double(), expected, rtol=1e-5, atol=1e-7)
        assert values(prompt, 'after-first')[(0, 1)][0] == values(prompt, 'after-first')[(0, 1)][1]
        for index in range(3):
            assert values(prompt, 'decode-only')[(index, 1)][0] == values(prompt, 'decode-only')[(index, 1)][1]
        for index in (3, 4):
            before, after = values(prompt, 'decode-only')[(index, 1)]
            assert after > before
    for variant in ('zero', 'positive', 'negative', 'after-first', 'decode-only'):
        assert outcomes[('plain', variant)]['calibration'] == outcomes[('left-padded', variant)]['calibration']
        assert values('plain', variant) == values('left-padded', variant)
    combined = {row['layer']: row for row in outcomes[('plain', 'combined')]['calibration']}
    assert combined[1] == outcomes[('plain', 'layer-one')]['calibration'][0]
    assert tensor_state_hash(adapter.model) == original
    assert all(not module._forward_pre_hooks and not module._forward_hooks for module in adapter.model.modules())
    baseline = copy.deepcopy(request); baseline['variants'] = [request['variants'][0]]
    again = ActivationReferenceExecutor(adapter).run(baseline)
    assert again['outcomes'][0]['generatedTokenIds'] == outcomes[('plain', 'off')]['generatedTokenIds']
    # A saved/reloaded fixed reference must reproduce the same normalized
    # intervention without charging/performing another calibration forward.
    scale = outcomes[('plain', 'positive')]['calibration'][0]
    body = {'schemaVersion': 'openpond.neuronResidualCalibration.v1', 'id': 'calibration-demo', 'revision': 1,
            'modelHash': canonical_sha256(request['model']), 'source': {'id': 'prompt-demo', 'contentHash': canonical_sha256(request['prompts'][0])},
            'statistic': 'midpoint_median_fp32', 'sample': 'non_padding_prompt_after_position_zero',
            'layers': [{'layer': 0, 'median': scale['median'], 'sampleCount': scale['sampleCount']}]}
    artifact = {**body, 'contentHash': canonical_sha256(body)}
    fixed = copy.deepcopy(request); fixed['variants'] = [copy.deepcopy(request['variants'][2])]
    profile = fixed['variants'][0]['profile']
    profile['normalization'] = {'mode': 'fixed_residual_reference', 'calibration': {key: artifact[key] for key in ('id', 'revision', 'contentHash')}}
    profile['contentHash'] = canonical_sha256({key: value for key, value in profile.items() if key != 'contentHash'})
    fixed_result = ActivationReferenceExecutor(adapter).run(fixed, calibrations=[copy.deepcopy(artifact)])
    assert [(row['before'], row['after']) for row in fixed_result['captures']] == [(row['before'], row['after']) for row in result['captures'] if row['variantId'] == 'positive']
    assert fixed_result['outcomes'][0]['forwardTokenWork'] == outcomes[('plain', 'positive')]['forwardTokenWork'] - len(request['prompts'][0]['tokenIds'])
    # A rehashed duplicate coordinate is invalid before model execution.
    invalid = copy.deepcopy(request)
    profile = invalid['variants'][1]['profile']; profile['entries'].append(copy.deepcopy(profile['entries'][0]))
    profile['contentHash'] = canonical_sha256({key: value for key, value in profile.items() if key != 'contentHash'})
    with pytest.raises(ProtocolError):
        ActivationReferenceExecutor(adapter).run(invalid)


def test_interruption_releases_hooks_and_model_ownership():
    adapter, request = make_example()
    stopped = threading.Event()
    actual = adapter.forward
    def cancel_after_forward(*args):
        value = actual(*args)
        stopped.set()
        return value
    adapter.forward = cancel_after_forward
    with pytest.raises(ProtocolError) as error:
        ActivationReferenceExecutor(adapter).run(request, cancelled=stopped)
    assert error.value.code == 'activation_reference_cancelled'
    assert not adapter.lock.locked()
    assert all(not module._forward_pre_hooks and not module._forward_hooks for module in adapter.model.modules())
    adapter.forward = actual
    assert ActivationReferenceExecutor(adapter).run(request)['outcomes']


def test_text_authoring_compiles_exact_source_and_executes_complete_bounded_capture():
    """A form must not drift to another tokenizer, truncate text, weaken work
    limits or change intervention scope while becoming an executable request."""
    torch.set_num_threads(1)
    adapter, form, tokenizer, request = make_form_example()
    original = copy.deepcopy(form)
    executor = ActivationReferenceExecutor(adapter)
    result = executor.run(request)
    assert verify_activation_result(result, request) == result
    assert form == original
    assert request['prompts'][0]['tokenIds'] == [1, 2, 3]
    assert request['capture'] == [{'layer': 0, 'neurons': [1]}, {'layer': 1, 'neurons': [2]}]
    assert all(row['profile']['normalization'] == form['normalization'] and row['profile']['tokenScope'] == form['tokenScope']
               for row in request['variants'][1:])
    def captures(document, prompt, variant):
        return {(row['tokenIndex'], row['layer'], row['neuron']): (row['before'], row['after'])
                for row in document['captures'] if row['promptId'] == prompt and row['variantId'] == variant}
    for prompt in ('forward', 'reverse'):
        assert captures(result, prompt, 'baseline') == captures(result, prompt, 'strength-2')
        for index in range(3):
            assert all(before == after for (token, _, _), (before, after) in captures(result, prompt, 'strength-3').items() if token == index)
        for variant, sign in (('strength-1', -1), ('strength-3', 1)):
            before, after = captures(result, prompt, variant)[(3, 0, 1)]
            assert sign * (after - before) > 0
    # Reuse exact immutable calibration artifacts with the same authored scope.
    outcome = next(row for row in result['outcomes'] if row['promptId'] == 'forward' and row['variantId'] == 'strength-3')
    body = {'schemaVersion': 'openpond.neuronResidualCalibration.v1', 'id': 'compiled-calibration', 'revision': 1,
            'modelHash': canonical_sha256(adapter.identity),
            'source': {'id': 'forward', 'contentHash': canonical_sha256(request['prompts'][0])},
            'statistic': 'midpoint_median_fp32', 'sample': 'non_padding_prompt_after_position_zero',
            'layers': [{key: row[key] for key in ('layer', 'median', 'sampleCount')} for row in outcome['calibration']]}
    calibration = {**body, 'contentHash': canonical_sha256(body)}
    fixed = copy.deepcopy(form); fixed['prompts'] = [fixed['prompts'][0]]; fixed['doseMultipliers'] = '1'
    fixed['normalization'] = {'mode': 'fixed_residual_reference', 'calibration': {key: calibration[key] for key in ('id', 'revision', 'contentHash')}}
    compiled = compile_activation_form(fixed, method='neuron_steering', model=adapter.identity, tokenizer=tokenizer, calibrations=[calibration])
    fixed_result = executor.run(compiled, calibrations=[calibration])
    assert captures(fixed_result, 'forward', 'strength-1') == captures(result, 'forward', 'strength-3')
    with pytest.raises(ProtocolError):
        compile_activation_form(fixed, method='neuron_steering', model=adapter.identity, tokenizer=tokenizer)
    # Inspection uses text and coordinates even if its hidden steering controls
    # contain unfinished values or a calibration that has not been loaded.
    inspection = copy.deepcopy(fixed)
    inspection['coordinates'][0]['dose'] = '-'; inspection['doseMultipliers'] = ''
    inspected = compile_activation_form(inspection, method='inspect_activations', model=adapter.identity, tokenizer=tokenizer)
    inspection_result = executor.run(inspected)
    assert len(inspected['variants']) == 1 and inspected['variants'][0]['profile'] is None
    assert all(row['before'] == row['after'] for row in inspection_result['captures'])
    for field, value in (('maximumCapturedValues', '1'), ('maximumForwardTokenWork', '1'), ('maxNewTokens', '')):
        bounded = copy.deepcopy(form); bounded[field] = value
        with pytest.raises(ProtocolError):
            compile_activation_form(bounded, method='neuron_steering', model=adapter.identity, tokenizer=tokenizer)
    underflow = copy.deepcopy(form); underflow['coordinates'][0]['dose'] = '1e-200'; underflow['doseMultipliers'] = '1e-200'
    with pytest.raises(ProtocolError):
        compile_activation_form(underflow, method='neuron_steering', model=adapter.identity, tokenizer=tokenizer)
    mismatched = copy.deepcopy(form); mismatched['baseModel']['tokenizerRevision'] = 'another-tokenizer'
    with pytest.raises(ProtocolError):
        compile_activation_form(mismatched, method='neuron_steering', model=adapter.identity, tokenizer=tokenizer)
    wrong_descriptor = ActivationFormTokenizer(source=tokenizer.source, descriptor={**tokenizer.descriptor, 'padding': True}, encode=tokenizer.encode)
    with pytest.raises(ProtocolError):
        compile_activation_form(form, method='neuron_steering', model=adapter.identity, tokenizer=wrong_descriptor)
    truncated = ActivationFormTokenizer(source=tokenizer.source, descriptor=tokenizer.descriptor, encode=lambda _text: [1] * 4097)
    with pytest.raises(ProtocolError):
        compile_activation_form(form, method='neuron_steering', model=adapter.identity, tokenizer=truncated)
    unsupported = copy.deepcopy(form); unsupported['tokenScope']['phase'] = 'cached_decode'
    with pytest.raises(ProtocolError):
        compile_activation_form(unsupported, method='neuron_steering', model=adapter.identity, tokenizer=tokenizer)
    assert tensor_state_hash(adapter.model) == adapter.identity['weightsHash']
    assert all(not module._forward_pre_hooks and not module._forward_hooks for module in adapter.model.modules())


def test_downloaded_tensor_patch_owns_real_forward_and_refuses_corruption(tmp_path):
    """Actual safetensors, model forwards and hook cleanup; no full-base claim."""
    from safetensors.torch import save_file
    from ponder_sdk.reference.artifacts import artifact_root, file_hash, sealed_manifest, tensors
    from ponder_sdk.reference._neuron_torch import FrozenColumnPatch
    adapter, _ = make_example()
    model = adapter.model
    model.requires_grad_(False)
    original_hash = tensor_state_hash(model)
    ids = torch.tensor([[1, 2, 3]])
    mask, positions = torch.ones_like(ids), torch.arange(3).unsqueeze(0)
    baseline = model(ids, mask, positions)
    path = tmp_path / 'patch.safetensors'
    delta = torch.tensor([[0.2], [-0.1], [0.3], [0.0]], dtype=torch.float32)
    indices = torch.tensor([1], dtype=torch.int64)
    save_file({'layer0.indices': indices, 'layer0.delta': delta}, str(path), metadata={'format': 'openpond-neuron-columns-v1'})
    payload = {'path': path.name, 'sha256': file_hash(path), 'sizeBytes': path.stat().st_size,
        'tensors': [{'name': 'layer0.indices', 'shape': [1], 'dtype': 'I64'},
                    {'name': 'layer0.delta', 'shape': [4, 1], 'dtype': 'F32'}]}
    # A small projection exercises the same frozen delta arithmetic; the public
    # Qwen loader below separately refuses this deliberately unsupported model.
    content = {'schemaVersion': 'projection-boundary-fixture.v1', 'payload': payload}
    manifest = {**content, 'contentHash': canonical_sha256(content)}
    (tmp_path / 'manifest.json').write_bytes(__import__('ponder_sdk').canonical_json(manifest).encode())
    root = artifact_root(tmp_path, {'manifest.json', path.name}, 65536)
    assert sealed_manifest(root, manifest['contentHash']) == manifest
    loaded = tensors(path, payload, metadata={'format': 'openpond-neuron-columns-v1'})
    patch = FrozenColumnPatch(model, {0: (loaded['layer0.indices'], loaded['layer0.delta'])}, projections=adapter.projections)
    try:
        with pytest.raises(ProtocolError):
            model(ids, mask, positions)
        with patch.request(enabled=False):
            torch.testing.assert_close(model(ids, mask, positions), baseline, rtol=0, atol=0)
        import asyncio
        async def same_thread_foreign_task():
            with patch.request():
                assert not torch.is_inference_mode_enabled()
                async def foreign():
                    assert not torch.is_inference_mode_enabled()
                    with pytest.raises(ProtocolError, match='request_required'):
                        model(ids, mask, positions)
                await asyncio.create_task(foreign())
                assert not torch.equal(model(ids, mask, positions), baseline)
        asyncio.run(same_thread_foreign_task())
        with patch.request():
            changed = model(ids, mask, positions)
            assert not torch.equal(changed, baseline)
            failures = []
            def wrong_thread():
                try:
                    model(ids, mask, positions)
                except ProtocolError:
                    failures.append(True)
            thread = threading.Thread(target=wrong_thread)
            thread.start(); thread.join(timeout=5)
            assert not thread.is_alive() and failures == [True]
        with pytest.raises(RuntimeError):
            with patch.request():
                raise RuntimeError('interrupted local caller')
        with patch.request(enabled=False):
            torch.testing.assert_close(model(ids, mask, positions), baseline, rtol=0, atol=0)
    finally:
        patch.detach()
    assert tensor_state_hash(model) == original_hash
    assert all(not module._forward_hooks and not module._forward_pre_hooks for module in model.modules())
    raw = bytearray(path.read_bytes()); raw[-1] ^= 1; path.write_bytes(raw)
    with pytest.raises(ProtocolError, match='payload_hash'):
        tensors(path, payload)
    # Even a re-sealed digest cannot bless nonfinite numerical tensor contents.
    save_file({'layer0.indices': indices, 'layer0.delta': torch.full_like(delta, float('nan'))}, str(path),
              metadata={'format': 'openpond-neuron-columns-v1'})
    payload.update(sha256=file_hash(path), sizeBytes=path.stat().st_size)
    with pytest.raises(ProtocolError, match='tensor_nonfinite'):
        tensors(path, payload)
    from ponder_sdk.reference.qwen3 import Qwen3Snapshot
    with pytest.raises(ProtocolError):
        Qwen3Snapshot(model, None, adapter.identity, adapter.config, adapter.tokenizer).verify()


def test_engram_fixed_projection_and_request_history_are_inference_only():
    """One exact-width projection and prefix/cache custody, not native 8B proof."""
    from ponder_sdk.reference._engram_torch import LayerMemory
    from ponder_sdk.reference.engram_history import RequestHistory
    torch.set_num_threads(1)
    projection = torch.zeros((4096, 3072), dtype=torch.float32)
    projection[0, 0] = 2
    gate_memory, gate_hidden = torch.zeros(3072), torch.zeros(4096)
    gate_memory[0], gate_hidden[0] = 0.1, 0.25
    layer = LayerMemory({'layers.1.projection.weight': projection, 'layers.1.gate_memory': gate_memory,
                         'layers.1.gate_hidden': gate_hidden}, 1, 'cpu')
    hidden, chunks = torch.zeros((1, 1, 4096)), torch.zeros((1, 1, 3072))
    hidden[..., 0], chunks[..., 0] = 0.5, 0.75
    with torch.inference_mode():
        changed = layer(hidden, chunks, 0.2)
    expected = 0.5 + 0.2 * 1.5 / (1 + math.exp(-(0.075 + 0.5 * 0.25 * 1.5 / 64)))
    assert float(changed[0, 0, 0]) == pytest.approx(expected, abs=1e-7)
    assert torch.equal(changed[..., 1:], hidden[..., 1:]) and not list(layer.parameters())
    owner = object()
    history = RequestHistory('request-a')
    history.bind_adapter(owner, enabled=True)
    first = history.prepare(request_id='request-a', token_ids=[1, 2, 3], attention_mask=[1, 1, 1], positions=[0, 1, 2])
    assert first.valid['suffix2'] == (False, True, True)
    assert first.valid['previous3'] == (False, False, False)
    history.commit(first)
    decode = history.prepare(request_id='request-a', token_ids=[4], attention_mask=[1], positions=[3])
    recomputed = history.prepare(request_id='request-a', token_ids=[1, 2, 3, 4], attention_mask=[1]*4, positions=[0, 1, 2, 3])
    assert all(decode.indices[group][0] == recomputed.indices[group][-1] for group in decode.indices)
    with pytest.raises(ProtocolError):
        history.bind_adapter(object(), enabled=True)
    with pytest.raises(ProtocolError):
        history.bind_adapter(owner, enabled=False)
    with pytest.raises(ProtocolError):
        history.prepare(request_id='request-b', token_ids=[4], attention_mask=[1], positions=[3])
    with pytest.raises(ProtocolError):
        history.prepare(request_id='request-a', token_ids=[9], attention_mask=[1], positions=[1])
    class Cache:
        def get_seq_length(self): return 3
    cache = Cache()
    history.commit_cache(cache, 3)
    history.verify_cache_input(cache, 3)
    with pytest.raises(ProtocolError):
        history.verify_cache_input(Cache(), 3)
    history.release()
    with pytest.raises(ProtocolError):
        history.prepare(request_id='request-a', token_ids=[1], attention_mask=[1], positions=[0])
