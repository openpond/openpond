"""Shared sync/async operation preparation and identity checks.

Endpoints come from the TypeScript operation inventory. Domain admission remains
server-owned; schema shape validation never advertises a new executable method.
"""
from __future__ import annotations
import copy
import json
import re
from importlib.resources import files
from urllib.parse import quote, urlencode
from typing import Any
from .errors import ProtocolError
from .portable_assets import harness_source
from . import evaluation_identity
from .wire import canonical_sha256, schemas, validate, verify_hash, verify_preparation

MATRIX=json.loads(files('ponder_sdk').joinpath('operation-matrix.json').read_text())
OPERATIONS={row['client']+'.'+row['pythonMethod']:row for row in MATRIX['operations']}


def parse_schema(name: str | None, value: Any, *, request: bool = False) -> Any:
    if name is None: raise ProtocolError('missing_operation_wire_contract')
    if name.endswith('[]'):
        if not isinstance(value,list) or len(value)>100000:raise ProtocolError('invalid_wire_page')
        return [parse_schema(name[:-2],item,request=request) for item in value]
    if '|' in name:
        for branch in name.split('|'):
            try:return parse_schema(branch,value,request=request)
            except ProtocolError:pass
        raise ProtocolError('invalid_wire_union')
    return validate(name,value,request=request)


def scoped(value: Any, team_id: str) -> None:
    if not isinstance(value,dict):return
    for key in ('teamId','scope'):
        if key in value and value[key]!=team_id:raise ProtocolError('workspace_scope_mismatch')
    for key in ('summary','request','run','receipt'):
        if isinstance(value.get(key),dict):scoped(value[key],team_id)


