"""AlphaEdit/selective-neuron lifecycle parity on the existing operation transport."""
from datetime import datetime, timezone
import json
import re
from typing import TypedDict
from .modification_identity import verify_runtime_validation_level
from .alphaedit import verify_alphaedit_request, verify_alphaedit_result
from .neuron_training import verify_neuron_training_request, verify_neuron_training_result
from .engram_identity import number, source, form_query
from .errors import ProtocolError
from .modification_identity import _spend
from .wire import canonical_json, canonical_sha256, validate, verify_hash, _JS_SPACE


class WeightOperationExpectation(TypedDict, total=False):
    ownerUserId: str
    actorId: str


FAMILIES = {
    'alpha_edit': ('AlphaEdit', 'alphaedit', verify_alphaedit_request, verify_alphaedit_result),
    'neuron_training': ('NeuronTraining', 'selective_neuron_training', verify_neuron_training_request, verify_neuron_training_result),
}


def fail():
    raise ProtocolError('weight_execution_mismatch')


def family(method):
    for name, fields in FAMILIES.items():
        if name in method:
            return name, fields
    fail()


def expectation(expected):
    if expected is None:
        return {}
    if type(expected) is not dict or set(expected) - {'ownerUserId', 'actorId'}:
        fail()
    for value in expected.values():
        if type(value) is not str or not 0 < len(value.strip(_JS_SPACE).encode('utf-16-le', 'surrogatepass')) // 2 <= 240:
            fail()
    return expected


