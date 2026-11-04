"""Compile saved activation authoring with an explicitly supplied tokenizer.

No PyTorch, model download or remote operation is imported here. The adapter is
trusted local custody: its descriptor and source pins must match the supplied
model, but an encoding function cannot attest hosted tokenizer admission.
"""
from __future__ import annotations

import copy
import math
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Literal, cast

from . import inputs, models
from .errors import ProtocolError
from .neuron_steering import verify_activation_request, verify_neuron_calibration
from .wire import JsonValue, _JS_SPACE, canonical_sha256, validate


@dataclass(frozen=True)
class ActivationFormTokenizer:
    """Trusted text encoder for one exact checkpoint/tokenizer source.

    descriptor includes vocabSize and eosTokenIds, plus all encoder settings
    needed to identify its behavior (including special tokens/templates). It is
    hashed exactly as supplied; that hash must equal model.tokenizerHash.
    encode receives the original prompt text and returns unpadded token IDs,
    including any desired special tokens, without truncation. A host must resolve
    and authorize its own adapter rather than accepting this callback remotely.
    """
    source: models.ModelProjectBaseModel
    descriptor: Mapping[str, JsonValue]
    encode: Callable[[str], Sequence[int]]


_NUMBER = re.compile(r'[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z')


def _decimal(text: str) -> Decimal:
    value = text.strip(_JS_SPACE)
    if not _NUMBER.fullmatch(value):
        raise ProtocolError('activation_form_number_incomplete')
    try:
        return Decimal(value)
    except InvalidOperation:
        raise ProtocolError('activation_form_number_invalid') from None


def _integer(text: str, low: int, high: int) -> int:
    value = _decimal(text)
    if value != value.to_integral_value() or not low <= value <= high:
        raise ProtocolError('activation_form_integer_out_of_range')
    return int(value)


def _finite(text: str) -> float:
    value = _decimal(text)
    try:
        number = float(value)
    except (ValueError, OverflowError):
        raise ProtocolError('activation_form_number_out_of_range') from None
    if not math.isfinite(number) or number == 0 and value != 0:
        raise ProtocolError('activation_form_number_out_of_range')
    return number


def _multipliers(text: str) -> list[float]:
    raw = text.strip(_JS_SPACE)
    parts = raw.split(',') if ',' in raw else raw.split()
    if not 1 <= len(parts) <= 16:
        raise ProtocolError('activation_form_sweep_size_invalid')
    values = [_finite(part) for part in parts]
    if len(set(values)) != len(values):
        raise ProtocolError('activation_form_duplicate_multiplier')
    return values


def _tokenizer_context(form: dict, model: dict, adapter: ActivationFormTokenizer) -> tuple[int, list[int]]:
    source = validate('ModelProjectBaseModelSchema', adapter.source)
    descriptor = copy.deepcopy(dict(adapter.descriptor))
    vocabulary = descriptor.get('vocabSize')
    eos = descriptor.get('eosTokenIds')
    if (form['baseModel'] is None or canonical_sha256(form['baseModel']) != canonical_sha256(source)
            or not source['revision'] or not source['tokenizerRevision']
            or source['modelId'] != model['modelId'] or source['revision'] != model['revision']
            or canonical_sha256(descriptor) != model['tokenizerHash']):
        raise ProtocolError('activation_form_tokenizer_identity_mismatch')
    if (type(vocabulary) is not int or not 1 <= vocabulary <= 2_147_483_648
            or not isinstance(eos, list) or len(eos) > 16
            or any(type(token) is not int or not 0 <= token < vocabulary for token in eos)
            or len(set(eos)) != len(eos) or not callable(adapter.encode)):
        raise ProtocolError('activation_form_tokenizer_descriptor_invalid')
    return vocabulary, eos


def _encode_prompts(form: dict, adapter: ActivationFormTokenizer, vocabulary: int) -> list[dict]:
    prompts = []
    for prompt in form['prompts']:
        if not prompt['text']:
            raise ProtocolError('activation_form_prompt_empty')
        try:
            encoded = adapter.encode(prompt['text'])
        except Exception:
            raise ProtocolError('activation_form_tokenization_failed') from None
        if (not isinstance(encoded, Sequence) or isinstance(encoded, (str, bytes, bytearray))
                or not 1 <= len(encoded) <= 4096
                or any(type(token) is not int or not 0 <= token < vocabulary for token in encoded)):
            raise ProtocolError('activation_form_tokenization_invalid')
        tokens = list(encoded)
        prompts.append({'id': prompt['id'], 'tokenIds': tokens, 'attentionMask': [1] * len(tokens)})
    return prompts


