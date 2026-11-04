"""Four-file PEFT Decision loading and exact T1 candidate scoring, locally."""
from __future__ import annotations

from importlib.metadata import version
import math
from pathlib import Path
import threading
import time

from ..decision_identity import (
    verify_decision_model_identity, verify_decision_scoring_request,
    verify_decision_scoring_result, decision_reference_input,
)
from ..decision_identity_artifact import verify_decision_adapter_artifact
from ..wire import canonical_json, canonical_sha256
from .artifacts import Check, artifact_root, file_hash, read_json, require, sealed_manifest, tensors

FILES = {'manifest.json', 'adapter_model.safetensors', 'adapter_config.json', 'decision_contract.json'}
VERSIONS = {'torch': '2.8.0', 'transformers': '5.17.0', 'peft': '0.21.0', 'accelerate': '1.15.0',
            'sentencepiece': '0.2.2', 'pillow': '12.3.0', 'huggingface_hub': '1.16.1'}


def read_decision_artifact(directory, *, expected_content_hash, model_identity,
                           maximum_bytes=268_435_456, check: Check = lambda: None):
    root = artifact_root(directory, FILES, maximum_bytes)
    manifest = verify_decision_adapter_artifact(sealed_manifest(root, expected_content_hash))
    require(canonical_json(manifest['model']) == canonical_json(model_identity), 'decision_model_identity')
    for name, value in (('adapter_config.json', manifest['adapterConfig']), ('decision_contract.json', manifest['contract'])):
        require((root / name).read_bytes() == canonical_json(value).encode(), 'decision_metadata_bytes')
    tensors(root / 'adapter_model.safetensors', manifest['payload'], check=check,
            metadata={'format': 'pt'}, retain=False)
    return root, manifest


class DecisionScorer:
    """One request at a time over finite logits from every declared candidate.

    Limits/cancellation are cooperative checks between native calls. They cannot
    interrupt a blocked device call. This object makes no billing/runtime claim.
    """
    def __init__(self, model, tokenizer, prepare_prompts, identity, artifact, runtime_hash):
        self.model, self.tokenizer, self.prepare_prompts = model, tokenizer, prepare_prompts
        self.identity, self.artifact, self.runtime_hash = identity, artifact, runtime_hash
        self._lock = threading.Lock()

    def score(self, request, *, cancelled=lambda: False):
        parsed = verify_decision_scoring_request(request)
        require(canonical_json(parsed['model']) == canonical_json(self.identity)
                and parsed['artifact'] == self.artifact, 'decision_request_identity')
        require(self._lock.acquire(blocking=False), 'decision_concurrency')
        started = time.monotonic()
        def check():
            require(not cancelled(), 'decision_cancelled')
            require(time.monotonic() - started < parsed['limits']['maximumDurationSeconds'], 'decision_deadline')
        try:
            check()
            projected = decision_reference_input(parsed['input'])
            prompts = self.prepare_prompts(self.tokenizer, projected['context'], projected['schema'],
                                           parsed['limits']['maximumPromptTokens'])
            questions = parsed['input']['questions']
            require(prompts.names == [row['id'] for row in questions], 'decision_question_order')
            rows = [{'exampleId': None, 'questionId': question['id'], 'inputIds': ids, 'candidateIds': candidates}
                    for question, ids, candidates in zip(questions, prompts.full_ids, prompts.candidate_ids, strict=True)]
            work = sum(len(row['inputIds']) for row in rows)
            require(work <= parsed['limits']['maximumForwardTokenWork'], 'decision_forward_work')
            import torch
            device = next(self.model.parameters()).device
            require(device.type in ('cpu', 'cuda') and not self.model.training
                    and all(not p.requires_grad and p.grad is None for p in self.model.parameters()), 'decision_model_mutated')
            distributions = []
            with torch.inference_mode(), torch.autocast(device.type, dtype=torch.bfloat16):
                for question, row in zip(questions, rows, strict=True):
                    check()
                    ids = torch.tensor([row['inputIds']], device=device, dtype=torch.long)
                    candidates = torch.tensor([row['candidateIds']], device=device, dtype=torch.long)
                    logits = self.model(input_ids=ids, attention_mask=torch.ones_like(ids), use_cache=False,
                        logits_to_keep=1).logits[:, -1, :].float().gather(1, candidates)
                    require(tuple(logits.shape) == (1, len(row['candidateIds'])) and bool(torch.isfinite(logits).all()), 'decision_logits')
                    values = logits[0].double().cpu().tolist()
                    check()
                    weights = [math.exp(value - max(values)) for value in values]
                    total = math.fsum(weights)
                    probabilities = [weight / total for weight in weights]
                    choices = [choice['value'] for choice in question['choices']]
                    best = max(range(len(values)), key=values.__getitem__)
                    distributions.append({'questionId': question['id'], 'promptTokenCount': len(row['inputIds']),
                        'candidates': [{'value': value, 'code': chr(65 + index), 'tokenId': row['candidateIds'][index],
                            'logit': values[index], 'probability': probabilities[index]} for index, value in enumerate(choices)],
                        'prediction': choices[best], 'expectedLevel': math.fsum(value * probability for value, probability in zip(choices, probabilities))
                            if question['type'] == 'integer_levels' else None})
            check()
            content = {'schemaVersion': 'openpond.decisionScoringResult.v1', 'requestHash': canonical_sha256(parsed),
                'modelHash': canonical_sha256(parsed['model']), 'runtimeHash': self.runtime_hash,
                'preparedRowsHash': canonical_sha256(rows), 'artifact': self.artifact, 'temperature': 1,
                'distributions': distributions, 'forwardTokenWork': work, 'durationMs': (time.monotonic() - started) * 1000}
            return verify_decision_scoring_result({**content, 'contentHash': canonical_sha256(content)}, parsed, self.runtime_hash)
        finally:
            self._lock.release()


