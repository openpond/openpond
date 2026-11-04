"""Scoped runtime capability observations; never execution admission."""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Any
from decimal import Decimal, InvalidOperation
from .errors import ProtocolError
from .wire import canonical_sha256, verify_hash


def verify_runtime_validation_level(execution: dict[str, Any], validation_level: str | None) -> None:
    if ((execution['state'] == 'ready') != (validation_level is not None)
            or validation_level not in (None, 'source_validated', 'gpu_qualified')):
        raise ProtocolError('model_modification_validation_mismatch')


def _spend(value: str) -> str:
    try:
        amount = Decimal(value)
        if not amount.is_finite() or not 0 < amount <= 1_000_000:
            raise ProtocolError('managed_modification_cap_invalid')
    except (InvalidOperation, ValueError, TypeError):
        raise ProtocolError('managed_modification_cap_invalid') from None
    return format(amount, '.6f')


def prepare_managed_modification(value: dict[str, Any]) -> dict[str, Any]:
    from .neuron_steering import verify_activation_request
    from .wire import canonical_json
    if 'action' in value:
        if value['action'] == 'start':value['approvedMaximumSpendUsd'] = _spend(value['approvedMaximumSpendUsd'])
        return value
    value['maximumSpendUsd'] = _spend(value['maximumSpendUsd'])
    request = verify_activation_request(value['request'])
    if value.get('sourceForm') is not None:
        prepare_managed_compilation({'teamId': value['teamId'], 'projectId': value['projectId'],
            'method': value['method'], 'query': value['query'], 'form': value['sourceForm']})
        _verify_source_form(value['sourceForm'], request, value['maximumSpendUsd'])
    if request.get('startingProfile') is not None and value['method'] != 'neuron_steering':
        raise ProtocolError('managed_modification_saved_source_unsupported')
    profiles = sum(row['profile'] is not None for row in request['variants'])
    if (value['query']['teamId'] != value['teamId'] or value['query']['modelId'] != request['model']['modelId']
            or value['query'].get('revision') != request['model']['revision']
            or (profiles > 0 if value['method'] == 'inspect_activations' else profiles == 0 or profiles == len(request['variants']))):
        raise ProtocolError('managed_modification_input_invalid')
    if len(canonical_json(value).encode('utf-8')) > 1_048_576:
        raise ProtocolError('managed_modification_input_too_large')
    return value


def verify_managed_modification_receipt(value: dict[str, Any], command: dict[str, Any], team_id: str) -> None:
    verify_hash(value, 'contentHash')
    command = prepare_managed_modification(command)
    execution = value['execution']; plan = execution['plan']; preparing = 'action' not in command
    requested = {'action': 'prepare', 'command': command} if preparing else command
    created = datetime.fromisoformat(plan['createdAt'].replace('Z', '+00:00')).timestamp()
    expires = datetime.fromisoformat(plan['expiresAt'].replace('Z', '+00:00')).timestamp()
    if (value['operationId'] != command['operationId'] or value['requestHash'] != canonical_sha256(requested)
            or execution['teamId'] != team_id or execution['teamId'] != command['teamId']
            or expires <= created or plan['maximumSpendUsd'] != _spend(plan['maximumSpendUsd'])):
        raise ProtocolError('managed_modification_receipt_mismatch')
    if preparing:
        identity = 'modification-' + canonical_sha256({'teamId': team_id, 'ownerUserId': execution['ownerUserId'], 'operationId': command['operationId']})
        if (execution['id'] != identity or execution['projectId'] != command['projectId'] or execution['name'] != command['name']
                or execution['method'] != command['method'] or execution['phase'] != 'prepared' or execution['revision'] != 1
                or plan['inputHash'] != canonical_sha256(command['request']) or plan['maximumSpendUsd'] != command['maximumSpendUsd']):
            raise ProtocolError('managed_modification_receipt_mismatch')
    elif (execution['id'] != command['id'] or execution['revision'] != command['expectedRevision'] + 1
            or plan['contentHash'] != command['planHash']
            or (execution['phase'] != 'queued' or plan['maximumSpendUsd'] != command['approvedMaximumSpendUsd']
                if command['action'] == 'start' else execution['phase'] not in ('cancelled', 'stopping'))):
        raise ProtocolError('managed_modification_receipt_mismatch')


def verify_modification_capabilities(value: dict[str, Any], query: dict[str, Any], team_id: str, expected_actor_id: str | None = None) -> None:
    verify_hash(value, 'contentHash')
    if (value['teamId'] != team_id or value['query'] != query or value['requestHash'] != canonical_sha256(query)
            or expected_actor_id is not None and value['actorId'] != expected_actor_id):
        raise ProtocolError('model_modification_capability_mismatch')
    if {row['method'] for row in value['methods']} != {'neuron_steering', 'inspect_activations'}:
        raise ProtocolError('model_modification_capability_mismatch')
    for row in value['methods']:
        execution = row['execution']
        verify_runtime_validation_level(execution, row['validationLevel'])
        if execution['state'] == 'ready' and (query['source'] != 'managed' or query.get('modelAssetId') is not None
                or execution['model']['modelId'] != query['modelId'] or execution['model']['revision'] != query.get('revision')
                or not query.get('tokenizerRevision')):
            raise ProtocolError('model_modification_capability_mismatch')
    checked = datetime.fromisoformat(value['checkedAt'].replace('Z', '+00:00')).timestamp()
    expiry = datetime.fromisoformat(value['expiresAt'].replace('Z', '+00:00')).timestamp()
    now = datetime.now(timezone.utc).timestamp()
    if checked > now + 30 or expiry <= now or expiry <= checked or expiry - checked > 300:
        raise ProtocolError('model_modification_capability_expired')


