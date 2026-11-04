"""Decision train/score lifecycle parity for the existing sync/async transport."""
from datetime import datetime, timezone
import json
import re
from typing import Any, TypedDict
from typing_extensions import NotRequired
from .modification_identity import verify_runtime_validation_level
from .decision_identity import _bounded, _same_value, _text, _scoring_input, verify_decision_model_identity, verify_decision_scoring_request, verify_decision_scoring_result
from .decision_identity_training import verify_decision_training_request, verify_decision_training_result
from .engram_identity import number
from .errors import ProtocolError
from .modification_identity import _spend
from .wire import canonical_json, canonical_sha256, validate, verify_hash, _JS_SPACE


class DecisionRoutingBindingExpectation(TypedDict):
    id: str
    revision: int


class DecisionScoreAdmissionExpectation(TypedDict):
    poolId: str
    routingBinding: DecisionRoutingBindingExpectation
    runtimeHash: str
    workerImageDigest: str
    engineGeneration: NotRequired[int]
    cacheNamespace: NotRequired[str]


class DecisionOperationExpectation(TypedDict, total=False):
    ownerUserId: str
    actorId: str
    admission: DecisionScoreAdmissionExpectation


def prepare_decision_expectation(method: str, expected: Any) -> DecisionOperationExpectation:
    if expected is None:
        return {}
    if type(expected) is not dict or set(expected) - {'ownerUserId', 'actorId', 'admission'}:
        fail()
    for key in ('ownerUserId', 'actorId'):
        if key in expected:
            if type(expected[key]) is not str:
                fail()
            _text(expected[key], 240, nonblank=True)
    if 'admission' in expected:
        if method != 'score_decision_model':
            fail()
        admission = expected['admission']
        required = {'poolId', 'routingBinding', 'runtimeHash', 'workerImageDigest'}
        if (type(admission) is not dict or not required <= set(admission)
                or set(admission) - required - {'engineGeneration', 'cacheNamespace'}):
            fail()
        if type(admission['poolId']) is not str:
            fail()
        _text(admission['poolId'], 240, nonblank=True)
        binding = admission['routingBinding']
        if (type(binding) is not dict or set(binding) != {'id', 'revision'} or type(binding['id']) is not str
                or type(binding['revision']) is not int or not 0 < binding['revision'] <= 9_007_199_254_740_991
                or type(admission['runtimeHash']) is not str or re.fullmatch(r'[a-f0-9]{64}', admission['runtimeHash']) is None
                or type(admission['workerImageDigest']) is not str or re.fullmatch(r'sha256:[a-f0-9]{64}', admission['workerImageDigest']) is None
                or 'engineGeneration' in admission and (type(admission['engineGeneration']) is not int or not 0 < admission['engineGeneration'] <= 9_007_199_254_740_991)
                or 'cacheNamespace' in admission and (type(admission['cacheNamespace']) is not str or re.fullmatch(r'[a-f0-9]{64}', admission['cacheNamespace']) is None)):
            fail()
        _text(binding['id'], 240, nonblank=True)
    return expected


def fail() -> None:
    raise ProtocolError('decision_execution_mismatch')


def _stamp(value: str) -> int:
    # Date.parse compares integral milliseconds, ignoring submillisecond ISO
    # precision. Integer timedelta arithmetic avoids binary-float rounding.
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    delta = parsed - datetime(1970, 1, 1, tzinfo=timezone.utc)
    return delta.days * 86_400_000 + delta.seconds * 1000 + delta.microseconds // 1000


def _number(value: str) -> int | float:
    if not value.strip(_JS_SPACE):
        raise ProtocolError('decision_settings_missing')
    try:
        return number(value)
    except ProtocolError:
        fail()


def _cap(value: str) -> str:
    if type(value) is not str or len(value) > 48 or re.fullmatch(r'(0|[1-9][0-9]*)(\.[0-9]{1,6})?', value) is None:
        raise ProtocolError('managed_modification_cap_invalid')
    return _spend(value)


def _mode(request: dict[str, Any]) -> str:
    return 'train' if request['schemaVersion'] == 'openpond.decisionTrainingRequest.v1' else 'score'


def _request(raw: Any) -> dict[str, Any]:
    value = validate('DecisionExecutionRequestSchema', raw)
    return verify_decision_training_request(value) if _mode(value) == 'train' else verify_decision_scoring_request(value)


