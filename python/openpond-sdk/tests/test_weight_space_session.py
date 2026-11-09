"""Protect atomic numerical edits, original-operation replay and exact patch reload.

These use real CPU tensors and files, not a hosted/GPU acceptance run. The small
snapshot fixture deliberately does not claim to be a qualified Qwen runtime.
"""
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import time
import pytest

torch = pytest.importorskip('torch')
pytest.importorskip('safetensors')
from ponder_sdk.reference.weight_space_tensors import tensor_hash
from ponder_sdk.reference.weight_space_session import WeightSpaceSession
from ponder_sdk.reference.weight_space_patch import load_weight_space_patch
from ponder_sdk.reference.weight_space_code import compile_tensor_code
from ponder_sdk.wire import canonical_sha256


class Snapshot:
    def __init__(self, weight=None):
        self.projection = torch.nn.Linear(4, 4096, bias=False, dtype=torch.bfloat16)
        with torch.no_grad():
            self.projection.weight.copy_(weight if weight is not None else torch.arange(16384).reshape(4096, 4).float()/16384)
        self.projection.requires_grad_(False)
        model = torch.nn.Module()
        model.model = torch.nn.Module()
        layer = torch.nn.Module()
        layer.mlp = torch.nn.Module()
        layer.mlp.down_proj = self.projection
        model.model.layers = torch.nn.ModuleList([layer])
        model.eval()
        self.model = model
        self.identity = {'schemaVersion': 'openpond.neuronSteeringModel.v1', 'modelId': 'Qwen/Qwen3-8B',
            'revision': 'b968826d9c46dd6066d109eabc6255188de91218', 'configHash': 'a'*64,
            'weightsHash': tensor_hash(self.projection.weight), 'tokenizerHash': 'c'*64,
            'weightIdentity': 'torch_state_dict_sha256_v1', 'architecture': 'dense_decoder', 'dtype': 'bfloat16',
            'quantization': 'none', 'adapter': None, 'hiddenSize': 4096, 'intermediateSizes': [12288]*36}

    def verify(self, check=lambda: None):
        check()
        assert tensor_hash(self.projection.weight) == self.identity['weightsHash']
        assert not self.projection.weight.requires_grad
        return self


def request(snapshot):
    return {'schemaVersion': 'openpond.weightSpaceRequest.v1', 'model': snapshot.identity,
        'teacher': {'controller': 'local_agent', 'providerId': 'fixture', 'modelId': 'teacher', 'sessionId': 'chat-fixture'},
        'objective': 'Test retained direct edits', 'panels': [{'id': 'practice', 'source': None, 'role': 'development',
            'prompts': [{'id': 'p1', 'text': 'A development prompt'}]}], 'frozenEvaluation': None,
        'generation': {'maxOutputTokens': 4, 'seed': 1, 'sampling': 'greedy_v1'},
        'limits': {'maximumDurationSeconds': 180, 'maximumIdleSeconds': 60, 'maximumCommands': 16,
            'maximumCandidates': 8, 'maximumPatchColumns': 8, 'maximumTensorElements': 65536,
            'maximumReturnedValues': 32, 'maximumArithmeticWork': 1000000, 'maximumForwardTokenWork': 1000,
            'maximumCheckpointBytes': 1048576}}


