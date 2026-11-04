"""Exact decision source, reviewed inputs and candidate-score arithmetic.

These checks bind metadata. They neither attest model execution nor grant
Dataset, training, artifact or serving authority. Importing needs no torch.
"""
from typing import Any
import math
import re
from .errors import ProtocolError
from .wire import canonical_json, canonical_sha256, validate, _JS_SPACE


DECISION_IDENTITY_CONTENT_HASH = '9d7704b7dd369a066a979d1ef7d40105eaaa32af2442a5ccb8f673d4a29ab969'
DECISION_MODEL_HASH = 'ef91caaf63829120413c502a39b73772f973d693520a908f4951928728d97466'
DECISION_PROMPT_CODE_SHA256 = 'a0a0f94d0f65e972bc20d088678ad3d595ff1c42b9c0d78f96034526303f63fc'


def _bounded(value: Any, maximum_bytes: int) -> None:
    """Mirror assertBoundedTaskJson before schema normalization or hashing."""
    pending = [(value, 0, False)]
    active: set[int] = set()
    nodes = 0
    while pending:
        item, depth, exiting = pending.pop()
        if exiting:
            active.remove(id(item))
            continue
        nodes += 1
        if nodes > 100_000 or depth > 48:
            raise ProtocolError('task_json_complexity_exceeded')
        if item is None or type(item) in (str, bool):
            continue
        if type(item) in (int, float):
            try:
                if math.isfinite(item):
                    continue
            except OverflowError:
                pass
            raise ProtocolError('task_json_value_invalid')
        if type(item) not in (dict, list):
            raise ProtocolError('task_json_object_invalid')
        if id(item) in active:
            raise ProtocolError('task_json_cycle')
        if type(item) is dict and (not all(type(key) is str for key in item) or 'toJSON' in item):
            raise ProtocolError('task_json_object_invalid')
        if type(item) is list and len(item) > 10_000:
            raise ProtocolError('task_json_array_invalid')
        active.add(id(item))
        pending.append((item, depth, True))
        pending.extend((child, depth + 1, False) for child in (item.values() if type(item) is dict else item))
    if len(canonical_json(value).encode('utf-8')) > maximum_bytes:
        raise ProtocolError('task_json_size_exceeded')


def _hash(value: Any) -> str:
    if type(value) is not str or re.fullmatch(r'[a-f0-9]{64}', value) is None:
        raise ProtocolError('invalid_wire_value')
    return value


def _content_matches(value: dict[str, Any]) -> bool:
    return value['contentHash'] == canonical_sha256({key: item for key, item in value.items() if key != 'contentHash'})


def _same_value(first: Any, second: Any) -> bool:
    # JavaScript strict equality distinguishes booleans from numeric levels.
    return canonical_json(first) == canonical_json(second)


def _text(value: str, maximum: int, *, nonblank: bool = False) -> None:
    # JSON Schema counts Unicode code points; Zod's string bounds use UTF-16.
    if len(value.encode('utf-16-le', 'surrogatepass')) // 2 > maximum or nonblank and not value.strip(_JS_SPACE):
        raise ProtocolError('invalid_wire_value')


def _scoring_input(value: dict[str, Any]) -> None:
    _bounded(value['state'], 65_536)
    for key in value['state']:
        _text(key, 256)
    questions = value['questions']
    if len({row['id'] for row in questions}) != len(questions):
        raise ProtocolError('invalid_wire_value')
    for row in questions:
        if row['id'] in ('constructor', 'prototype'):
            raise ProtocolError('invalid_wire_value')
        _text(row['description'], 2000, nonblank=True)
        choices = row['choices']
        if len({canonical_json(choice['value']) for choice in choices}) != len(choices):
            raise ProtocolError('invalid_wire_value')
        for index, choice in enumerate(choices):
            _text(choice['description'], 2000, nonblank=True)
            if row['type'] == 'choice':
                _text(choice['value'], 256, nonblank=True)
            if row['type'] == 'integer_levels' and index and choice['value'] <= choices[index - 1]['value']:
                raise ProtocolError('invalid_wire_value')


def verify_decision_model_identity(raw: Any) -> dict[str, Any]:
    value = validate('DecisionModelIdentitySchema', raw)
    # The fixed full-object digest binds every source manifest and asset pin;
    # the declared identity digest must also match the actual canonical content.
    if (value['contentHash'] != DECISION_IDENTITY_CONTENT_HASH or not _content_matches(value)
            or canonical_sha256(value) != DECISION_MODEL_HASH):
        raise ProtocolError('decision_model_identity_mismatch')
    return value