def _source(query: dict[str, Any], model: dict[str, Any]) -> None:
    source = {'schemaVersion': 'openpond.baseModelPreference.v1', 'modelId': query['modelId'], 'source': query['source'],
              **{key: query.get(key) for key in ('revision', 'tokenizerRevision', 'chatTemplateHash', 'modelAssetId')}}
    if not _same_value(source, model['source']):
        fail()


def parse_decision_form_training(raw: Any) -> dict[str, Any]:
    value = validate('DecisionTrainingFormDraftSchema', raw)
    return validate('DecisionTrainingSettingsSchema', {key: _number(item) for key, item in value.items()})


def parse_decision_form_scoring(raw: Any) -> dict[str, Any]:
    form = validate('DecisionExperimentFormDraftSchema', raw)
    if form['mode'] != 'score':
        fail()
    _text(form['stateJson'], 131_072)
    if len(form['stateJson'].encode('utf-16-le', 'surrogatepass').decode('utf-16-le', 'replace').encode('utf-8')) > 131_072:
        raise ProtocolError('response_too_large')
    try:
        # JSON.parse uses ECMAScript numbers, including when authored as integers.
        state = json.loads(form['stateJson'], parse_int=float, parse_float=float,
                           parse_constant=lambda _: fail())
    except (ValueError, OverflowError, RecursionError):
        fail()
    questions = []
    for row in form['questions']:
        choices = []
        for choice in row['choices']:
            value = choice['value']
            if row['type'] == 'boolean':
                if value not in ('false', 'true'):
                    fail()
                value = value == 'true'
            elif row['type'] == 'integer_levels':
                if re.fullmatch(r'-?(0|[1-9][0-9]*)', value) is None:
                    fail()
                value = int(value)
            choices.append({**choice, 'value': value})
        questions.append({**row, 'choices': choices})
    scoring = validate('DecisionScoringInputSchema', {'state': state, 'questions': questions})
    _scoring_input(scoring)
    limits = {key: _number(value) for key, value in form['limits'].items()}
    # This nested schema has no separate exported wire name. Mirror its three
    # bounds directly without supplying an invented model to a full request.
    if (type(limits['maximumPromptTokens']) is not int or not 1 <= limits['maximumPromptTokens'] <= 2048
            or type(limits['maximumForwardTokenWork']) is not int or not 1 <= limits['maximumForwardTokenWork'] <= 65_536
            or not 0 < limits['maximumDurationSeconds'] <= 300):
        fail()
    return {'input': scoring, 'limits': limits}


def _form(form: dict[str, Any], request: dict[str, Any]) -> None:
    parent = request['parentArtifact'] if _mode(request) == 'train' else request['artifact']
    if (form['mode'] != _mode(request) or not _same_value(form['baseModel'], request['model']['source'])
            or not _same_value(form['parentArtifact'], parent)):
        fail()
    pin = form.get('startingDecision')
    if pin is not None and (not _same_value(pin['artifact'], parent) or pin['modelHash'] != canonical_sha256(request['model'])):
        fail()
    if form['mode'] == 'train':
        if not _same_value(form['batch'], request['data']['batch']) or not _same_value(parse_decision_form_training(form['training']), request['training']):
            fail()
    else:
        scoring = parse_decision_form_scoring(form)
        if not _same_value(scoring['input'], request['input']) or not _same_value(scoring['limits'], request['limits']):
            fail()


def _plan(value: dict[str, Any]) -> None:
    plan = value['plan']
    if plan['maximumSpendUsd'] != _cap(plan['maximumSpendUsd']) or _stamp(plan['expiresAt']) <= _stamp(plan['createdAt']):
        fail()