def test_durable_edit_replay_rejection_recovery_and_patch_reload(tmp_path):
    snapshot = Snapshot()
    original = snapshot.projection.weight.detach().clone()
    parsed = request(snapshot)
    deadline = time.time()+179
    session = WeightSpaceSession(snapshot, parsed, session_id='session', runtime_hash='d'*64, directory=tmp_path/'journal', deadline=deadline)
    team = 'workspace'
    def command(operation, action, **fields):
        return {'teamId': team, 'sessionId': 'session', 'operationId': operation, 'expectedRevision': session.state['revision'],
                'candidateHash': session.state['candidateHash'], 'action': action, **fields}
    edit = command('edit', 'code', hypothesis='Scale two columns without mutating the base', code='w = read(0, [0, 2])\nscaled = w * 0.5\nwrite(scaled, 0, [0, 2])\nshow(scaled)')
    result = session.perform(edit)
    assert result['status'] == 'succeeded' and result['changedColumns'] == [{'layer': 0, 'columns': [0, 2]}]
    candidate_hash = result['candidateHash']
    assert candidate_hash != edit['candidateHash'] and torch.equal(snapshot.projection.weight, original)
    assert session.perform(edit) == result  # Uncertain ACK does not consume work or create a candidate twice.
    conflicting = {**edit, 'code': 'w = read(0, [1])\nshow(w)'}
    with pytest.raises(Exception):
        session.perform(conflicting)
    stale = {**edit, 'operationId': 'stale'}
    with pytest.raises(Exception):
        session.perform(stale)
    # A later invalid instruction cannot expose or commit an earlier staged write.
    invalid = command('invalid', 'code', hypothesis='Reject a write with a later missing variable',
        code='w = read(0, [1])\nchanged = w * 0\nwrite(changed, 0, [1])\nbad = w @ w\nshow(bad)')
    rejected = session.perform(invalid)
    assert rejected['status'] == 'rejected' and rejected['candidateHash'] == candidate_hash
    assert torch.equal(snapshot.projection.weight, original)
    with session.workspace.installed(candidate_hash):
        expected = torch.nn.functional.linear(torch.ones(1, 4, dtype=torch.bfloat16), snapshot.projection.weight)
    assert torch.equal(snapshot.projection.weight, original)
    # Reconnect from real disk candidate/receipt custody, rather than process-only state.
    session = WeightSpaceSession(snapshot, parsed, session_id='session', runtime_hash='d'*64, directory=tmp_path/'journal', deadline=deadline)
    assert session.perform(edit) == result
    final = session.perform(command('final', 'finalize'))
    assert final['status'] == 'succeeded' and session.state['closed']
    from ponder_sdk.reference.artifacts import read_json
    manifest = read_json(tmp_path/'journal'/'module'/'manifest.json', 262144)
    reloaded = Snapshot(original)
    load_weight_space_patch(reloaded, tmp_path/'journal'/'module', expected_content_hash=manifest['contentHash'])
    actual = torch.nn.functional.linear(torch.ones(1, 4, dtype=torch.bfloat16), reloaded.projection.weight)
    assert torch.equal(actual, expected)
    assert torch.equal(reloaded.projection.weight[:, [1, 3]], original[:, [1, 3]])
    wrong_base = Snapshot(original+1)
    with pytest.raises(Exception):
        load_weight_space_patch(wrong_base, tmp_path/'journal'/'module', expected_content_hash=manifest['contentHash'])
    assert torch.equal(wrong_base.projection.weight, original+1)


def test_interrupted_reserved_work_is_not_replayed(tmp_path):
    snapshot = Snapshot()
    parsed = request(snapshot)
    deadline = time.time()+179
    session = WeightSpaceSession(snapshot, parsed, session_id='session', runtime_hash='d'*64, directory=tmp_path, deadline=deadline)
    pending = {'teamId': 'workspace', 'sessionId': 'session', 'operationId': 'interrupted', 'expectedRevision': 1,
               'candidateHash': session.state['candidateHash'], 'action': 'evaluate', 'panelId': 'practice'}
    session.state.update(pending=pending)
    session.state['usage'].update(commands=1, arithmeticWork=123, forwardTokenWork=10)
    session.persist()
    recovered = WeightSpaceSession(snapshot, parsed, session_id='session', runtime_hash='d'*64, directory=tmp_path, deadline=deadline)
    result = recovered.perform(pending)
    assert result['status'] == 'rejected' and result['code'] == 'weight_space_command_interrupted'
    assert result['usage'] == {'commands': 1, 'candidates': 0, 'arithmeticWork': 123, 'forwardTokenWork': 10}


@pytest.mark.parametrize('source', ['import os', 'x = __import__("os")', 'x = read.__globals__',
    'while True: pass', 'x = read(0, [0])\nx = x * 2', 'write(read(0, [0]), 0, [0])\nopen("file", "w")'])
