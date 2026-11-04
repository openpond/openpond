"""Engram execution and saved Model identity, shared by sync/async clients."""
from datetime import datetime, timezone
import math
import re
from .modification_identity import verify_runtime_validation_level
from .engram_adapter import verify_engram_request, verify_engram_artifact, verify_engram_result
from .errors import ProtocolError
from .modification_identity import _spend
from .wire import canonical_json, canonical_sha256, validate, verify_hash, _JS_SPACE


def fail():
    raise ProtocolError('engram_execution_mismatch')


def stamp(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def number(value):
    text = value.strip(_JS_SPACE)
    if re.fullmatch(r'0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+', text):
        return int(text, 0)
    if not re.fullmatch(r'[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?', text):
        fail()
    result = float(text)
    if not math.isfinite(result):
        fail()
    return int(result) if result.is_integer() else result


def source(query, request):
    if (query['source'] != 'managed' or 'modelAssetId' in query or not query.get('revision')
            or not query.get('tokenizerRevision') or query['modelId'] != request['model']['modelId']
            or query['revision'] != request['model']['revision']):
        fail()


def form_query(form, query):
    base = {'schemaVersion': 'openpond.baseModelPreference.v1', 'modelId': query['modelId'], 'source': query['source'],
            **{key: query.get(key) for key in ('revision', 'tokenizerRevision', 'chatTemplateHash', 'modelAssetId')}}
    if form['baseModel'] != base:
        fail()


def form_request(form, request):
    training = validate('EngramTrainingSettingsSchema', {key: number(value) for key, value in form['training'].items()})
    selected = form.get('startingModule')
    if selected is not None and (selected['artifact'] != request['parentArtifact'] or selected['modelHash'] != canonical_sha256(request['model'])):
        fail()
    if (not form['baseModel'] or form['baseModel']['modelId'] != request['model']['modelId']
            or form['baseModel']['revision'] != request['model']['revision'] or form['batch'] != request['data']['batch']
            or training != request['training'] or form['parentArtifact'] != request['parentArtifact']):
        fail()


def prepare(method, value):
    if method == 'compile_engram_execution':
        if value['query']['teamId'] != value['teamId']:
            fail()
        form_query(value['form'], value['query'])
    elif method == 'prepare_engram_execution':
        request = verify_engram_request(value['request'])
        value['maximumSpendUsd'] = _spend(value['maximumSpendUsd'])
        source(value['query'], request)
        if value['query']['teamId'] != value['teamId']:
            fail()
        if 'sourceForm' in value:
            form_request(value['sourceForm'], request)
            form_query(value['sourceForm'], value['query'])
            if _spend(value['sourceForm']['maximumSpendUsd']) != value['maximumSpendUsd']:
                fail()
    elif method == 'start_engram_execution':
        value['approvedMaximumSpendUsd'] = _spend(value['approvedMaximumSpendUsd'])
    return value


def version(value, team_id, model_id=None, owner_id=None):
    verify_hash(value, 'contentHash')
    manifest = verify_engram_artifact(value['artifact']['manifest'])
    files = value['artifact']['files']
    metadata = next((row for row in files if row['path'] == 'manifest.json'), None)
    tensor = next((row for row in files if row['path'] == 'adapter.safetensors'), None)
    if (value['teamId'] != team_id or model_id is not None and value['modelProjectId'] != model_id
            or owner_id is not None and value['ownerUserId'] != owner_id
            or value['baseModel']['modelId'] != manifest['pins']['baseModel']['modelId']
            or value['baseModel']['revision'] != manifest['pins']['baseModel']['revision']
            or value['source']['runtimeHash'] != manifest['pins']['runtimeHash']
            or value['artifact']['contentHash'] != manifest['contentHash'] or not metadata or not tensor
            or metadata['sha256'] != canonical_sha256(manifest)
            or metadata['sizeBytes'] != len(canonical_json(manifest).encode('utf-8'))
            or tensor['sha256'] != manifest['payload']['sha256'] or tensor['sizeBytes'] != manifest['payload']['sizeBytes']
            or any(row['artifactId'] != value['artifact']['id'] for row in files)):
        fail()


def finish(schema, value, team_id, parameters, command):
    verify_hash(value, 'contentHash')
    if 'teamId' in value and value['teamId'] != team_id:
        fail()
    if schema == 'EngramExecutionCapabilitySchema':
        verify_runtime_validation_level(value['execution'], value['validationLevel'])
        checked, expires, now = stamp(value['checkedAt']), stamp(value['expiresAt']), datetime.now(timezone.utc).timestamp()
        if (value['query'] != command or value['requestHash'] != canonical_sha256(command)
                or checked > now + 30 or expires <= now or expires <= checked or expires - checked > 300):
            fail()
        if value['execution']['state'] == 'ready':
            source(command, {'model': value['execution']['model']})
    elif schema == 'ManagedEngramCompilationSchema':
        request = verify_engram_request(value['request'])
        source(command['query'], request)
        form_request(command['form'], request)
        form_query(command['form'], command['query'])
        if (value['projectId'] != command['projectId'] or value['query'] != command['query']
                or command['query']['teamId'] != team_id or value['formHash'] != canonical_sha256(command['form'])
                or value['inputHash'] != canonical_sha256(request)):
            fail()
    elif schema == 'ManagedEngramExecutionSchema':
        request = verify_engram_request(value['request'])
        if (value['id'] != parameters['id'] or value['plan']['inputHash'] != canonical_sha256(request)
                or (value['result'] is None) != (value['resultRecordedAt'] is None)):
            fail()
        if 'sourceForm' in value:
            form_request(value['sourceForm'], request)
        if value['result'] is not None:
            verify_engram_result(value['result'], request, value['plan']['runtimeHash'])
    elif schema == 'ManagedEngramExecutionReceiptSchema':
        preparing = 'action' not in command
        prepare('prepare_engram_execution' if preparing else command['action'] + '_engram_execution', command)
        execution, plan = value['execution'], value['execution']['plan']
        hashed = {'action': 'prepare', 'command': command} if preparing else command
        if (value['operationId'] != command['operationId'] or value['requestHash'] != canonical_sha256(hashed)
                or execution['teamId'] != team_id or stamp(plan['expiresAt']) <= stamp(plan['createdAt'])
                or plan['maximumSpendUsd'] != _spend(plan['maximumSpendUsd'])):
            fail()
        if preparing:
            identity = 'modification-' + canonical_sha256({'teamId': team_id, 'ownerUserId': execution['ownerUserId'], 'operationId': command['operationId']})
            if (execution['id'] != identity or execution['projectId'] != command['projectId'] or execution['name'] != command['name']
                    or plan['inputHash'] != canonical_sha256(command['request']) or plan['maximumSpendUsd'] != command['maximumSpendUsd']
                    or execution['phase'] != 'prepared' or execution['revision'] != 1):
                fail()
        elif (execution['id'] != command['id'] or plan['contentHash'] != command['planHash']
                or execution['revision'] != command['expectedRevision'] + 1
                or (execution['phase'] != 'queued' or plan['maximumSpendUsd'] != command['approvedMaximumSpendUsd']
                    if command['action'] == 'start' else execution['phase'] not in ('cancelled', 'stopping'))):
            fail()
    elif schema == 'ManagedEngramExecutionPageSchema':
        query = {'method': 'engram_adapter', 'limit': 25, **command}
        if value['query'] != query or len(value['items']) > query['limit'] or len({row['id'] for row in value['items']}) != len(value['items']):
            fail()
        for row in value['items']:
            if (row['teamId'] != team_id or row['ownerUserId'] != value['ownerUserId']
                    or any(row[key] != query[key] for key in ('id', 'projectId', 'phase') if key in query)
                    or row['plan']['maximumSpendUsd'] != _spend(row['plan']['maximumSpendUsd'])
                    or stamp(row['plan']['expiresAt']) <= stamp(row['plan']['createdAt'])):
                fail()
    elif schema == 'EngramResultSaveReceiptSchema':
        model, saved = value['model'], value['version']
        version(saved, team_id, model['id'], value['actorId'])
        if (value['operationId'] != command['operationId'] or value['requestHash'] != canonical_sha256(command)
                or model['teamId'] != team_id or saved['source']['executionId'] != command['executionId']
                or saved['source']['resultHash'] != command['resultHash'] or saved['artifact']['contentHash'] != command['artifactHash']
                or model['name'] != command['name'] or model['revision'] != command['expectedModelRevision'] + 1
                or command['modelProjectId'] is not None and model['id'] != command['modelProjectId']
                or saved['portableProjectId'] != model['portableProjectId']):
            fail()


def verify_engram_model_version(raw, *, team_id=None, model_project_id=None, owner_user_id=None):
    value = validate('EngramModelVersionSchema', raw)
    version(value, team_id or value['teamId'], model_project_id, owner_user_id)
    return value


def experiment_starting_model_from_engram_version(raw, *, label, team_id=None):
    """Compact exact authoring pin; it grants no execution/serving authority."""
    value = verify_engram_model_version(raw, team_id=team_id)
    return validate('ExperimentStartingModelSchema', {
        'source': 'engram', 'label': label, 'inferenceModelId': None, 'baseModel': value['baseModel'],
        'engram': {'modelProjectId': value['modelProjectId'], 'versionHash': value['contentHash'],
            'artifact': {'id': value['artifact']['id'], 'contentHash': value['artifact']['contentHash']},
            'modelHash': canonical_sha256(value['artifact']['manifest']['pins']['baseModel'])},
    })


def engram_form_from_model_version(form, raw, *, team_id=None):
    current = validate('EngramExperimentFormDraftSchema', form)
    value = verify_engram_model_version(raw, team_id=team_id)
    source_pin = experiment_starting_model_from_engram_version(value, label='Engram', team_id=team_id)['engram']
    return validate('EngramExperimentFormDraftSchema', {**current, 'baseModel': value['baseModel'],
        'parentArtifact': source_pin['artifact'], 'startingModule': source_pin})
