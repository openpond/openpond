"""Portable steering identities; importing this module does not load PyTorch.

These are reference contracts, not a claim of managed worker support.
"""
from typing import Any
from .errors import ProtocolError
from .wire import canonical_sha256, validate


def verify_neuron_profile(raw: Any, model: dict[str, Any] | None = None) -> dict[str, Any]:
    value = validate('NeuronSteeringProfileSchema', raw)
    if (value['contentHash'] != canonical_sha256({k: v for k, v in value.items() if k != 'contentHash'})
            or model is not None and canonical_sha256(value['model']) != canonical_sha256(model)):
        raise ProtocolError('neuron_steering_profile_mismatch')
    seen: set[tuple[int, int]] = set()
    for entry in value['entries']:
        pair = (entry['layer'], entry['neuron'])
        sizes = value['model']['intermediateSizes']
        if pair in seen or entry['layer'] >= len(sizes) or entry['neuron'] >= sizes[entry['layer']]:
            raise ProtocolError('neuron_coordinate_invalid')
        seen.add(pair)
    return value


def verify_neuron_calibration(raw: Any, model: dict[str, Any], reference: dict[str, Any] | None = None) -> dict[str, Any]:
    value = validate('NeuronResidualCalibrationSchema', raw)
    if (value['contentHash'] != canonical_sha256({k: v for k, v in value.items() if k != 'contentHash'})
            or value['modelHash'] != canonical_sha256(model)
            or reference is not None and any(value[key] != reference[key] for key in ('id', 'revision', 'contentHash'))
            or len({row['layer'] for row in value['layers']}) != len(value['layers'])
            or any(row['layer'] >= len(model['intermediateSizes']) for row in value['layers'])):
        raise ProtocolError('neuron_calibration_mismatch')
    return value


def verify_activation_request(raw: Any) -> dict[str, Any]:
    value = validate('ActivationReferenceRequestSchema', raw)
    if (len({row['id'] for row in value['prompts']}) != len(value['prompts'])
            or len({row['id'] for row in value['variants']}) != len(value['variants'])):
        raise ProtocolError('activation_reference_duplicate_id')
    for prompt in value['prompts']:
        mask = prompt['attentionMask']
        if len(prompt['tokenIds']) != len(mask) or not any(mask) or mask[-1] != 1 or mask != sorted(mask):
            raise ProtocolError('activation_reference_prompt_mask_invalid')
    for variant in value['variants']:
        if variant['profile'] is not None:
            verify_neuron_profile(variant['profile'], value['model'])
    source = value.get('startingProfile')
    if source is not None:
        reference = next((row for row in value['variants'] if row['id'] == source['variantId']), None)
        if (reference is None or reference['profile'] is None or reference['profile']['contentHash'] != source['profileHash']
                or not any(row['profile'] is None for row in value['variants'])):
            raise ProtocolError('activation_reference_starting_profile_mismatch')
    seen: set[tuple[int, int]] = set()
    for row in value['capture']:
        for neuron in row['neurons']:
            pair = (row['layer'], neuron)
            sizes = value['model']['intermediateSizes']
            if pair in seen or row['layer'] >= len(sizes) or neuron >= sizes[row['layer']]:
                raise ProtocolError('activation_reference_capture_invalid')
            seen.add(pair)
    n = value['maxNewTokens']
    captures = sum(sum(row['attentionMask']) + n for row in value['prompts']) * len(value['variants']) * len(seen) * 2
    work = sum((n + 1) * len(prompt['tokenIds']) + n * (n + 1) // 2
               + (len(prompt['tokenIds']) if variant['profile'] is not None and variant['profile']['normalization']['mode'] == 'baseline_prompt_residual_median' else 0)
               for prompt in value['prompts'] for variant in value['variants'])
    if captures > value['maximumCapturedValues'] or work > value['maximumForwardTokenWork']:
        raise ProtocolError('activation_reference_budget_exceeded')
    return value