def verify_decision_training_examples(raw: Any, examples_sha256: str | None = None) -> list[dict[str, Any]]:
    _bounded(raw, 8_388_608)
    value = validate('DecisionTrainingExamplesSchema', raw)
    if len({row['id'] for row in value}) != len(value):
        raise ProtocolError('invalid_wire_value')
    for row in value:
        _text(row['id'], 500)
        _scoring_input(row)
        targets = row['targets']
        if len(targets) != len(row['questions']):
            raise ProtocolError('invalid_wire_value')
        for question, target in zip(row['questions'], targets):
            if (target['questionId'] != question['id']
                    or not any(_same_value(choice['value'], target['value']) for choice in question['choices'])):
                raise ProtocolError('invalid_wire_value')
    if len(canonical_json(value).encode('utf-8')) > 8_388_608:
        raise ProtocolError('invalid_wire_value')
    if examples_sha256 is not None and _hash(examples_sha256) != canonical_sha256(value):
        raise ProtocolError('decision_examples_mismatch')
    return value


def decision_reference_input(raw: Any) -> dict[str, Any]:
    """Ordered reference input only: labeled examples must not enter prompts."""
    _bounded(raw, 131_072)
    value = validate('DecisionScoringInputSchema', raw)
    _scoring_input(value)
    schema = {}
    for question in value['questions']:
        def key(choice: dict[str, Any]) -> str:
            item = choice['value']
            return ('true' if item else 'false') if type(item) is bool else str(int(item)) if question['type'] == 'integer_levels' else item
        schema[question['id']] = {
            'type': 'boolean' if question['type'] == 'boolean' else 'enum',
            'description': question['description'],
            'choices': [key(choice) if question['type'] == 'integer_levels' else choice['value'] for choice in question['choices']],
            'choice_descriptions': {key(choice): choice['description'] for choice in question['choices']},
        }
    return {'context': canonical_json(value['state']), 'schema': schema}


def verify_decision_scoring_request(raw: Any) -> dict[str, Any]:
    _bounded(raw, 131_072)
    value = validate('DecisionScoringRequestSchema', raw)
    verify_decision_model_identity(value['model'])
    _scoring_input(value['input'])
    if value['artifact'] is not None:
        _text(value['artifact']['id'], 500)
    return value


def verify_decision_scoring_result(raw: Any, request: dict[str, Any], runtime_hash: str) -> dict[str, Any]:
    """Verify complete T1 scores, not model possession or measured logits."""
    _bounded(raw, 131_072)
    request = verify_decision_scoring_request(request)
    value = validate('DecisionScoringResultSchema', raw)

    def fail() -> None:
        raise ProtocolError('decision_score_mismatch')

    if (not _content_matches(value) or value['requestHash'] != canonical_sha256(request)
            or value['modelHash'] != canonical_sha256(request['model']) or value['runtimeHash'] != _hash(runtime_hash)
            or canonical_json(value['artifact']) != canonical_json(request['artifact'])
            or len(value['distributions']) != len(request['input']['questions'])
            or value['forwardTokenWork'] > request['limits']['maximumForwardTokenWork']
            or value['durationMs'] > request['limits']['maximumDurationSeconds'] * 1000):
        fail()
    prompt_work = 0
    for question, row in zip(request['input']['questions'], value['distributions']):
        candidates = row['candidates']
        if (row['questionId'] != question['id'] or len(candidates) != len(question['choices'])
                or row['promptTokenCount'] > request['limits']['maximumPromptTokens']
                or len({candidate['tokenId'] for candidate in candidates}) != len(candidates)):
            fail()
        maximum = max(candidate['logit'] for candidate in candidates)
        weights = [math.exp(candidate['logit'] - maximum) for candidate in candidates]
        total = 0.0
        for weight in weights:
            total += weight
        best, expected_level, probability_total = 0, 0.0, 0.0
        for index, (candidate, choice) in enumerate(zip(candidates, question['choices'])):
            if (not _same_value(candidate['value'], choice['value']) or candidate['code'] != chr(65 + index)
                    or abs(candidate['probability'] - weights[index] / total) > 1e-8):
                fail()
            if candidate['logit'] > candidates[best]['logit']:
                best = index
            if question['type'] == 'integer_levels':
                expected_level += choice['value'] * candidate['probability']
            probability_total += candidate['probability']
        if (abs(probability_total - 1) > 1e-8
                or not _same_value(row['prediction'], question['choices'][best]['value'])
                or (row['expectedLevel'] is None or abs(row['expectedLevel'] - expected_level) > 1e-8
                    if question['type'] == 'integer_levels' else row['expectedLevel'] is not None)):
            fail()
        prompt_work += row['promptTokenCount']
    if value['forwardTokenWork'] < prompt_work:
        fail()
    return value