def load_decision(directory, *, expected_content_hash: str, artifact_id: str, model_identity,
                  source_directories, device='cuda:0', maximum_bytes=268_435_456, check: Check = lambda: None):
    """Load the exact exported adapter and its pinned local six source bundles.

    No model download, arbitrary Python source execution, generation-based grade,
    trainer, optimizer state, provider account or hosted runtime is involved.
    """
    identity = verify_decision_model_identity(model_identity)
    require(type(artifact_id) is str and 0 < len(artifact_id) <= 500, 'decision_artifact_id')
    root, manifest = read_decision_artifact(directory, expected_content_hash=expected_content_hash,
        model_identity=identity, maximum_bytes=maximum_bytes, check=check)
    actual = {name: version(name) for name in VERSIONS}
    require(all(actual[name].split('+')[0] == expected for name, expected in VERSIONS.items()), 'decision_dependency_versions')
    from .decision_sources import verify_sources
    from .decision_model import load_model
    roots, prepare_prompts = verify_sources(identity, source_directories, check)
    model, tokenizer = load_model(roots, root, device=device, check=check)
    # Recheck custody after PEFT has consumed the files, before returning a model.
    read_decision_artifact(root, expected_content_hash=expected_content_hash, model_identity=identity,
                           maximum_bytes=maximum_bytes, check=check)
    source_files = ['decision.py', 'decision_model.py', 'decision_sources.py', 'artifacts.py', 'decision_prompt/parallel_schema.py']
    runtime = {'schemaVersion': 'openpond.portableDecisionRuntime.v1', 'implementation': 'ponder_sdk_candidate_t1_v1',
        'packages': actual, 'sources': {name: file_hash(Path(__file__).parent / name, check) for name in source_files}}
    return DecisionScorer(model, tokenizer, prepare_prompts, identity,
        {'id': artifact_id, 'contentHash': manifest['contentHash']}, canonical_sha256(runtime))