def verify_activation_result(raw: Any, request: dict[str, Any]) -> dict[str, Any]:
    request = verify_activation_request(request)
    value = validate('ActivationReferenceResultSchema', raw)
    if (value['contentHash'] != canonical_sha256({k: v for k, v in value.items() if k != 'contentHash'})
            or value['requestHash'] != canonical_sha256(request) or value['modelHash'] != canonical_sha256(request['model'])
            or len(value['captures']) * 2 > request['maximumCapturedValues']
            or len(value['outcomes']) != len(request['prompts']) * len(request['variants'])
            or sum(row['forwardTokenWork'] for row in value['outcomes']) > request['maximumForwardTokenWork']):
        raise ProtocolError('activation_reference_result_mismatch')
    prompts = {row['id']: row for row in request['prompts']}
    variants = {row['id']: row for row in request['variants']}
    coordinates = {(row['layer'], neuron) for row in request['capture'] for neuron in row['neurons']}
    pairs: set[tuple[str, str]] = set()
    captures: set[tuple[str, str, int, int, int]] = set()
    counts: dict[tuple[str, str], int] = {}
    for row in value['captures']:
        pair = (row['promptId'], row['variantId'])
        key = (*pair, row['layer'], row['neuron'], row['tokenIndex'])
        if key in captures or pair[0] not in prompts or pair[1] not in variants or (row['layer'], row['neuron']) not in coordinates:
            raise ProtocolError('activation_reference_capture_mismatch')
        captures.add(key)
        counts[pair] = counts.get(pair, 0) + 1
    for row in value['outcomes']:
        pair = (row['promptId'], row['variantId'])
        variant = variants.get(pair[1])
        if (pair in pairs or pair[0] not in prompts or variant is None
                or row['profileHash'] != (variant['profile']['contentHash'] if variant['profile'] is not None else None)
                or len(row['generatedTokenIds']) > request['maxNewTokens'] or row['captureCount'] != counts.get(pair, 0)):
            raise ProtocolError('activation_reference_outcome_mismatch')
        pairs.add(pair)
        prompt = prompts[pair[0]]
        tokens = [token for token, active in zip(prompt['tokenIds'], prompt['attentionMask']) if active] + row['generatedTokenIds']
        n = len(row['generatedTokenIds'])
        work = (n + 1) * len(prompt['tokenIds']) + n * (n + 1) // 2
        if variant['profile'] is not None and variant['profile']['normalization']['mode'] == 'baseline_prompt_residual_median':
            work += len(prompt['tokenIds'])
        if (row['captureCount'] != len(tokens) * len(coordinates) or row['forwardTokenWork'] != work
                or variant['profile'] is None and row['calibration']):
            raise ProtocolError('activation_reference_incomplete_capture')
        if (n < request['maxNewTokens'] and (not n or row['generatedTokenIds'][-1] not in request['eosTokenIds'])
                or any(token in request['eosTokenIds'] for token in row['generatedTokenIds'][:-1])):
            raise ProtocolError('activation_reference_incomplete_generation')
        if variant['profile'] is not None:
            targets: dict[int, set[int]] = {}
            for entry in variant['profile']['entries']:
                targets.setdefault(entry['layer'], set()).add(entry['neuron'])
            if (len(row['calibration']) != len(targets) or len({item['layer'] for item in row['calibration']}) != len(targets)
                    or any(item['layer'] not in targets or {col['neuron'] for col in item['columnNorms']} != targets[item['layer']]
                           or len(item['columnNorms']) != len(targets[item['layer']])
                           or variant['profile']['normalization']['mode'] == 'baseline_prompt_residual_median' and item['sampleCount'] != len(tokens) - n - 1
                           for item in row['calibration'])):
                raise ProtocolError('activation_reference_calibration_mismatch')
        for capture in value['captures']:
            if (capture['promptId'], capture['variantId']) == pair and (capture['tokenIndex'] >= len(tokens) or tokens[capture['tokenIndex']] != capture['tokenId']):
                raise ProtocolError('activation_reference_token_mismatch')
    return value
