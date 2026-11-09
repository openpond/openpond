"""Exact workspace, operation and candidate binding for remote weight sessions."""
from datetime import datetime, timezone
from .errors import ProtocolError
from .wire import canonical_sha256, validate, verify_hash
from .modification_identity import _spend
from .weight_execution_identity import expectation
from .weight_space_programming import verify_weight_space_request, verify_weight_space_result, verify_weight_space_command_result


def require(value):
    if not value:
        raise ProtocolError('weight_space_session_mismatch')


def prepare(method, body, parameters, team_id, query, expected):
    expectation(expected)
    require(not query or set(query) <= {'teamId'})
    if query.get('teamId', team_id) != team_id:
        require(False)
    query['teamId'] = team_id if method.startswith(('get_', 'list_')) else query.get('teamId', team_id)
    if not method.startswith(('get_', 'list_')):
        query.pop('teamId', None)
    if body is not None:
        require(body.get('teamId', team_id) == team_id)
    if method == 'prepare_weight_space_session':
        request = verify_weight_space_request(body['request'])
        body['maximumSpendUsd'] = _spend(body['maximumSpendUsd'])
        source = body['query']
        require(body['maximumSpendUsd'] is not None and source['teamId'] == team_id and source['source'] == 'managed'
                and source.get('modelAssetId') is None and source['modelId'] == request['model']['modelId']
                and source.get('revision') == request['model']['revision'] and source.get('tokenizerRevision') and source.get('chatTemplateHash'))
    if method in ('start_weight_space_session', 'cancel_weight_space_session'):
        require(body['id'] == parameters['id'] and body['action'] == ('start' if method.startswith('start_') else 'cancel'))
        if body['action'] == 'start':
            body['approvedMaximumSpendUsd'] = _spend(body['approvedMaximumSpendUsd'])
    if method == 'command_weight_space_session':
        require(body['sessionId'] == parameters['sessionId'])
    if method == 'save_weight_space_result_model':
        require(body['executionId'] == parameters['executionId'] and bool(body['modelProjectId']) == (body['expectedModelRevision'] > 0))
    return body


def verify_receipt(value, command):
    execution = value['execution']
    controlling = 'action' in command
    require(value['operationId'] == command['operationId'] and execution['teamId'] == command['teamId']
            and value['requestHash'] == canonical_sha256(command if controlling else {'action': 'prepare', 'command': command}))
    if controlling:
        require(execution['id'] == command['id'] and execution['revision'] == command['expectedRevision']+1
                and execution['plan']['contentHash'] == command['planHash'])
        if command['action'] == 'start':
            require(execution['phase'] == 'queued' and execution['plan']['maximumSpendUsd'] == command['approvedMaximumSpendUsd'])
            price = execution['plan'].get('computePrice')
            require(command.get('approvedPriceHash') == (canonical_sha256(price) if price else None))
        else:
            require(execution['phase'] in ('cancelled', 'stopping'))
    else:
        require(execution['id'] == 'modification-'+canonical_sha256({'teamId': command['teamId'], 'ownerUserId': execution['ownerUserId'], 'operationId': command['operationId']})
                and execution['projectId'] == command['projectId'] and execution['name'] == command['name']
                and execution['revision'] == 1 and execution['phase'] == 'prepared'
                and execution['plan']['inputHash'] == canonical_sha256(command['request']) and execution['plan']['maximumSpendUsd'] == command['maximumSpendUsd'])