def verify_managed_modification_execution(value: dict[str, Any], team_id: str, execution_id: str) -> None:
    from .neuron_steering import verify_activation_request, verify_activation_result
    verify_hash(value, 'contentHash')
    request = verify_activation_request(value['request'])
    plan = value['plan']
    if value.get('sourceForm') is not None:
        _verify_source_form(value['sourceForm'], request, plan['maximumSpendUsd'])
    if request.get('startingProfile') is not None and value['method'] != 'neuron_steering':
        raise ProtocolError('managed_modification_saved_source_unsupported')
    profiles = sum(row['profile'] is not None for row in request['variants'])
    created = datetime.fromisoformat(plan['createdAt'].replace('Z', '+00:00')).timestamp()
    expires = datetime.fromisoformat(plan['expiresAt'].replace('Z', '+00:00')).timestamp()
    if (value['teamId'] != team_id or value['id'] != execution_id
            or plan['inputHash'] != canonical_sha256(request)
            or (profiles > 0 if value['method'] == 'inspect_activations' else profiles == 0 or profiles == len(request['variants']))
            or not 0 < float(plan['maximumSpendUsd']) <= 1_000_000
            or (value['result'] is not None) != (value['resultRecordedAt'] is not None)
            or expires <= created):
        raise ProtocolError('managed_modification_execution_mismatch')
    if value['result'] is not None:
        verify_activation_result(value['result'], request)


def _verify_source_form(form: dict[str, Any], request: dict[str, Any], cap: str) -> None:
    reference = request.get('startingProfile')
    pin = {key: value for key, value in reference.items() if key != 'variantId'} if reference is not None else None
    if form.get('startingProfile') != pin:
        raise ProtocolError('managed_modification_authoring_mismatch')
    source = form.get('baseModel')
    if (not source or source['modelId'] != request['model']['modelId']
            or source.get('revision') != request['model']['revision']
            or not form.get('maximumSpendUsd') or _spend(form['maximumSpendUsd']) != _spend(cap)):
        raise ProtocolError('managed_modification_authoring_mismatch')


def prepare_managed_compilation(value: dict[str, Any]) -> dict[str, Any]:
    from .wire import canonical_json
    query = value['query']
    if value['form'].get('startingProfile') is not None and value['method'] != 'neuron_steering':
        raise ProtocolError('managed_modification_saved_source_unsupported')
    source = {'schemaVersion': 'openpond.baseModelPreference.v1', 'modelId': query['modelId'], 'source': query['source'],
        **{key: query.get(key) for key in ('revision', 'tokenizerRevision', 'chatTemplateHash', 'modelAssetId')}}
    if query['teamId'] != value['teamId'] or value['form']['baseModel'] != source:
        raise ProtocolError('managed_modification_compile_scope_mismatch')
    if len(canonical_json(value).encode('utf-8')) > 1_048_576:
        raise ProtocolError('managed_modification_compile_too_large')
    return value


def verify_managed_compilation(value: dict[str, Any], command: dict[str, Any], team_id: str) -> None:
    from .neuron_steering import verify_activation_request
    prepare_managed_compilation(command)
    verify_hash(value, 'contentHash')
    request = verify_activation_request(value['request'])
    reference = request.get('startingProfile')
    pin = {key: item for key, item in reference.items() if key != 'variantId'} if reference is not None else None
    if command['form'].get('startingProfile') != pin:
        raise ProtocolError('managed_modification_compilation_mismatch')
    profiles = sum(row['profile'] is not None for row in request['variants'])
    if (value['teamId'] != team_id or value['teamId'] != command['teamId'] or value['projectId'] != command['projectId']
            or value['method'] != command['method'] or value['query'] != command['query']
            or value['formHash'] != canonical_sha256(command['form']) or value['inputHash'] != canonical_sha256(request)
            or request['model']['modelId'] != command['query']['modelId'] or request['model']['revision'] != command['query'].get('revision')
            or (profiles > 0 if command['method'] == 'inspect_activations' else profiles == 0 or profiles == len(request['variants']))):
        raise ProtocolError('managed_modification_compilation_mismatch')


def verify_managed_modification_page(value: dict[str, Any], query: dict[str, Any], team_id: str) -> None:
    """Verify scope and filter identity before a caller uses canonical history."""
    verify_hash(value, 'contentHash')
    query = {'limit': 25, **query}
    items = value['items']
    if (value['teamId'] != team_id or value['query'] != query or len(items) > query['limit']
            or len({item['id'] for item in items}) != len(items)
            or value['nextCursor'] is not None and (len(items) != query['limit'] or value['nextCursor'] == query.get('cursor'))):
        raise ProtocolError('managed_modification_history_mismatch')
    previous: tuple[float, str] | None = None
    for item in items:
        created = datetime.fromisoformat(item['plan']['createdAt'].replace('Z', '+00:00')).timestamp()
        expires = datetime.fromisoformat(item['plan']['expiresAt'].replace('Z', '+00:00')).timestamp()
        order = (created, item['id'])
        if (item['teamId'] != team_id or item['ownerUserId'] != value['ownerUserId']
                or any(item[key] != query[key] for key in ('id', 'projectId', 'method', 'phase') if key in query)
                or item['plan']['maximumSpendUsd'] != _spend(item['plan']['maximumSpendUsd'])
                or expires <= created or previous is not None and previous <= order):
            raise ProtocolError('managed_modification_history_mismatch')
        previous = order
