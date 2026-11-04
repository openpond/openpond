"""Deterministic comparison of one immutable activation sweep; no Torch import.

The pure projections accept SDK-verified request/result values. Use
``verify_and_compare_activation_reference_result`` for untrusted retained bytes.
JSON field names and omission semantics match the TypeScript projection.
"""
from __future__ import annotations

import json
import math
from typing import Any, Literal, TypedDict
from typing_extensions import NotRequired

from .neuron_steering import verify_activation_request, verify_activation_result
from .wire import canonical_json


class ActivationDoseRow(TypedDict):
    layer: int
    neuron: int
    reference: float | None
    candidate: float | None
    difference: float | None


class ActivationDoseComparison(TypedDict):
    reason: str | None
    rows: list[ActivationDoseRow]


class ActivationComparisonPair(TypedDict):
    prompt: dict[str, Any]
    reference: NotRequired[dict[str, Any]]
    candidate: NotRequired[dict[str, Any]]
    inputTokenIds: list[int]
    referenceTokenIds: list[int]
    candidateTokenIds: list[int]
    sharedPrefix: int
    generatedStatus: Literal['missing_outcome', 'identical', 'different']
    generatedDifferencePosition: int | None


class ActivationCaptureComparison(TypedDict):
    key: str
    promptId: str
    tokenIndex: int
    phase: Literal['Prompt', 'Generated']
    layer: int
    neuron: int
    reference: NotRequired[dict[str, Any]]
    candidate: NotRequired[dict[str, Any]]
    status: Literal['aligned', 'incompatible_context', 'missing_reference', 'missing_candidate', 'missing_both']
    difference: float | None


class ActivationResultComparison(TypedDict):
    pairs: list[ActivationComparisonPair]
    captures: list[ActivationCaptureComparison]
    aligned: int


def _difference(candidate: float, reference: float) -> float | None:
    value = candidate - reference
    return value if math.isfinite(value) else None


def activation_dose_comparison(reference: dict[str, Any], candidate: dict[str, Any]) -> ActivationDoseComparison:
    """Compare doses only when the other intervention settings agree."""
    a, b = reference['profile'], candidate['profile']

    def settings(profile: dict[str, Any]) -> str:
        rest = {key: value for key, value in profile.items() if key not in ('entries', 'contentHash')}
        rest['coordinates'] = sorted(f"{row['layer']}:{row['neuron']}" for row in profile['entries'])
        return canonical_json(rest)

    reason = ('Dose differences unavailable: model, hook, normalization, token scope or targeted coordinates differ.'
              if a is not None and b is not None and settings(a) != settings(b) else None)
    coordinates: dict[tuple[int, int], ActivationDoseRow] = {}
    for profile, side in ((a, 'reference'), (b, 'candidate')):
        for entry in profile['entries'] if profile is not None else []:
            key = (entry['layer'], entry['neuron'])
            row = coordinates.setdefault(key, {'layer': key[0], 'neuron': key[1],
                'reference': 0 if a is None else None, 'candidate': 0 if b is None else None,
                'difference': None})
            if side == 'reference':
                row['reference'] = entry['dose']
            else:
                row['candidate'] = entry['dose']
    rows = [coordinates[key] for key in sorted(coordinates)]
    for row in rows:
        if reason is None and row['reference'] is not None and row['candidate'] is not None:
            row['difference'] = _difference(row['candidate'], row['reference'])
    return {'reason': reason, 'rows': rows}