def stamp(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def form_request(prefix, form, request):
    training_schema = 'AlphaEditTrainingSettingsSchema' if prefix == 'AlphaEdit' else 'NeuronTrainingSettingsSchema'
    if any(not value.strip(_JS_SPACE) for value in form['training'].values()):
        fail()
    training = validate(training_schema, {key: number(value) for key, value in form['training'].items()})
    if (not form['baseModel'] or form['baseModel']['modelId'] != request['model']['modelId']
            or form['baseModel']['revision'] != request['model']['revision'] or training != request['training']):
        fail()
    if prefix == 'AlphaEdit':
        raw = form['config']
        if (not raw['layers'].strip(_JS_SPACE) or any(re.fullmatch(r'\s*\d+\s*', value) is None for value in raw['layers'].split(','))
                or any(not raw[key].strip(_JS_SPACE) for key in ('lossLayer', 'nullspaceThreshold', 'l2'))):
            fail()
        try:
            contexts = json.loads(raw['contextTemplateGroups'])
        except (ValueError, TypeError):
            fail()
        config = validate('AlphaEditConfigSchema', {
            'schemaVersion': 'openpond.alphaEditConfig.v1', 'implementation': 'openpond_qwen_alphaedit_v1',
            'sourceRevision': 'b84624f44dfe8fc6cd9e41df916c44124a0c46dc',
            'rewriteModule': 'mlp.down_proj.weight', 'factToken': 'subject_last',
            'layers': [number(value) for value in raw['layers'].split(',')], 'lossLayer': number(raw['lossLayer']),
            'contextTemplateGroups': contexts, 'nullspaceThreshold': number(raw['nullspaceThreshold']), 'l2': number(raw['l2']),
            'covariance': 'non_padding_uncentered_second_moment_fp32_v1',
            'projector': 'covariance_svd_below_absolute_threshold_v1',
            'sequentialState': 'post_edit_group_mean_keys_outer_product_sum_v1',
            'targetTokenization': 'leading_space_no_special_tokens_v1'})
        if (form['editsBatch'] != request['data']['edits']['batch']
                or form['preservationBatch'] != request['data']['preservation']['batch']
                or config != request['config'] or form['parentArtifact'] != request['parentArtifact']):
            fail()
        pin = form.get('startingModule')
        if pin is not None and (pin['artifact'] != request['parentArtifact'] or pin['modelHash'] != canonical_sha256(request['model'])):
            fail()
    else:
        raw = form['selection']
        if any(not raw[key].strip(_JS_SPACE) for key in ('count', 'maximumBackgroundTargetRatio', 'gradientExamples')):
            fail()
        lines = raw['coordinates'].strip(_JS_SPACE).splitlines() if raw['coordinates'].strip(_JS_SPACE) else None
        if lines is not None and any(re.fullmatch(r'\s*\d+\s*:\s*\d+\s*', line) is None for line in lines):
            fail()
        selection = validate('NeuronTrainingSelectionSchema', {
            'count': number(raw['count']), 'span': raw['span'], 'backgroundStatistic': raw['backgroundStatistic'],
            'maximumBackgroundTargetRatio': number(raw['maximumBackgroundTargetRatio']), 'gradientExamples': number(raw['gradientExamples']),
            'explicitCoordinates': [dict(zip(('layer', 'neuron'), (number(item) for item in line.split(':')))) for line in lines] if lines else None})
        if (form['targetBatch'] != request['data']['target']['batch']
                or [{'domain': row['domain'].strip(_JS_SPACE), 'batch': row['batch']} for row in form['background']]
                != [{'domain': row['domain'], 'batch': row['batch']} for row in request['data']['background']]
                or form['preservationBatch'] != (request['data']['preservation']['batch'] if request['data']['preservation'] else None)
                or selection != request['selection']):
            fail()
        pin = form.get('inspectionSource')
        if pin is not None and (not request['selection']['explicitCoordinates'] or pin['modelHash'] != canonical_sha256(request['model'])):
            fail()


def prepare(method, value):
    name, (prefix, _, verify_request, _) = family(method)
    if method == 'compile_' + name + '_execution':
        if value['teamId'] != value['query']['teamId']:
            fail()
        form_query(value['form'], value['query'])
    elif method == 'prepare_' + name + '_execution':
        request = verify_request(value['request'])
        value['maximumSpendUsd'] = _spend(value['maximumSpendUsd'])
        source(value['query'], request)
        if value['teamId'] != value['query']['teamId']:
            fail()
        if 'sourceForm' in value:
            form_request(prefix, value['sourceForm'], request)
            form_query(value['sourceForm'], value['query'])
            if _spend(value['sourceForm']['maximumSpendUsd']) != value['maximumSpendUsd']:
                fail()
    elif method == 'start_' + name + '_execution':
        value['approvedMaximumSpendUsd'] = _spend(value['approvedMaximumSpendUsd'])
    return value


def finish(schema, value, team_id, parameters, command, expected=None):
    prefix = 'AlphaEdit' if 'AlphaEdit' in schema else 'NeuronTraining'
    name = 'alpha_edit' if prefix == 'AlphaEdit' else 'neuron_training'
    _, method, verify_request, verify_result = FAMILIES[name]
    expected = expectation(expected)
    verify_hash(value, 'contentHash')
    if 'teamId' in value and value['teamId'] != team_id:
        fail()
    identity = value.get('ownerUserId', value.get('actorId', value.get('execution', {}).get('ownerUserId')))
    if any(identity != expected[key] for key in expected):
        fail()
    if schema == prefix + 'ExecutionCapabilitySchema':
        verify_runtime_validation_level(value['execution'], value['validationLevel'])
        checked, expires = stamp(value['checkedAt']), stamp(value['expiresAt'])
        if (value['query'] != command or value['requestHash'] != canonical_sha256(command)
                or checked > datetime.now(timezone.utc).timestamp() + 30 or expires <= datetime.now(timezone.utc).timestamp()
                or expires <= checked or expires - checked > 300):
            fail()
        if value['execution']['state'] == 'ready':
            source(command, {'model': value['execution']['model']})
    elif schema == 'Managed' + prefix + 'CompilationSchema':
        request = verify_request(value['request'])
        source(command['query'], request)
        form_request(prefix, command['form'], request)
        form_query(command['form'], command['query'])
        if (value['projectId'] != command['projectId'] or value['query'] != command['query']
                or value['formHash'] != canonical_sha256(command['form']) or value['inputHash'] != canonical_sha256(request)):
            fail()
    elif schema == 'Managed' + prefix + 'ExecutionSchema':
        request = verify_request(value['request'])
        if (value['id'] != parameters['id'] or value['plan']['inputHash'] != canonical_sha256(request)
                or (value['result'] is None) != (value['resultRecordedAt'] is None)):
            fail()
        if 'sourceForm' in value:
            form_request(prefix, value['sourceForm'], request)
        if value['result'] is not None:
            verify_result(value['result'], request, value['plan']['runtimeHash'])
    elif schema == 'Managed' + prefix + 'ExecutionReceiptSchema':
        preparing = 'action' not in command
        prepare('prepare_' + name + '_execution' if preparing else command['action'] + '_' + name + '_execution', command)
        execution, plan = value['execution'], value['execution']['plan']
        if (value['operationId'] != command['operationId']
                or value['requestHash'] != canonical_sha256({'action': 'prepare', 'command': command} if preparing else command)
                or execution['teamId'] != team_id or stamp(plan['expiresAt']) <= stamp(plan['createdAt'])
                or plan['maximumSpendUsd'] != _spend(plan['maximumSpendUsd'])):
            fail()
        if preparing:
            execution_id = 'modification-' + canonical_sha256({'teamId': team_id, 'ownerUserId': execution['ownerUserId'], 'operationId': command['operationId']})
            if (execution['id'] != execution_id or execution['projectId'] != command['projectId'] or execution['name'] != command['name']
                    or plan['inputHash'] != canonical_sha256(command['request']) or plan['maximumSpendUsd'] != command['maximumSpendUsd']
                    or execution['phase'] != 'prepared' or execution['revision'] != 1):
                fail()
        elif (execution['id'] != command['id'] or plan['contentHash'] != command['planHash']
                or execution['revision'] != command['expectedRevision'] + 1
                or (execution['phase'] != 'queued' or plan['maximumSpendUsd'] != command['approvedMaximumSpendUsd']
                    if command['action'] == 'start' else execution['phase'] not in ('cancelled', 'stopping'))):
            fail()
    elif schema == 'Managed' + prefix + 'ExecutionPageSchema':
        query = {'method': method, 'limit': 25, **command}
        if value['query'] != query or len(value['items']) > query['limit'] or len({row['id'] for row in value['items']}) != len(value['items']):
            fail()
        for row in value['items']:
            if (row['teamId'] != team_id or row['ownerUserId'] != value['ownerUserId']
                    or any(row[key] != query[key] for key in ('id', 'projectId', 'phase') if key in query)
                    or row['plan']['maximumSpendUsd'] != _spend(row['plan']['maximumSpendUsd'])
                    or stamp(row['plan']['expiresAt']) <= stamp(row['plan']['createdAt'])):
                fail()