def prepare(key: str, team_id: str, parameters: dict[str,Any], value: Any, query: dict[str,Any] | None, expected: Any = None) -> tuple[dict[str,Any],str,Any,Any,dict[str,Any] | None]:
    operation=OPERATIONS[key]
    if 'verified_missing_hosted_endpoint' in operation.get('availability','') or 'verified_missing_hosted_endpoint' in operation.get('classification','') or operation.get('hostedAvailability')=='unsupported':raise ProtocolError('unsupported_hosted_operation')
    path=operation['path'];body=copy.deepcopy(value);query=copy.deepcopy(query or {})
    for name in re.findall(r'\{(\w+)\}',path):
        item=parameters[name]
        if type(item) not in (str,int) or isinstance(item,bool) or not 0<len(str(item).strip())<=500:raise ProtocolError('invalid_resource_id')
        if name=='action' and item not in ('start','retry','cancel'):raise ProtocolError('invalid_post_training_action')
        if name=='contentHash' and re.fullmatch(r'[a-f0-9]{64}',str(item)) is None:raise ProtocolError('invalid_content_hash')
        path=path.replace('{'+name+'}',quote(str(item).strip(),safe=''))
    if operation['requestSchema'] is not None:
        body=parse_schema(operation['requestSchema'],{} if body is None else body,request=True)
        scoped(body,team_id)
    if operation['client']=='OpenPondLearningClient':
        if operation['pythonMethod'] in ('submit_example','submit_feedback'):
            body={'scope':team_id,'command':{'action':operation['pythonMethod'],'operationId':body['idempotencyKey'],'example' if operation['pythonMethod']=='submit_example' else 'feedback':body}}
        if body is not None:
            if 'scope' in body and body['scope']!=team_id:raise ProtocolError('workspace_scope_mismatch')
            body={**body,'scope':team_id}
    method=operation['pythonMethod'];client=operation['client']
    if client=='createModelProjectsClient' and method=='upsert' and parameters['portableProjectId']!=body['portableProjectId']:raise ProtocolError('operation_target_mismatch')
    if client=='OpenPondDatasetWorkspaceClient' and method=='save' and parameters['id']!=body['workspace']['draft']['id']:raise ProtocolError('operation_target_mismatch')
    if method=='record_candidate_decision' and (parameters['jobId']!=body['jobId'] or parameters['artifactId']!=body['artifact']['id']):raise ProtocolError('operation_target_mismatch')
    if client=='OpenPondLearningClient':
        action={'create_source_credential':'create','list_source_credentials':'list','revoke_source_credential':'revoke','get':'get','list':'list','inspect_evidence':'inspect_evidence','inspect_policy':'inspect_policy','inspect_task_queue':'inspect_task_queue'}.get(method)
        if action is not None and body['action']!=action:raise ProtocolError('operation_action_mismatch')
    if method=='acceptance_group' and expected is not None:
        expected=validate('TrainingAcceptanceGroupReferenceSchema',expected,request=True)
        if expected['id']!=parameters['groupId'] or 'revision' in query and query['revision']!=expected['revision']:raise ProtocolError('acceptance_group_identity_mismatch')
        query['revision']=expected['revision']
    normalized_input=body
    if operation['httpMethod']=='GET' and operation['requestSchema'] is not None:
        for name,item in body.items():
            if name in query:raise ProtocolError('duplicate_query_field')
            query[name]=item
        body=None
    if query:
        if len(query)>20 or any(re.fullmatch(r'[A-Za-z][A-Za-z0-9]*',name) is None or type(item) not in (str,int,bool) for name,item in query.items()):raise ProtocolError('invalid_query')
        if 'limit' in query and (type(query['limit']) is not int or not 1<=query['limit']<=1000):raise ProtocolError('invalid_page_size')
        path+='?'+urlencode({k:str(v).lower() if isinstance(v,bool) else str(v) for k,v in query.items()})
    if key.endswith('.publish_harness_source'):
        harness_source(body,{'id':parameters['id'],'contentHash':parameters['contentHash']},publishing=True)
    if key.endswith(('.stage_artifact','.create_job')):verify_hash(body,'contentHash')
    if key.endswith('.recover_checkpoint') and body.get('resourceApproval'):
        approval=body['resourceApproval'];verify_hash(approval,'approvalHash')
        if approval['sourceJobId']!=parameters['jobId']:raise ProtocolError('recovery_identity_mismatch')
    if operation['client']=='OpenPondDatasetWorkspaceClient' and operation['pythonMethod']=='save':
        draft=body['workspace']['draft']
        if draft['profileId']!=team_id or draft['modelScope'] is not None or draft['status']!='draft' or draft['revision']!=body['expectedRevision']+1:raise ProtocolError('dataset_write_scope_mismatch')
    if key.endswith('.create_job'):
        if body['approval']['maximumSpendUsd']!=body['budget']['maximumSpendUsd']:raise ProtocolError('approval_budget_mismatch')
    return operation,path,body,normalized_input,query