def _fixed_calibration(form: dict, model: dict, entries: list[dict], calibrations: Sequence[models.NeuronResidualCalibration]) -> None:
    normalization = form['normalization']
    if normalization['mode'] != 'fixed_residual_reference':
        return
    ref = normalization['calibration']
    if any(not isinstance(item, Mapping) for item in calibrations):
        raise ProtocolError('activation_form_calibration_invalid')
    matches = [item for item in calibrations if all(item.get(key) == ref[key] for key in ('id', 'revision', 'contentHash'))]
    if len(matches) != 1:
        raise ProtocolError('activation_form_calibration_unavailable')
    value = verify_neuron_calibration(matches[0], model, ref)
    if not {entry['layer'] for entry in entries} <= {row['layer'] for row in value['layers']}:
        raise ProtocolError('activation_form_calibration_incomplete')


def _steering_version(resolved: object) -> dict:
    from .steering_publication_identity import version as verify_version
    value = validate('SteeringModelVersionSchema', resolved)
    verify_version(value, value['teamId'], value['modelProjectId'])
    return value


def _steering_source(version: dict) -> dict:
    publication = version['publication']
    return {'modelProjectId': version['modelProjectId'], 'versionHash': version['contentHash'],
            'publication': {key: publication[key] for key in ('id', 'revision', 'contentHash')},
            'profileHash': publication['profile']['contentHash']}


def activation_form_from_steering_version(form: inputs.ActivationExperimentFormDraft, resolved: models.SteeringModelVersion) -> models.ActivationExperimentFormDraft:
    """Seed replacement controls; retain literal prompts, limits and spend.

    The explicit version is verified, never looked up or replaced with latest.
    Compact authoring provenance alone is untrusted and grants no admission.
    """
    raw = validate('ActivationExperimentFormDraftSchema', form)
    version = _steering_version(resolved)
    profile = version['publication']['profile']
    return cast(models.ActivationExperimentFormDraft, validate('ActivationExperimentFormDraftSchema', {**raw,
        'baseModel': copy.deepcopy(version['publication']['baseModel']), 'startingProfile': _steering_source(version),
        'coordinates': [{'id': f'saved-coordinate-{index + 1}', 'layer': str(row['layer']), 'neuron': str(row['neuron']), 'dose': str(row['dose'])}
                        for index, row in enumerate(profile['entries'])], 'doseMultipliers': '1',
        'normalization': copy.deepcopy(profile['normalization']), 'tokenScope': copy.deepcopy(profile['tokenScope'])}))


def experiment_starting_model_from_steering_version(resolved: models.SteeringModelVersion, *, label: str | None = None) -> dict:
    version = _steering_version(resolved)
    return validate('ExperimentStartingModelSchema', {'source': 'steering', 'label': label if label is not None else version['publication']['name'],
        'inferenceModelId': None, 'baseModel': copy.deepcopy(version['publication']['baseModel']), 'steering': _steering_source(version)})