def prepare_decision_operation(method: str, value: dict[str, Any]) -> dict[str, Any]:
    for key in ('teamId', 'operationId', 'projectId', 'id'):
        if value.get(key) is not None:
            _text(value[key], 240, nonblank=True)
    if method == 'compile_decision_execution':
        _bounded(value, 1_048_576)
        form, query = value['form'], value['query']
        _text(form['name'], 500)
        source = {'schemaVersion': 'openpond.baseModelPreference.v1', 'modelId': query['modelId'], 'source': query['source'],
                  **{key: query.get(key) for key in ('revision', 'tokenizerRevision', 'chatTemplateHash', 'modelAssetId')}}
        if query['teamId'] != value['teamId'] or value['mode'] != form['mode'] or not _same_value(form['baseModel'], source) or not form['name'].strip(_JS_SPACE):
            fail()
        _cap(form['maximumSpendUsd'])
        if form['mode'] == 'train':
            if form['batch'] is None:
                fail()
            parse_decision_form_training(form['training'])
        else:
            parse_decision_form_scoring(form)
    elif method == 'prepare_decision_execution':
        _bounded(value, 1_048_576)
        request = _request(value['request'])
        value['maximumSpendUsd'] = _cap(value['maximumSpendUsd'])
        if value['query']['teamId'] != value['teamId'] or value['mode'] != _mode(request):
            fail()
        _source(value['query'], request['model'])
        if 'sourceForm' in value:
            form = value['sourceForm']
            _form(form, request)
            if form['name'].strip(_JS_SPACE) != value['name'] or _cap(form['maximumSpendUsd']) != value['maximumSpendUsd']:
                fail()
    elif method == 'start_decision_execution':
        value['approvedMaximumSpendUsd'] = _cap(value['approvedMaximumSpendUsd'])
    return value


def verify_decision_execution_capability(raw: Any, query: Any, *, actor_id: str | None = None) -> dict[str, Any]:
    query = validate('ModelModificationCapabilitiesQuerySchema', query)
    value = validate('DecisionExecutionCapabilitySchema', raw)
    verify_runtime_validation_level(value['execution'], value['validationLevel'])
    verify_hash(value, 'contentHash')
    checked, expiry, now = _stamp(value['checkedAt']), _stamp(value['expiresAt']), _stamp(datetime.now(timezone.utc).isoformat())
    if (value['teamId'] != query['teamId'] or actor_id is not None and value['actorId'] != actor_id
            or not _same_value(value['query'], query) or value['requestHash'] != canonical_sha256(query)
            or checked > now + 30_000 or expiry <= now or expiry <= checked or expiry - checked > 300_000):
        fail()
    if value['execution']['state'] == 'ready':
        verify_decision_model_identity(value['execution']['model'])
        _source(query, value['execution']['model'])
    return value


def verify_decision_execution_capability_request(raw: Any, request: Any) -> dict[str, Any]:
    parsed = validate('DecisionExecutionCapabilitySchema', raw)
    capability = verify_decision_execution_capability(parsed, parsed['query'], actor_id=parsed['actorId'])
    request = _request(request)
    execution = capability['execution']
    if execution['state'] != 'ready':
        raise ProtocolError('decision_runtime_unavailable')
    if not _same_value(execution['model'], request['model']):
        fail()
    if _mode(request) == 'train':
        settings, limits = request['training'], execution['limits']['train']
        if (any(settings[key] > limits[bound] for key, bound in (
                ('maxSteps', 'maximumSteps'), ('gradientAccumulationSteps', 'maximumGradientAccumulationSteps'),
                ('maximumPromptTokens', 'maximumPromptTokens'), ('maxDurationSeconds', 'maximumDurationSeconds'),
                ('maxCheckpointBytes', 'maximumCheckpointBytes')))
                or settings['maxSteps'] * settings['gradientAccumulationSteps'] * settings['maximumPromptTokens'] > limits['maximumForwardTokenWork']):
            fail()
    else:
        limits = execution['limits']['score']
        if (len(request['input']['questions']) > limits['maximumQuestions']
                or any(len(row['choices']) > limits['maximumChoicesPerQuestion'] for row in request['input']['questions'])
                or len(canonical_json(request['input']['state']).encode('utf-8')) > limits['maximumStateBytes']
                or any(request['limits'][key] > limits[key] for key in ('maximumPromptTokens', 'maximumForwardTokenWork', 'maximumDurationSeconds'))):
            fail()
    return execution


