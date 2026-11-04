"""Compile raw prompt/coordinate authoring and run a synthetic CPU reference.

Run in a PyTorch environment with ponder-sdk installed:
    python activation_reference.py --output reference-result.json
This is numerical reference execution, not an OpenPond hosted Job or benchmark.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
from typing import Any
import torch
from torch import nn
from ponder_sdk.wire import canonical_sha256
from ponder_sdk.activation_forms import ActivationFormTokenizer, compile_activation_form
from ponder_sdk.reference.activations import ActivationReferenceExecutor
from ponder_sdk.reference.dense_model import DenseReferenceModel, tensor_state_hash


class DenseLayer(nn.Module):
    def __init__(self):
        super().__init__()
        self.gate = nn.Linear(4, 6, bias=False)
        self.up = nn.Linear(4, 6, bias=False)
        self.down_proj = nn.Linear(6, 4, bias=False)

    def forward(self, hidden: torch.Tensor) -> torch.Tensor:
        return hidden + self.down_proj(torch.sigmoid(self.gate(hidden)) * self.up(hidden))


class DenseDemo(nn.Module):
    def __init__(self):
        super().__init__()
        self.embedding = nn.Embedding(10, 4)
        self.layers = nn.ModuleList([DenseLayer(), DenseLayer()])
        self.output = nn.Linear(4, 10, bias=False)
        with torch.no_grad():
            for index, parameter in enumerate(self.parameters()):
                parameter.copy_(torch.sin(torch.arange(parameter.numel(), dtype=torch.float32).reshape(parameter.shape) + index) * 0.1)

    def forward(self, ids: torch.Tensor, _mask: torch.Tensor, _positions: torch.Tensor) -> torch.Tensor:
        hidden = self.embedding(ids)
        for layer in self.layers:
            hidden = layer(hidden)
        return self.output(hidden)


def make_demo_adapter(tokenizer: dict[str, Any] | None = None) -> DenseReferenceModel:
    # Restores process RNG state after constructors; execution itself is greedy.
    with torch.device("cpu"), torch.random.fork_rng(devices=[]):
        torch.manual_seed(0)
        model = DenseDemo().eval()
    config = {'kind': 'dense-causal-reference-demo', 'hiddenSize': 4, 'intermediateSizes': [6, 6]}
    tokenizer = tokenizer if tokenizer is not None else {'kind': 'integer-reference-vocabulary', 'vocabSize': 10, 'eosTokenIds': []}
    identity = {'schemaVersion': 'openpond.neuronSteeringModel.v1', 'modelId': 'openpond/dense-reference-demo', 'revision': 'reference-v1',
                'configHash': canonical_sha256(config), 'weightsHash': tensor_state_hash(model), 'tokenizerHash': canonical_sha256(tokenizer),
                'weightIdentity': 'torch_state_dict_sha256_v1', 'architecture': 'dense_decoder', 'dtype': 'float32',
                'quantization': 'none', 'adapter': None, 'hiddenSize': 4, 'intermediateSizes': [6, 6]}
    return DenseReferenceModel(model, identity=identity, config=config, tokenizer=tokenizer, layers=model.layers,
                               down_projections=[layer.down_proj for layer in model.layers], forward=model.forward)


def make_example() -> tuple[DenseReferenceModel, dict[str, Any]]:
    adapter = make_demo_adapter()
    identity = adapter.identity
    def profile(dose: float, *, positions: str = 'all_non_padding', phase: str = 'prompt_and_decode') -> dict[str, Any]:
        body = {'schemaVersion': 'openpond.neuronSteeringProfile.v1', 'model': identity, 'hook': 'mlp.down_proj.input', 'operation': 'add',
                'normalization': {'mode': 'baseline_prompt_residual_median', 'statistic': 'midpoint_median_fp32',
                                  'sample': 'non_padding_prompt_after_position_zero'},
                'tokenScope': {'phase': phase, 'positions': positions}, 'entries': [{'layer': 0, 'neuron': 1, 'dose': dose}]}
        return {**body, 'contentHash': canonical_sha256(body)}
    later = profile(-1); later['entries'][0]['layer'] = 1
    later['contentHash'] = canonical_sha256({key: value for key, value in later.items() if key != 'contentHash'})
    combined = profile(1); combined['entries'].append({'layer': 1, 'neuron': 1, 'dose': -1})
    combined['contentHash'] = canonical_sha256({key: value for key, value in combined.items() if key != 'contentHash'})
    request = {'schemaVersion': 'openpond.activationReferenceRequest.v1', 'model': identity,
               'prompts': [{'id': 'plain', 'tokenIds': [1, 2, 3], 'attentionMask': [1, 1, 1]},
                           {'id': 'left-padded', 'tokenIds': [0, 1, 2, 3], 'attentionMask': [0, 1, 1, 1]}],
               'variants': [{'id': 'off', 'profile': None}, {'id': 'zero', 'profile': profile(0)},
                            {'id': 'positive', 'profile': profile(1)}, {'id': 'negative', 'profile': profile(-1)},
                            {'id': 'after-first', 'profile': profile(1, positions='after_position_zero')},
                            {'id': 'decode-only', 'profile': profile(1, phase='decode_only')},
                            {'id': 'layer-one', 'profile': later}, {'id': 'combined', 'profile': combined}],
               'capture': [{'layer': 0, 'neurons': list(range(6))}, {'layer': 1, 'neurons': [1]}],
               'maxNewTokens': 2, 'eosTokenIds': [], 'maximumCapturedValues': 4096,
               'maximumForwardTokenWork': 4096, 'maximumDurationSeconds': 30}
    return adapter, request


def make_form_example():
    """The explicit encoder is local adapter custody, not hosted admission.

    A real harness supplies its exact loaded tokenizer and descriptor instead.
    Text stays text in the saved form; the compiler owns bounded token requests.
    """
    descriptor = {'kind': 'whitespace-demo-vocabulary-v1', 'revision': 'reference-tokenizer-v1',
                  'vocabSize': 10, 'eosTokenIds': [], 'vocabulary': {'one': 1, 'two': 2, 'three': 3},
                  'specialTokens': 'none', 'truncation': False, 'padding': False}
    adapter = make_demo_adapter(descriptor)
    source = {'schemaVersion': 'openpond.baseModelPreference.v1', 'modelId': adapter.identity['modelId'],
              'revision': adapter.identity['revision'], 'tokenizerRevision': descriptor['revision'],
              'chatTemplateHash': None, 'modelAssetId': None, 'source': 'local'}
    tokenizer = ActivationFormTokenizer(source=source, descriptor=descriptor,
        encode=lambda text: [descriptor['vocabulary'][word] for word in text.split()])
    form = {'baseModel': source,
            'prompts': [{'id': 'forward', 'text': 'one two three'}, {'id': 'reverse', 'text': 'three two one'}],
            'coordinates': [{'id': 'first', 'layer': '0', 'neuron': '1', 'dose': '1'},
                            {'id': 'second', 'layer': '1', 'neuron': '2', 'dose': '-0.5'}],
            'doseMultipliers': '-1, 0, 1',
            'normalization': {'mode': 'baseline_prompt_residual_median', 'statistic': 'midpoint_median_fp32',
                              'sample': 'non_padding_prompt_after_position_zero'},
            'tokenScope': {'phase': 'decode_only', 'positions': 'after_position_zero'},
            'maxNewTokens': '2', 'maximumCapturedValues': '1024',
            'maximumForwardTokenWork': '512', 'maximumDurationSeconds': '30'}
    request = compile_activation_form(form, method='neuron_steering', model=adapter.identity, tokenizer=tokenizer)
    return adapter, form, tokenizer, request


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    adapter, form, _tokenizer, request = make_form_example()
    result = ActivationReferenceExecutor(adapter).run(request)
    if args.output:
        args.output.write_text(json.dumps({'form': form, 'request': request, 'result': result}, indent=2) + '\n')
    print(json.dumps({'kind': 'synthetic CPU reference', 'variants': len(request['variants']),
                      'outcomes': len(result['outcomes']), 'captures': len(result['captures']), 'contentHash': result['contentHash']}))