def finish(method, schema, value, team_id, parameters, body, expected):
    expected = expectation(expected)
    verify_hash(value, 'contentHash')
    require(value['teamId'] == team_id if 'teamId' in value else value['execution']['teamId'] == team_id)
    actor = expected.get('actorId', expected.get('ownerUserId'))
    if schema == 'WeightSpaceCapabilitySchema':
        require(value['query'] == body and value['requestHash'] == canonical_sha256(body)
                and (actor is None or value['actorId'] == actor)
                and (value['execution']['state'] == 'ready') == (value['validationLevel'] is not None))
        stamp = lambda v: datetime.fromisoformat(v.replace('Z', '+00:00')).timestamp()
        now = datetime.now(timezone.utc).timestamp()
        require(stamp(value['checkedAt']) <= now+30 and stamp(value['expiresAt']) > now
                and 0 < stamp(value['expiresAt'])-stamp(value['checkedAt']) <= 300)
    elif schema == 'WeightSpaceExecutionReceiptSchema':
        verify_receipt(value, body)
        require(actor is None or value['execution']['ownerUserId'] == actor)
    elif schema == 'WeightSpaceExecutionSchema':
        require(value['id'] == parameters['id'] and (actor is None or value['ownerUserId'] == actor)
                and value['plan']['inputHash'] == canonical_sha256(verify_weight_space_request(value['request']))
                and (value['result'] is None) == (value['resultRecordedAt'] is None))
        session, limits = value['session'], value['request']['limits']
        if session is not None:
            require(session['revision'] == session['usage']['commands']+1
                    and session['usage']['commands'] <= limits['maximumCommands'] and session['usage']['candidates'] <= limits['maximumCandidates']
                    and session['usage']['arithmeticWork'] <= limits['maximumArithmeticWork'] and session['usage']['forwardTokenWork'] <= limits['maximumForwardTokenWork']
                    and (session['finalization'] is not None) == (session['phase'] == 'closed')
                    and (session['pendingOperationId'] is not None) == (session['phase'] in ('busy', 'finalizing')))
            final = session['finalization']
            if final is not None:
                command = {'teamId':team_id,'sessionId':value['id'],'operationId':final['operationId'],
                    'expectedRevision':session['revision']-1,'candidateHash':session['candidateHash'],'action':'finalize'}
                require(session['historyHash'] == canonical_sha256({'previous':final['historyHashBefore'],
                    'requestHash':canonical_sha256(command),'resultHash':final['resultHash']}))
        if value['result'] is not None:
            verify_weight_space_result(value['result'], value['request'], value['plan']['runtimeHash'])
            require(session is not None and session['finalization'] is not None and session['finalization']['status'] == 'succeeded'
                    and value['result']['candidateHash'] == session['candidateHash']
                    and value['result']['historyHash'] == session['finalization']['historyHashBefore']
                    and value['result']['commands'] == session['usage']['commands'] and value['result']['candidates'] == session['usage']['candidates']
                    and value['result']['forwardTokenWork'] == session['usage']['forwardTokenWork'])
    elif schema == 'WeightSpaceCommandReceiptSchema':
        command = body if body is not None else value['command']
        require(value['command'] == command and value['requestHash'] == canonical_sha256(command)
                and (value['state'] == 'completed') == (value['result'] is not None)
                and (actor is None or value['ownerUserId'] == actor)
                and command['sessionId'] == parameters['sessionId'])
        if body is None:
            require(command['operationId'] == parameters['operationId'])
        if value['result'] is not None:
            verify_weight_space_command_result(value['result'], command)
    elif schema == 'WeightSpaceCommandPageSchema':
        require(value['sessionId'] == parameters['sessionId'] and value['query'] == body
                and len(value['items']) <= body['limit'] and (actor is None or value['ownerUserId'] == actor))
        revision, seen = body['afterRevision'], set()
        for row in value['items']:
            command = row['command']
            verify_hash(row, 'contentHash')
            require(row['teamId'] == team_id and row['ownerUserId'] == value['ownerUserId']
                    and command['sessionId'] == value['sessionId'] and command['operationId'] not in seen
                    and command['expectedRevision'] > revision and row['requestHash'] == canonical_sha256(command)
                    and (row['state'] == 'completed') == (row['result'] is not None))
            if row['result'] is not None:
                verify_weight_space_command_result(row['result'], command)
            seen.add(command['operationId'])
            revision = command['expectedRevision']
        require(value['nextAfterRevision'] is None or (len(value['items']) == body['limit'] and value['nextAfterRevision'] == revision))
    elif schema == 'WeightSpaceExecutionPageSchema':
        require(value['query'] == body and len(value['items']) <= body['limit']
                and (actor is None or value['ownerUserId'] == actor)
                and len({row['id'] for row in value['items']}) == len(value['items']))
        for row in value['items']:
            require(row['teamId'] == team_id and row['ownerUserId'] == value['ownerUserId']
                    and all(row[key] == body[key] for key in ('projectId', 'id', 'phase') if key in body))
        require(value['nextCursor'] is None or value['nextCursor'] != body.get('cursor'))
    elif schema == 'WeightSpaceResultSaveReceiptSchema':
        from .weight_model_identity import verify_weight_result_save
        verify_weight_result_save(value, body, actor_id=actor)
    elif schema == 'WeightSpaceModelServingSchema':
        from .weight_serving_identity import verify_weight_model_serving
        verify_weight_model_serving(value, team_id, parameters['modelProjectId'], body['versionHash'], owner_user_id=actor)
    elif schema == 'WeightSpaceModelServingControlReceiptSchema':
        from .weight_serving_identity import verify_weight_serving_control
        verify_weight_serving_control(value, body, team_id, parameters['modelProjectId'], actor_id=actor)
    else:
        require(False)
    return value