def finish_decision_operation(schema: str, value: dict[str, Any], team_id: str, parameters: dict[str, Any], command: Any,
                              expected: DecisionOperationExpectation | None = None) -> None:
    identity = value['execution']['ownerUserId'] if schema == 'ManagedDecisionExecutionReceiptSchema' else value.get('ownerUserId', value.get('actorId'))
    if any(identity != expected[key] for key in ('ownerUserId', 'actorId') if expected and key in expected):
        fail()
    verify_hash(value, 'contentHash')
    if value.get('teamId') != team_id:
        fail()
    if schema == 'DecisionExecutionCapabilitySchema':
        verify_decision_execution_capability(value, command)
    elif schema == 'ManagedDecisionCompilationSchema':
        prepare_decision_operation('compile_decision_execution', command)
        request = _request(value['request'])
        _source(command['query'], request['model'])
        _form(command['form'], request)
        if (value['projectId'] != command['projectId'] or value['mode'] != command['mode'] or value['mode'] != _mode(request)
                or not _same_value(value['query'], command['query']) or value['formHash'] != canonical_sha256(command['form'])
                or value['inputHash'] != canonical_sha256(request)):
            fail()
    elif schema == 'ManagedDecisionExecutionSchema':
        _bounded(value, 1_048_576)
        request = _request(value['request'])
        _plan(value)
        if (value['id'] != parameters['id'] or value['mode'] != _mode(request) or value['plan']['inputHash'] != canonical_sha256(request)
                or (value['result'] is None) != (value['resultRecordedAt'] is None) or value['phase'] == 'completed' and value['result'] is None):
            fail()
        if 'sourceForm' in value:
            _form(value['sourceForm'], request)
            if value['sourceForm']['name'].strip(_JS_SPACE) != value['name'] or _cap(value['sourceForm']['maximumSpendUsd']) != value['plan']['maximumSpendUsd']:
                fail()
        if value['result'] is not None:
            if _mode(request) == 'train':
                verify_decision_training_result(value['result'], request, value['plan']['runtimeHash'])
            else:
                verify_decision_scoring_result(value['result'], request, value['plan']['runtimeHash'])
    elif schema == 'ManagedDecisionExecutionReceiptSchema':
        preparing = 'action' not in command
        prepare_decision_operation('prepare_decision_execution' if preparing else command['action'] + '_decision_execution', command)
        metadata = value['execution']
        _plan(metadata)
        if (value['operationId'] != command['operationId'] or metadata['teamId'] != team_id
                or value['requestHash'] != canonical_sha256({'action': 'prepare', 'command': command} if preparing else command)):
            fail()
        if preparing:
            identity = 'modification-' + canonical_sha256({'teamId': team_id, 'ownerUserId': metadata['ownerUserId'], 'operationId': command['operationId']})
            if (metadata['id'] != identity or metadata['projectId'] != command['projectId'] or metadata['name'] != command['name']
                    or metadata['mode'] != command['mode'] or metadata['plan']['inputHash'] != canonical_sha256(command['request'])
                    or metadata['plan']['maximumSpendUsd'] != command['maximumSpendUsd'] or metadata['phase'] != 'prepared' or metadata['revision'] != 1):
                fail()
        elif (metadata['id'] != command['id'] or metadata['plan']['contentHash'] != command['planHash'] or metadata['revision'] != command['expectedRevision'] + 1
                or (metadata['phase'] != 'queued' or metadata['plan']['maximumSpendUsd'] != command['approvedMaximumSpendUsd']
                    if command['action'] == 'start' else metadata['phase'] not in ('cancelled', 'stopping'))):
            fail()
    elif schema == 'ManagedDecisionExecutionPageSchema':
        query = validate('ManagedDecisionExecutionListQuerySchema', command or {}, request=True)
        items = value['items']
        if (not _same_value(value['query'], query) or len(items) > query['limit'] or len({row['id'] for row in items}) != len(items)
                or value['nextCursor'] is not None and (len(items) != query['limit'] or value['nextCursor'] == query.get('cursor'))):
            fail()
        previous = None
        for row in items:
            _plan(row)
            verify_decision_model_identity(row['model'])
            if (row['teamId'] != team_id or row['ownerUserId'] != value['ownerUserId']
                    or any(row[key] != query[key] for key in ('mode', 'id', 'projectId', 'phase') if key in query)
                    or previous is not None and (_stamp(previous['plan']['createdAt']) < _stamp(row['plan']['createdAt'])
                        or _stamp(previous['plan']['createdAt']) == _stamp(row['plan']['createdAt']) and previous['id'].encode('utf-16-be', 'surrogatepass') <= row['id'].encode('utf-16-be', 'surrogatepass'))):
                fail()
            previous = row