def compile_activation_form(
    form: inputs.ActivationExperimentFormDraft,
    *,
    method: Literal['neuron_steering', 'inspect_activations'],
    model: models.NeuronSteeringModel,
    tokenizer: ActivationFormTokenizer,
    calibrations: Sequence[models.NeuronResidualCalibration] = (),
    maximum_absolute_dose: float = 16,
    starting_profile_version: models.SteeringModelVersion | None = None,
) -> models.ActivationReferenceRequest:
    """Compile text and raw controls to a complete bounded reference request.

    No defaults repair blank numbers, no prompt is truncated, and every steering
    profile retains the authored normalization/token scope. The dense reference
    supports both normalization modes and all schema-defined scope combinations.
    Inspection records unsteered activations only: its inactive dose, sweep,
    normalization and intervention-scope controls do not change capture semantics.
    Fixed calibrations must also be supplied to ActivationReferenceExecutor.run.
    Supplied model/source identities remain host assertions; the executor checks
    its actual loaded tensor state separately. This function grants no admission.
    """
    raw = validate('ActivationExperimentFormDraftSchema', form)
    identity = validate('NeuronSteeringModelSchema', model)
    if method not in ('neuron_steering', 'inspect_activations'):
        raise ProtocolError('activation_form_method_unsupported')
    if (not raw['prompts'] or not raw['coordinates']
            or any(len({row['id'] for row in raw[key]}) != len(raw[key]) for key in ('prompts', 'coordinates'))):
        raise ProtocolError('activation_form_rows_invalid')
    if type(maximum_absolute_dose) not in (int, float) or not math.isfinite(maximum_absolute_dose) or maximum_absolute_dose <= 0:
        raise ProtocolError('activation_form_dose_limit_invalid')
    vocabulary, eos = _tokenizer_context(raw, identity, tokenizer)
    starting_profile = None
    if raw.get('startingProfile') is not None:
        if method != 'neuron_steering':
            raise ProtocolError('activation_form_saved_source_method_unsupported')
        if starting_profile_version is None:
            raise ProtocolError('activation_form_saved_source_unresolved')
        version = _steering_version(starting_profile_version)
        starting_profile = version['publication']['profile']
        if (raw['startingProfile'] != _steering_source(version) or raw['baseModel'] != version['publication']['baseModel']
                or canonical_sha256(starting_profile['model']) != canonical_sha256(identity)):
            raise ProtocolError('activation_form_saved_source_model_mismatch')
        if any(abs(entry['dose']) > maximum_absolute_dose for entry in starting_profile['entries']):
            raise ProtocolError('activation_form_dose_limit_exceeded')
        _fixed_calibration(starting_profile, identity, starting_profile['entries'], calibrations)
    elif starting_profile_version is not None:
        raise ProtocolError('activation_form_saved_source_unrequested')
    entries = []
    capture: dict[int, list[int]] = {}
    seen = set()
    for row in raw['coordinates']:
        layer = _integer(row['layer'], 0, len(identity['intermediateSizes']) - 1)
        neuron = _integer(row['neuron'], 0, identity['intermediateSizes'][layer] - 1)
        if (layer, neuron) in seen:
            raise ProtocolError('activation_form_duplicate_coordinate')
        seen.add((layer, neuron))
        capture.setdefault(layer, []).append(neuron)
        if method == 'neuron_steering':
            entries.append({'layer': layer, 'neuron': neuron, 'dose': _finite(row['dose'])})
    variants: list[dict] = [{'id': 'baseline', 'profile': None}]
    if starting_profile is not None:
        variants.append({'id': 'saved-profile', 'profile': starting_profile})
    if method == 'neuron_steering':
        _fixed_calibration(raw, identity, entries, calibrations)
        for index, multiplier in enumerate(_multipliers(raw['doseMultipliers'])):
            scaled = [{**entry, 'dose': entry['dose'] * multiplier} for entry in entries]
            if any(not math.isfinite(entry['dose']) or abs(entry['dose']) > maximum_absolute_dose
                   or entry['dose'] == 0 and original['dose'] != 0 and multiplier != 0
                   for original, entry in zip(entries, scaled)):
                raise ProtocolError('activation_form_dose_limit_exceeded')
            content = {'schemaVersion': 'openpond.neuronSteeringProfile.v1', 'model': identity,
                       'hook': 'mlp.down_proj.input', 'operation': 'add',
                       'normalization': raw['normalization'], 'tokenScope': raw['tokenScope'], 'entries': scaled}
            profile = {**content, 'contentHash': canonical_sha256(content)}
            if starting_profile is None or not any(row['profile'] is not None and row['profile']['contentHash'] == profile['contentHash'] for row in variants):
                variants.append({'id': f'strength-{index + 1}', 'profile': profile})
    if len(variants) > 17:
        raise ProtocolError('activation_form_variant_limit_exceeded')
    prompts = _encode_prompts(raw, tokenizer, vocabulary)
    if (any(row['profile'] is not None and row['profile']['normalization']['mode'] == 'baseline_prompt_residual_median' for row in variants)
            and any(len(prompt['tokenIds']) < 2 for prompt in prompts)):
        raise ProtocolError('activation_form_calibration_prompt_too_short')
    request = {'schemaVersion': 'openpond.activationReferenceRequest.v1', 'model': identity,
               'prompts': prompts, 'variants': variants,
               'capture': [{'layer': layer, 'neurons': neurons} for layer, neurons in capture.items()],
               'maxNewTokens': _integer(raw['maxNewTokens'], 0, 128), 'eosTokenIds': eos,
               'maximumCapturedValues': _integer(raw['maximumCapturedValues'], 1, 65_536),
               'maximumForwardTokenWork': _integer(raw['maximumForwardTokenWork'], 1, 1_000_000),
               'maximumDurationSeconds': _finite(raw['maximumDurationSeconds'])}
    if raw.get('startingProfile') is not None:
        request['startingProfile'] = {**raw['startingProfile'], 'variantId': 'saved-profile'}
    return cast(models.ActivationReferenceRequest, verify_activation_request(request))