def test_analysis_code_cannot_escape_the_tensor_language(source):
    with pytest.raises(Exception):
        compile_tensor_code(source)


def test_exact_candidate_forward_evaluation_and_reserved_work(tmp_path):
    # Catch evaluating the pristine base after an edit, double-billing a replay,
    # or losing partially consumed forward work when a later token is refused.
    pytest.importorskip('transformers')
    from transformers import Qwen3Config, Qwen3ForCausalLM
    torch.manual_seed(7)
    snapshot = Snapshot()
    # Real Transformers generation and KV caches, with tiny attention/MLP/vocab
    # geometry. Only the projection row size follows the patch contract.
    config = Qwen3Config(vocab_size=16, hidden_size=4096, intermediate_size=4,
        num_hidden_layers=1, num_attention_heads=1, num_key_value_heads=1,
        head_dim=8, max_position_embeddings=64, bos_token_id=1, eos_token_id=0)
    snapshot.model = Qwen3ForCausalLM(config).to(dtype=torch.bfloat16).eval()
    snapshot.model.requires_grad_(False)
    snapshot.projection = snapshot.model.model.layers[0].mlp.down_proj
    with torch.no_grad():
        snapshot.projection.weight.mul_(100)
    snapshot.identity['weightsHash'] = tensor_hash(snapshot.projection.weight)
    calls = []
    def observe(module, args, kwargs):
        calls.append(kwargs['input_ids'].shape[1])
    observer = snapshot.model.register_forward_pre_hook(observe, with_kwargs=True)
    snapshot.tokenizer = SimpleNamespace(eos_token_id=0,
        apply_chat_template=lambda messages, **kwargs: [1, 2], decode=lambda ids, **kwargs: str(ids))
    parsed = request(snapshot)
    session = WeightSpaceSession(snapshot, parsed, session_id='session', runtime_hash='d'*64,
        directory=tmp_path/'complete', deadline=time.time()+179)
    def command(operation, action, **fields):
        return {'teamId': 'workspace', 'sessionId': 'session', 'operationId': operation,
            'expectedRevision': session.state['revision'], 'candidateHash': session.state['candidateHash'], 'action': action, **fields}
    baseline = session.perform(command('baseline', 'evaluate', panelId='practice'))
    assert baseline['status'] == 'succeeded'
    assert baseline['evaluation']['rows'][0]['forwardTokenWork'] == 14
    assert calls == [2, 1, 1, 1]  # Prefill once; subsequent forwards consume one token.
    edit = session.perform(command('edit', 'code', hypothesis='Reverse all four supported fixture columns',
        code='w = read(0, [0, 1, 2, 3])\nchanged = w * -1\nwrite(changed, 0, [0, 1, 2, 3])'))
    assert edit['status'] == 'succeeded'
    evaluate = command('candidate', 'evaluate', panelId='practice')
    candidate = session.perform(evaluate)
    assert candidate['status'] == 'succeeded'
    assert candidate['evaluation']['rows'][0]['outputIds'] != baseline['evaluation']['rows'][0]['outputIds']
    before_replay = list(calls)
    assert session.perform(evaluate) == candidate and calls == before_replay
    restored = session.perform(command('restored', 'select', targetCandidateHash=session.workspace.base_hash))
    assert restored['status'] == 'succeeded'
    repeated = session.perform(command('repeat-baseline', 'evaluate', panelId='practice'))
    assert repeated['evaluation']['rows'] == baseline['evaluation']['rows']  # No candidate cache reuse.
    snapshot.verify()  # Temporary installation was restored before the next command.
    parsed['limits']['maximumForwardTokenWork'] = 3
    short = WeightSpaceSession(snapshot, parsed, session_id='session', runtime_hash='d'*64,
        directory=tmp_path/'short', deadline=time.time()+179)
    refused = short.perform({'teamId':'workspace','sessionId':'session','operationId':'budget',
        'expectedRevision':1,'candidateHash':short.state['candidateHash'],'action':'evaluate','panelId':'practice'})
    assert refused['status'] == 'rejected' and refused['usage']['forwardTokenWork'] == 2
    assert calls[-1] == 2 and len(calls) == len(before_replay) + 5
    observer.remove()
    snapshot.verify()

    # Held-out inputs enter only through the trusted evaluation-owner envelope.
    # They cannot be selected as iterative feedback, and finalization is one-way
    # even if a forward is interrupted or its remaining budget is insufficient.
    frozen_request = request(snapshot)
    frozen_request['frozenEvaluation'] = {'id': 'held-out', 'revision': 1, 'contentHash': 'e'*64}
    frozen_panel = {'source': frozen_request['frozenEvaluation'],
        'prompts': [{'id': 'secret-task', 'text': 'A held-out input', 'system': 'Answer the task.'}]}
    frozen = WeightSpaceSession(snapshot, frozen_request, session_id='session', runtime_hash='d'*64,
        directory=tmp_path/'frozen', deadline=time.time()+179, frozen_panel=frozen_panel)
    def frozen_command(operation, action, **fields):
        return {'teamId': 'workspace', 'sessionId': 'session', 'operationId': operation,
            'expectedRevision': frozen.state['revision'], 'candidateHash': frozen.state['candidateHash'], 'action': action, **fields}
    hidden = frozen.perform(frozen_command('hidden', 'evaluate', panelId='held-out'))
    assert hidden['status'] == 'rejected' and hidden['evaluation'] is None and hidden['finalEvaluation'] is None
    assert hidden['usage']['forwardTokenWork'] == 0
    edited = frozen.perform(frozen_command('edit', 'code', hypothesis='Edit before freezing',
        code='w = read(0, [0])\nchanged = w * -1\nwrite(changed, 0, [0])'))
    assert edited['status'] == 'succeeded'
    finalize = frozen_command('final', 'finalize')
    final = frozen.perform(finalize)
    assert final['status'] == 'succeeded' and frozen.state['closed']
    assert frozen.state['finalization']['status'] == 'succeeded'
    assert final['finalEvaluation']['source'] == frozen_request['frozenEvaluation']
    assert final['finalEvaluation']['candidateHash'] == edited['candidateHash']
    assert final['finalEvaluation']['rows'][0]['id'] == 'secret-task'
    assert final['finalEvaluation']['baseline']['candidateHash'] == frozen.workspace.base_hash
    assert final['finalEvaluation']['baseline']['rows'][0]['outputIds'] == baseline['evaluation']['rows'][0]['outputIds']
    assert sum(row['forwardTokenWork'] for row in final['finalEvaluation']['rows']
        + final['finalEvaluation']['baseline']['rows']) == final['usage']['forwardTokenWork']
    assert frozen.perform(finalize) == final
    with pytest.raises(Exception):
        frozen.perform(frozen_command('after-final', 'inspect', layer=0, columns=[0]))
    from ponder_sdk.reference.artifacts import read_json
    assert read_json(tmp_path/'frozen'/'export.json', 1_048_576)['forwardTokenWork'] == final['usage']['forwardTokenWork']
    # Reload the saved patch onto an independent decoder, then compare actual
    # generated tokens rather than just a projection hash or a linear output.
    from ponder_sdk.reference.generation import generate_greedy
    manifest = read_json(tmp_path/'frozen'/'module'/'manifest.json', 262144)
    reloaded = deepcopy(snapshot)
    load_weight_space_patch(reloaded, tmp_path/'frozen'/'module', expected_content_hash=manifest['contentHash'])
    output = generate_greedy(reloaded.model, reloaded.tokenizer,
        [{'role':'system','content':'Answer the task.'},{'role':'user','content':'A held-out input'}],
        max_output_tokens=4, reserve=lambda work: None, check=lambda: None)
    assert output['outputIds'] == final['finalEvaluation']['rows'][0]['outputIds']

    failed_request = deepcopy(frozen_request)
    failed_request['limits']['maximumForwardTokenWork'] = baseline['evaluation']['rows'][0]['forwardTokenWork']
    failed = WeightSpaceSession(snapshot, failed_request, session_id='session', runtime_hash='d'*64,
        directory=tmp_path/'frozen-failed', deadline=time.time()+179, frozen_panel=frozen_panel)
    changed = failed.perform({'teamId':'workspace','sessionId':'session','operationId':'failed-edit',
        'expectedRevision':1,'candidateHash':failed.state['candidateHash'],'action':'code',
        'hypothesis':'Retain a real candidate before the failed final forward',
        'code':'w = read(0, [0])\nchanged = w * -1\nwrite(changed, 0, [0])'})
    assert changed['status'] == 'succeeded'
    refused = failed.perform({'teamId':'workspace','sessionId':'session','operationId':'failed-final',
        'expectedRevision':2,'candidateHash':failed.state['candidateHash'],'action':'finalize'})
    assert refused['status'] == 'rejected' and refused['finalEvaluation'] is None and failed.state['closed']
    assert failed.state['finalization']['status'] == 'rejected'
    assert refused['usage']['forwardTokenWork'] == failed_request['limits']['maximumForwardTokenWork']
    with pytest.raises(Exception):
        failed.perform({'teamId':'workspace','sessionId':'session','operationId':'retry-edit',
            'expectedRevision':3,'candidateHash':failed.state['candidateHash'],'action':'inspect','layer':0,'columns':[0]})
    # A kernel crash after finalization begins must preserve that same boundary.
    crash = WeightSpaceSession(snapshot, frozen_request, session_id='session', runtime_hash='d'*64,
        directory=tmp_path/'frozen-interrupted', deadline=time.time()+179, frozen_panel=frozen_panel)
    crash.perform({'teamId':'workspace','sessionId':'session','operationId':'crash-edit',
        'expectedRevision':1,'candidateHash':crash.state['candidateHash'],'action':'code',
        'hypothesis':'Retain a candidate before simulated process interruption',
        'code':'w = read(0, [0])\nchanged = w * -1\nwrite(changed, 0, [0])'})
    pending = {'teamId':'workspace','sessionId':'session','operationId':'interrupted-final',
        'expectedRevision':crash.state['revision'],'candidateHash':crash.state['candidateHash'],'action':'finalize'}
    crash.state.update(pending=pending)
    crash.state['usage']['commands'] += 1
    crash.state['usage']['forwardTokenWork'] += 2
    crash.persist()
    recovered = WeightSpaceSession(snapshot, frozen_request, session_id='session', runtime_hash='d'*64,
        directory=tmp_path/'frozen-interrupted', deadline=crash.deadline, frozen_panel=frozen_panel)
    interrupted = recovered.perform(pending)
    assert interrupted['status'] == 'rejected' and interrupted['code'] == 'weight_space_command_interrupted'
    assert recovered.state['closed'] and interrupted['finalEvaluation'] is None and interrupted['usage']['forwardTokenWork'] == 2
    # Canonical grading text excludes chat terminators, while raw generated IDs
    # remain intact. Use a real tokenizer and decoder, including a non-default EOS.
    from tokenizers import Tokenizer
    from tokenizers.models import WordLevel
    from tokenizers.pre_tokenizers import Whitespace
    from transformers import PreTrainedTokenizerFast
    backend = Tokenizer(WordLevel({f't{i}': i for i in range(16)}, unk_token='t15'))
    backend.pre_tokenizer = Whitespace()
    tokenizer = PreTrainedTokenizerFast(tokenizer_object=backend, unk_token='t15')
    tokenizer.chat_template = '{{ messages[0].content }}'
    with torch.no_grad():
        stop = int(snapshot.model(input_ids=torch.tensor([[1, 2]]), use_cache=False).logits[0, -1].argmax())
    tokenizer.add_special_tokens({'eos_token': f't{stop}'})
    charged = []
    stopped = generate_greedy(snapshot.model, tokenizer, [{'role':'user','content':'t1 t2'}],
        max_output_tokens=4, reserve=charged.append, check=lambda: None)
    assert stopped['outputIds'] == [stop] and stopped['outputText'] == '' and not stopped['reachedTokenLimit']
    assert charged == [2] and stopped['forwardTokenWork'] == 2
    snapshot.verify()