def activation_result_comparison(request: dict[str, Any], result: dict[str, Any], reference_id: str,
                                 candidate_id: str, prompt_id: str | None = None) -> ActivationResultComparison:
    """Align one verified sweep by prompt, causal token prefix and coordinate.

    A matching token after a divergence does not restore causal equivalence.
    Missing evidence is retained as an explicit row with no numeric difference.
    """
    def capture_key(row: dict[str, Any]) -> str:
        return json.dumps([row['promptId'], row['tokenIndex'], row['layer'], row['neuron']],
                          ensure_ascii=False, separators=(',', ':'))

    reference_captures = {capture_key(row): row for row in result['captures'] if row['variantId'] == reference_id}
    candidate_captures = {capture_key(row): row for row in result['captures'] if row['variantId'] == candidate_id}
    outcomes = {(row['promptId'], row['variantId']): row for row in result['outcomes']}
    pairs: list[ActivationComparisonPair] = []
    captures: list[ActivationCaptureComparison] = []
    for prompt in request['prompts']:
        if prompt_id is not None and prompt['id'] != prompt_id:
            continue
        reference, candidate = outcomes.get((prompt['id'], reference_id)), outcomes.get((prompt['id'], candidate_id))
        inputs = [token for token, mask in zip(prompt['tokenIds'], prompt['attentionMask']) if mask == 1]
        a = inputs + reference['generatedTokenIds'] if reference is not None else []
        b = inputs + candidate['generatedTokenIds'] if candidate is not None else []
        shared = 0
        while shared < min(len(a), len(b)) and a[shared] == b[shared]:
            shared += 1
        generated_prefix = max(0, shared - len(inputs))
        status: Literal['missing_outcome', 'identical', 'different'] = (
            'missing_outcome' if reference is None or candidate is None else
            'identical' if len(reference['generatedTokenIds']) == len(candidate['generatedTokenIds']) == generated_prefix else 'different')
        pair: ActivationComparisonPair = {'prompt': prompt, 'inputTokenIds': inputs, 'referenceTokenIds': a,
            'candidateTokenIds': b, 'sharedPrefix': shared, 'generatedStatus': status,
            'generatedDifferencePosition': generated_prefix if status == 'different' else None}
        if reference is not None:
            pair['reference'] = reference
        if candidate is not None:
            pair['candidate'] = candidate
        pairs.append(pair)
        for index in range(max(len(a), len(b), len(inputs))):
            for coordinate in request['capture']:
                for neuron in coordinate['neurons']:
                    key = capture_key({'promptId': prompt['id'], 'tokenIndex': index, 'layer': coordinate['layer'], 'neuron': neuron})
                    left, right = reference_captures.get(key), candidate_captures.get(key)
                    alignment: Literal['aligned', 'incompatible_context', 'missing_reference', 'missing_candidate', 'missing_both'] = (
                        'missing_both' if left is None and right is None else 'missing_reference' if left is None else
                        'missing_candidate' if right is None else 'incompatible_context' if index >= shared else 'aligned')
                    row: ActivationCaptureComparison = {'key': key, 'promptId': prompt['id'], 'tokenIndex': index,
                        'phase': 'Prompt' if index < len(inputs) else 'Generated', 'layer': coordinate['layer'],
                        'neuron': neuron, 'status': alignment, 'difference': None}
                    if left is not None:
                        row['reference'] = left
                    if right is not None:
                        row['candidate'] = right
                    if alignment == 'aligned' and left is not None and right is not None:
                        row['difference'] = _difference(right['after'], left['after'])
                    captures.append(row)
    return {'pairs': pairs, 'captures': captures, 'aligned': sum(row['status'] == 'aligned' for row in captures)}


def verify_and_compare_activation_reference_result(request: dict[str, Any], raw: Any, reference_id: str,
                                                   candidate_id: str, prompt_id: str | None = None) -> ActivationResultComparison:
    """Verify the exact request and complete retained result before projection."""
    source = verify_activation_request(request)
    result = verify_activation_result(raw, source)
    return activation_result_comparison(source, result, reference_id, candidate_id, prompt_id)


__all__ = ['activation_dose_comparison', 'activation_result_comparison', 'verify_and_compare_activation_reference_result',
           'ActivationDoseComparison', 'ActivationResultComparison', 'ActivationCaptureComparison', 'ActivationComparisonPair']