def finish(operation: dict[str,Any], team_id: str, parameters: dict[str,Any], body: Any, query: dict[str,Any] | None, response: Any, expected: Any = None) -> Any:
    method=operation['pythonMethod'];schema=operation['responseSchema'];key=operation['client']+'.'+method
    if operation['responseUnwrap'] and isinstance(response,dict) and operation['responseUnwrap'] in response:response=response[operation['responseUnwrap']]
    nullable=method in ('candidate_decision','operation_result') or key=='createTrainingClient.postTraining.get'
    if response is None and nullable:return None
    if schema=='LearningResourceSchemas[kind]':schema=schemas()['resourceKinds'][body['kind']]
    if schema=='LearningResourcePage[kind]':
        if not isinstance(response,dict) or set(response)!= {'items','nextCursor'} or not isinstance(response['items'],list) or len(response['items'])>100:raise ProtocolError('invalid_wire_page')
        response={**response,'items':[validate(schemas()['resourceKinds'][body['kind']],item) for item in response['items']]}
    else:response=parse_schema(schema,response)
    scoped(response,team_id)
    if isinstance(response,dict):
        for name in ('jobId','datasetId','runId'):
            if name in parameters and name in response and parameters[name]!=response[name]:raise ProtocolError('resource_identity_mismatch')
        if 'id' in parameters and 'id' in response and parameters['id']!=response['id']:raise ProtocolError('resource_identity_mismatch')
    if schema=='TrainingJobSchema':
        if method!='recover_checkpoint' and 'jobId' in parameters and response['id']!=parameters['jobId']:raise ProtocolError('resource_identity_mismatch')
        if method=='create_job' and (response['submissionHash']!=body['contentHash'] or response['modelProjectId']!=body['source']['modelProject']['id']):raise ProtocolError('training_submission_mismatch')
    if schema=='ModelTasksetRunDetailsSchema':evaluation_identity.details(response,team_id,parameters.get('id'),body if method=='create' else None)
    if schema=='ModelTasksetRunResultSchema':evaluation_identity.result(response,team_id,parameters.get('id'))
    if method=='get_harness_source':harness_source(response,{'id':parameters['id'],'contentHash':parameters['contentHash']})
    if method=='publish_harness_source' and (response['harnessRelease']!={'id':parameters['id'],'contentHash':parameters['contentHash']} or response['sourcePackageHash']!=body['contentHash']):raise ProtocolError('harness_publication_mismatch')
    if schema=='TrainingPreparationReceiptSchema':
        response=verify_preparation(response,team_id,parameters.get('id'))
        if method=='prepare_run' and response['plan']['requestHash']!=canonical_sha256(body):raise ProtocolError('training_preparation_request_mismatch')
        if method in ('start_preparation','cancel_preparation') and (response['plan']['contentHash']!=body['planHash'] or response['state']!=('submitted' if method=='start_preparation' else 'cancelled')):raise ProtocolError('training_preparation_control_mismatch')
    if schema=='TrainingPreparationPageSchema':
        for receipt in response['items']:
            verify_preparation(receipt,team_id)
            if body.get('projectId') and receipt['plan']['request']['projectId']!=body['projectId'] or body.get('state') and receipt['state']!=body['state']:raise ProtocolError('preparation_filter_mismatch')
        if response['nextCursor'] is not None and (not response['items'] or response['nextCursor']!=response['items'][-1]['plan']['id']):raise ProtocolError('invalid_page_cursor')
    if schema=='TrainingCandidateDecisionSchema':
        verify_hash(response,'contentHash');request=response['request']
        if request['jobId']!=parameters['jobId'] or request['artifact']['id']!=parameters['artifactId']:raise ProtocolError('candidate_decision_identity_mismatch')
        previous=request['expectedDecision']
        if (response['revision']==1)!=(previous is None) or previous is not None and previous['id']==response['id']:raise ProtocolError('candidate_decision_revision_mismatch')
        if method=='record_candidate_decision' and canonical_sha256(request)!=canonical_sha256(body):raise ProtocolError('candidate_decision_request_mismatch')
        if expected is not None and request['artifact']!=expected:raise ProtocolError('candidate_decision_identity_mismatch')
    if schema=='TrainingEvaluationTaskPageSchema':
        verify_hash(response,'contentHash');end=response['offset']+len(response['tasks'])
        cursor=str(end) if end<response['total'] else None
        if end>response['total'] or response['nextCursor']!=cursor or response['evaluation']['id']!=parameters['evaluationId'] or response['offset']!=int((query or {}).get('cursor',0)) or len({item['taskId'] for item in response['tasks']})!=len(response['tasks']):raise ProtocolError('evaluation_page_mismatch')
        if any(task['outputSha256']!=canonical_sha256(task['output']) for task in response['tasks']):raise ProtocolError('evaluation_output_hash_mismatch')
        if expected is None or response['evaluation']!=expected:raise ProtocolError('evaluation_reference_required')
    if operation['client']=='OpenPondDatasetWorkspaceClient' and isinstance(response,dict):
        if 'id' in parameters and 'datasetId' in response and parameters['id']!=response['datasetId']:raise ProtocolError('dataset_identity_mismatch')
        if method=='operation_result' and (response['operationId']!=parameters['operationId'] or response['kind']!=(query or {}).get('kind') or (query or {}).get('datasetId') and response['receipt']['datasetId']!=query['datasetId'] or (query or {}).get('requestHash') and response['requestHash']!=query['requestHash']):raise ProtocolError('dataset_operation_mismatch')
        if method=='validate' and response['revision']!=body['expectedRevision']:raise ProtocolError('dataset_revision_mismatch')
        if method=='versions':
            revisions=[item['workspaceRevision'] for item in response['items']]
            if any(a<=b for a,b in zip(revisions,revisions[1:])) or (query or {}).get('beforeRevision') is not None and any(r>=int(query['beforeRevision']) for r in revisions):raise ProtocolError('dataset_version_order_mismatch')
    if schema=='TrainingAcceptanceGroupPageSchema':
        if any(group['jobId']!=parameters['jobId'] or body.get('cursor') and group['id']<=body['cursor'] for group in response['groups']) or response['nextCursor'] is not None and (not response['groups'] or response['nextCursor']!=response['groups'][-1]['id']):raise ProtocolError('acceptance_group_scope_mismatch')
    if schema=='AcceptanceGroupSnapshotSchema':
        manifest=response['manifest']
        if manifest['teamId']!=team_id or manifest['trainingJob']['id']!=parameters['jobId'] or manifest['id']!=parameters['groupId'] or expected is not None and (response['revision']!=expected['revision'] or response['contentHash']!=expected['contentHash']):raise ProtocolError('acceptance_group_identity_mismatch')
    if operation['client']=='createTrainingClient.postTraining':
        if method=='attach' and canonical_sha256(response['attachment'])!=canonical_sha256(body['attachment']):raise ProtocolError('post_training_attachment_mismatch')
        if method=='control' and response['planHash']!=body['planHash']:raise ProtocolError('post_training_control_mismatch')
    if operation['client']=='OpenPondDatasetPreparationClient':
        if schema=='DatasetPreparationRunSchema' and method=='create' and (response['operationId']!=body['operationId'] or response['datasetRevision']!=body['expectedDatasetRevision']):raise ProtocolError('preparation_creation_mismatch')
        if schema=='DatasetPreparationRunSchema' and method=='command' and response['revision']<body['expectedRevision']+1:raise ProtocolError('preparation_revision_mismatch')
        if schema=='DatasetPreparationGrantSchema' and method=='create_grant' and any(response[k]!=body[k] for k in ('id','projectId','maximumMicroUsd','maximumSandboxSeconds')):raise ProtocolError('preparation_grant_mismatch')
        if schema=='DatasetPreparationOperationResultSchema' and (response['operationId']!=parameters['operationId'] or response['run']['datasetId']!=parameters['datasetId']):raise ProtocolError('preparation_operation_mismatch')
        if schema=='DatasetPreparationRunSchema' and 'runId' in parameters and response['id']!=parameters['runId']:raise ProtocolError('preparation_identity_mismatch')
        if schema=='DatasetPreparationGrantSchema' and 'grantId' in parameters and response['id']!=parameters['grantId']:raise ProtocolError('preparation_identity_mismatch')
        if schema=='DatasetPreparationListSchema':
            for run in response['runs']:
                scoped(run,team_id)
                if run['datasetId']!=parameters['datasetId']:raise ProtocolError('preparation_identity_mismatch')
            if len({run['id'] for run in response['runs']})!=len(response['runs']):raise ProtocolError('duplicate_page_identity')
    if operation['client']=='OpenPondDatasetWorkspaceClient' and schema=='DatasetWorkspaceReceiptSchema':
        if 'id' in parameters and response['datasetId']!=parameters['id']:raise ProtocolError('dataset_identity_mismatch')
        if method=='version' and (response['revision']!=parameters['revision'] or response['workspace']['draft']['status']!='published'):raise ProtocolError('dataset_version_mismatch')
        draft=response['workspace']['draft']
        if draft['id']!=response['datasetId'] or draft['profileId']!=team_id or draft['revision']!=response['revision'] or draft['modelScope'] is not None:raise ProtocolError('dataset_workspace_identity_mismatch')
        if method in ('save','publish','begin_version') and response['revision']!=body['expectedRevision']+1:raise ProtocolError('dataset_revision_mismatch')
        if method=='begin_version' and (draft['status']!='draft' or not response['publication'] or not draft['publishedTasksetRef']):raise ProtocolError('dataset_version_mismatch')
        if method=='save' and any(body.get(k) and response.get(k)!=body[k] for k in ('originProjectId','ownerScope')):raise ProtocolError('dataset_owner_mismatch')
        if method=='save' and response['workspace']['contentHash']!=body['workspace']['contentHash']:raise ProtocolError('dataset_content_mismatch')
        if method=='publish' and (draft['status']!='published' or not response['publication'] or response['publication']['packageHash']!=body['packageHash']):raise ProtocolError('dataset_publication_mismatch')
    if schema=='TrainingEstimateSchema' and (response['teamId']!=team_id or response['requestHash']!=canonical_sha256(body)):raise ProtocolError('training_estimate_scope_mismatch')
    if operation['client']=='OpenPondLearningClient':
        if method in ('command','submit_example','submit_feedback') and response['operationId']!=body['command']['operationId']:raise ProtocolError('operation_identity_mismatch')
        if method=='publish_batch' and response['batchId']!=body['batchId']:raise ProtocolError('batch_identity_mismatch')
        if method in ('get','inspect_evidence','inspect_policy'):
            ref=body.get('evidence',body.get('policy',body))
            actual=response.get('evidence',response.get('policy',response))
            if ref.get('id')!=actual.get('id') or 'revision' in ref and ref['revision']!=actual.get('revision') or 'contentHash' in ref and ref['contentHash']!=actual.get('contentHash'):raise ProtocolError('learning_resource_identity_mismatch')
        if method=='inspect_task_queue' and response['modelProjectId']!=body['modelProjectId']:raise ProtocolError('model_identity_mismatch')
        if method=='source_configuration' and response['source']['id']!=body['sourceId']:raise ProtocolError('credential_identity_mismatch')
        if method=='list_source_credentials':
            if len(response['items'])>body['limit'] or any(item['sourceId']!=body['sourceId'] for item in response['items']):raise ProtocolError('credential_identity_mismatch')
        if method=='revoke_source_credential' and (response['sourceId']!=body['sourceId'] or response['id']!=body['id'] or response['revokedAt'] is None):raise ProtocolError('credential_identity_mismatch')
        if method=='create_source_credential':
            scoped(response['credential'],team_id)
            if response['apiKey']!=body['apiKey'] or response['credential']['sourceId']!=body['sourceId'] or not body['apiKey'].startswith(response['credential']['keyPrefix']+'_'):raise ProtocolError('credential_identity_mismatch')
    # Every paged response retains its cursor. Auto-iterators detect repeats.
    if isinstance(response,dict):
        for field in ('items','groups','datasets','jobs'):
            if field in response and isinstance(response[field],list):
                limit=(body or {}).get('limit',(query or {}).get('limit'))
                if limit is not None and len(response[field])>limit:raise ProtocolError('page_size_mismatch')
                for item in response[field]:scoped(item,team_id)
                identities=[item.get('id',item.get('plan',{}).get('id')) for item in response[field] if isinstance(item,dict)]
                present=[identity for identity in identities if identity is not None]
                if len(set(present))!=len(present):raise ProtocolError('duplicate_page_identity')
                cursor=response.get('nextCursor')
                previous=(body or {}).get('afterId',(body or {}).get('cursor',(query or {}).get('afterId',(query or {}).get('cursor'))))
                if cursor is not None and (not isinstance(cursor,str) or not cursor or len(cursor)>2000 or cursor==previous or not response[field]):raise ProtocolError('invalid_page_cursor')
    return response
