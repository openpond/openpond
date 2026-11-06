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
from . import evaluation_identity, draft_identity, hardware_identity
from .wire import canonical_json, canonical_sha256, schemas, validate, verify_hash, verify_preparation, _JS_SPACE

DECISION_METHODS=frozenset(('decision_execution_capability','compile_decision_execution','prepare_decision_execution',
    'start_decision_execution','cancel_decision_execution','get_decision_execution','list_decision_executions',
    'save_decision_result_model','score_decision_model','decision_model_serving','control_decision_model_serving'))

WEIGHT_METHODS=frozenset(('alpha_edit_execution_capability',
    'compile_alpha_edit_execution',
    'prepare_alpha_edit_execution',
    'start_alpha_edit_execution',
    'cancel_alpha_edit_execution',
    'get_alpha_edit_execution',
    'list_alpha_edit_executions',
    'save_alpha_edit_result_model',
    'alpha_edit_model_serving',
    'control_alpha_edit_model_serving',
    'neuron_training_execution_capability',
    'compile_neuron_training_execution',
    'prepare_neuron_training_execution',
    'start_neuron_training_execution',
    'cancel_neuron_training_execution',
    'get_neuron_training_execution',
    'list_neuron_training_executions',
    'save_neuron_training_result_model',
    'neuron_training_model_serving',
    'control_neuron_training_model_serving'))

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
        if (key in ('createTrainingClient.get_modification_execution','createTrainingClient.start_modification_execution','createTrainingClient.cancel_modification_execution','createTrainingClient.get_engram_execution','createTrainingClient.start_engram_execution','createTrainingClient.cancel_engram_execution','createTrainingClient.save_engram_result_model','createTrainingClient.get_decision_execution','createTrainingClient.start_decision_execution','createTrainingClient.cancel_decision_execution','createTrainingClient.save_decision_result_model') and name in ('id','executionId')
                or key.startswith('createTrainingClient.') and key.split('.',1)[1] in WEIGHT_METHODS and name in ('id','executionId','modelProjectId')
                or key in ('createTrainingClient.control_engram_model_serving','createTrainingClient.decision_model_serving','createTrainingClient.control_decision_model_serving','createTrainingClient.score_decision_model') and name == 'modelProjectId'):
            # Match the TS Id parser and retain that identity for reply checks.
            if type(item) is not str:raise ProtocolError('invalid_resource_id')
            item=item.strip(_JS_SPACE)
            if not 0<len(item.encode('utf-16-le','surrogatepass'))//2<=240:raise ProtocolError('invalid_resource_id')
            parameters[name]=item
            path=path.replace('{'+name+'}',quote(item,safe=''))
            continue
        if type(item) not in (str,int) or isinstance(item,bool) or not 0<len(str(item).strip())<=500:raise ProtocolError('invalid_resource_id')
        if name=='action' and item not in ('start','retry','cancel'):raise ProtocolError('invalid_post_training_action')
        if name=='contentHash' and re.fullmatch(r'[a-f0-9]{64}',str(item)) is None:raise ProtocolError('invalid_content_hash')
        path=path.replace('{'+name+'}',quote(str(item).strip(),safe=''))
    if key in ('createTrainingClient.get_steering_profile','createTrainingClient.model_version','createTrainingClient.get_neuron_calibration'):
        if body is not None and body.get('teamId',team_id)!=team_id:raise ProtocolError('workspace_scope_mismatch')
        body={**(body or {}),'teamId':team_id}
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
    if client=='createTrainingClient' and method in WEIGHT_METHODS:
        from .weight_execution_identity import prepare as prepare_weight, expectation
        expectation(expected)
        if query and (not method.startswith(('get_', 'list_')) or set(query)-{'teamId'}):
            raise ProtocolError('invalid_query')
        if method.startswith(('compile_', 'prepare_', 'start_', 'cancel_')):
            body=prepare_weight(method,body)
        if method.startswith(('start_', 'cancel_')) and (body['id']!=parameters['id']
                or body['action']!=('start' if method.startswith('start_') else 'cancel')):
            raise ProtocolError('weight_execution_target_mismatch')
        if method.startswith('save_') and (body['executionId']!=parameters['executionId']
                or bool(body['modelProjectId'])!=(body['expectedModelRevision']>0)):
            raise ProtocolError('weight_model_save_mismatch')
    if client=='createTrainingClient' and method in DECISION_METHODS:
        from .decision_execution_identity import prepare_decision_operation, prepare_decision_expectation
        prepare_decision_expectation(method,expected)
        if query and (method not in ('get_decision_execution','list_decision_executions') or set(query)-{'teamId'}):
            raise ProtocolError('invalid_query')
        if method in ('compile_decision_execution','prepare_decision_execution','start_decision_execution','cancel_decision_execution'):
            body=prepare_decision_operation(method,body)
        if method in ('start_decision_execution','cancel_decision_execution') and (body['id']!=parameters['id'] or body['action']!=('start' if method=='start_decision_execution' else 'cancel')):
            raise ProtocolError('decision_execution_target_mismatch')
        if method=='save_decision_result_model' and (body['executionId']!=parameters['executionId']
                or body['modelProjectId'] is None and body['expectedModelRevision']!=0
                or body['modelProjectId'] is not None and body['expectedModelRevision']<=0):
            raise ProtocolError('decision_model_save_mismatch')
        if method=='score_decision_model':
            from .decision_serving_identity import parse_decision_model_score_request
            body=parse_decision_model_score_request(body)
    if client=='createTrainingClient' and method in ('compile_engram_execution','prepare_engram_execution','start_engram_execution','cancel_engram_execution'):
        from .engram_identity import prepare as prepare_engram
        body=prepare_engram(method,body)
        if method in ('start_engram_execution','cancel_engram_execution') and (body['id']!=parameters['id'] or body['action']!=('start' if method=='start_engram_execution' else 'cancel')):
            raise ProtocolError('engram_execution_target_mismatch')
    if client=='createTrainingClient' and method=='save_engram_result_model':
        if body['executionId']!=parameters['executionId'] or bool(body['modelProjectId'])!=(body['expectedModelRevision']>0):
            raise ProtocolError('engram_model_save_mismatch')
    if client=='createTrainingClient' and method=='import_neuron_calibration':
        from .neuron_calibration_identity import verify_calibration_export
        verify_calibration_export(body['artifact'])
    if client=='createTrainingClient' and method=='compile_modification_execution':
        from .modification_identity import prepare_managed_compilation
        body=prepare_managed_compilation(body)
    if client=='createTrainingClient' and method in ('prepare_modification_execution','start_modification_execution','cancel_modification_execution'):
        from .modification_identity import prepare_managed_modification
        body=prepare_managed_modification(body)
        if method!='prepare_modification_execution' and (body['id']!=parameters['id'] or body['action']!=('start' if method=='start_modification_execution' else 'cancel')):
            raise ProtocolError('managed_modification_target_mismatch')
    if client=='createTrainingClient' and method=='record_modification_observation':
        from .recording_identity import verify_recording_request
        body=verify_recording_request(body)
    if client=='createTrainingClient' and method=='review_dataset':
        selected=body.get('taskIds')
        if (selected is not None and len(set(selected))!=len(selected)
                or body['purpose']!='supervised_training' and body['targetSource']!='none'):
            raise ProtocolError('dataset_training_review_invalid')
    if client=='createTrainingClient' and method=='gpu_catalog' and query:
        query=parse_schema('TrainingGpuCatalogQuerySchema',query,request=True)
        scoped(query,team_id)
    if client=='createTrainingClient' and method in ('get_experiment_draft','list_experiment_drafts','get_modification_execution','list_modification_executions','list_steering_profiles','list_neuron_calibrations','get_engram_execution','list_engram_executions','get_decision_execution','list_decision_executions','get_alpha_edit_execution','list_alpha_edit_executions','get_neuron_training_execution','list_neuron_training_executions'):
        if query.get('teamId',team_id)!=team_id:raise ProtocolError('workspace_scope_mismatch')
        query['teamId']=team_id
    if client=='createTrainingClient' and method in ('save_experiment_draft','archive_experiment_draft'):
        if len(canonical_json(body).encode('utf-8'))>32768:raise ProtocolError('experiment_draft_too_large')
        if method=='save_experiment_draft':draft_identity.validate_draft_document(body['draft'],team_id)
    if client=='createTrainingClient' and method=='prepare_experiment':
        settings=body['settings'];recipe=settings.get('recipe')
        if not body['baseModel']['revision'] or recipe is None or recipe['method'] not in ('sft','grpo') or settings['method']!=recipe['method'] or body.get('parent') is not None and settings['method']!='grpo':
            raise ProtocolError('training_experiment_setup_invalid')
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
    if key=='createTrainingClient.estimate' and body['source']['kind']=='submission':verify_hash(body['source']['submission'],'contentHash')
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
    # GPU catalogs have a structured workload scope; its exact query verifier
    # below owns this boundary instead of the string workspace field.
    if schema!='TrainingGpuCatalogSchema':scoped(response,team_id)
    if isinstance(response,dict):
        for name in ('jobId','datasetId','runId'):
            if name in parameters and name in response and parameters[name]!=response[name]:raise ProtocolError('resource_identity_mismatch')
        if 'id' in parameters and 'id' in response and parameters['id']!=response['id']:raise ProtocolError('resource_identity_mismatch')
    if schema=='TrainingJobSchema':
        from .training_usage_identity import verify_training_usage_snapshot
        verify_training_usage_snapshot(response)
        if method!='recover_checkpoint' and 'jobId' in parameters and response['id']!=parameters['jobId']:raise ProtocolError('resource_identity_mismatch')
        if method=='create_job' and (response['submissionHash']!=body['contentHash'] or response['modelProjectId']!=body['source']['modelProject']['id']):raise ProtocolError('training_submission_mismatch')
    if schema=='TrainingJobPageSchema':
        from .training_usage_identity import verify_training_usage_snapshot
        for job in response['jobs']:verify_training_usage_snapshot(job)
    if method in WEIGHT_METHODS:
        if schema in ('AlphaEditModelServingSchema','NeuronTrainingModelServingSchema'):
            from .weight_serving_identity import verify_weight_model_serving
            verify_weight_model_serving(response,team_id,parameters['modelProjectId'],body['versionHash'],
                owner_user_id=(expected or {}).get('ownerUserId',(expected or {}).get('actorId')))
        elif schema in ('AlphaEditModelServingControlReceiptSchema','NeuronTrainingModelServingControlReceiptSchema'):
            from .weight_serving_identity import verify_weight_serving_control
            verify_weight_serving_control(response,body,team_id,parameters['modelProjectId'],
                actor_id=(expected or {}).get('actorId',(expected or {}).get('ownerUserId')))
        elif schema in ('AlphaEditResultSaveReceiptSchema','NeuronTrainingResultSaveReceiptSchema'):
            from .weight_model_identity import verify_weight_result_save
            verify_weight_result_save(response,body,actor_id=(expected or {}).get('actorId',(expected or {}).get('ownerUserId')))
        else:
            from .weight_execution_identity import finish as finish_weight
            finish_weight(schema,response,team_id,parameters,body,expected)
    if schema in ('DecisionExecutionCapabilitySchema','ManagedDecisionCompilationSchema','ManagedDecisionExecutionSchema','ManagedDecisionExecutionReceiptSchema','ManagedDecisionExecutionPageSchema'):
        from .decision_execution_identity import finish_decision_operation
        finish_decision_operation(schema,response,team_id,parameters,body,expected)
    if schema=='DecisionResultSaveReceiptSchema':
        from .decision_version_identity import verify_decision_result_save
        verify_decision_result_save(response,body,actor_id=(expected or {}).get('actorId'))
        if expected and 'ownerUserId' in expected and response['actorId']!=expected['ownerUserId']:
            raise ProtocolError('decision_model_save_mismatch')
    if schema=='DecisionModelScoreReceiptSchema':
        from .decision_serving_identity import verify_decision_model_score_receipt
        verify_decision_model_score_receipt(response,body,model_project_id=parameters['modelProjectId'],
            actor_id=(expected or {}).get('actorId'),admission=(expected or {}).get('admission'))
        if expected and 'ownerUserId' in expected and response['actorId']!=expected['ownerUserId']:
            raise ProtocolError('decision_model_score_mismatch')
    if schema=='DecisionModelServingSchema':
        from .decision_serving_identity import verify_decision_model_serving
        verify_decision_model_serving(response,team_id,parameters['modelProjectId'],body['versionHash'],owner_user_id=(expected or {}).get('ownerUserId'))
        if expected and 'actorId' in expected and response['version']['ownerUserId']!=expected['actorId']:
            raise ProtocolError('decision_model_serving_mismatch')
    if schema=='DecisionModelServingControlReceiptSchema':
        from .decision_serving_identity import verify_decision_serving_control
        verify_decision_serving_control(response,body,team_id,parameters['modelProjectId'],actor_id=(expected or {}).get('actorId'))
        if expected and 'ownerUserId' in expected and response['actorId']!=expected['ownerUserId']:
            raise ProtocolError('decision_serving_control_mismatch')
    if schema in ('EngramExecutionCapabilitySchema','ManagedEngramCompilationSchema','ManagedEngramExecutionSchema','ManagedEngramExecutionReceiptSchema','ManagedEngramExecutionPageSchema','EngramResultSaveReceiptSchema'):
        from .engram_identity import finish as finish_engram
        finish_engram(schema,response,team_id,parameters,body)
    if schema in ('SteeringProfileRecordSchema','SteeringProfileReceiptSchema','SteeringProfilePageSchema','SavedModelVersionReadSchema'):
        from .steering_publication_identity import finish as finish_steering_publication
        finish_steering_publication(schema,response,team_id,parameters,body)
    if schema=='TrainingResultSaveReceiptSchema':
        from .training_model_identity import verify_training_result_save
        verify_training_result_save(response,body,team_id,parameters['jobId'])
    if schema=='TrainingSavedModelSchema':
        from .training_model_identity import verify_training_saved_model
        verify_training_saved_model(response,team_id,parameters['modelProjectId'])
    if schema=='TrainingModelServingSchema':
        from .training_serving_identity import verify_training_model_serving
        verify_training_model_serving(response,team_id,parameters['modelProjectId'],body['versionHash'])
    if schema in ('SavedModelServingSchema','SteeringModelServingSchema'):
        from .steering_serving_identity import verify_saved_model_serving
        verify_saved_model_serving(response,team_id,parameters['modelProjectId'],body['versionHash'])
    if schema=='SteeringModelServingControlReceiptSchema':
        from .steering_serving_identity import verify_steering_serving_control
        verify_steering_serving_control(response,body,team_id,parameters['modelProjectId'])
    if schema=='EngramModelServingControlReceiptSchema':
        from .engram_serving_identity import verify_engram_serving_control
        verify_engram_serving_control(response,body,team_id,parameters['modelProjectId'])
    if schema in ('NeuronCalibrationRecordSchema','NeuronCalibrationReceiptSchema','NeuronCalibrationPageSchema'):
        from .neuron_calibration_identity import finish as finish_neuron_calibration
        finish_neuron_calibration(schema,response,team_id,parameters,body)
    if schema=='TrainingModelServingControlReceiptSchema':
        from .training_serving_identity import verify_training_serving_control
        verify_training_serving_control(response,body,team_id,parameters['modelProjectId'])
    if schema=='TrainingResultSchema':
        from .training_usage_identity import verify_training_usage_snapshot
        verify_training_usage_snapshot(response['job'])
        from .training_result_identity import verify_training_result
        verify_training_result(response,team_id,parameters['jobId'])
    if schema=='ModelModificationCapabilitiesSchema':
        from .modification_identity import verify_modification_capabilities
        verify_modification_capabilities(response,body,team_id)
    if schema in ('ModificationRecordingSchema','ModificationRecordingReadSchema','ModificationRecordingPageSchema'):
        from .recording_identity import finish as finish_recording
        finish_recording(schema,response,team_id,parameters,body)
    if schema=='ManagedModificationExecutionPageSchema':
        from .modification_identity import verify_managed_modification_page
        verify_managed_modification_page(response,body,team_id)
    if schema=='ManagedModificationExecutionSchema':
        from .modification_identity import verify_managed_modification_execution
        verify_managed_modification_execution(response,team_id,parameters['id'])
    if schema=='ManagedModificationCompilationSchema':
        from .modification_identity import verify_managed_compilation
        verify_managed_compilation(response,body,team_id)
    if schema=='ManagedModificationExecutionReceiptSchema':
        from .modification_identity import verify_managed_modification_receipt
        verify_managed_modification_receipt(response,body,team_id)
    if schema=='ModelTasksetRunDetailsSchema':evaluation_identity.details(response,team_id,parameters.get('id'),body if method=='create' else None)
    if schema=='ModelTasksetRunResultSchema':evaluation_identity.result(response,team_id,parameters.get('id'))
    if method=='get_harness_source':harness_source(response,{'id':parameters['id'],'contentHash':parameters['contentHash']})
    if method=='publish_harness_source' and (response['harnessRelease']!={'id':parameters['id'],'contentHash':parameters['contentHash']} or response['sourcePackageHash']!=body['contentHash']):raise ProtocolError('harness_publication_mismatch')
    if schema in ('ExperimentDraftRecordSchema','ExperimentDraftReceiptSchema','ExperimentDraftPageSchema'):
        draft_identity.finish(schema,method,response,team_id,parameters,body)
    if schema=='TrainingExperimentSetupReceiptSchema':
        request=response['request'];preparation=verify_preparation(response['preparation'],team_id);plan=preparation['plan']
        run={k:v for k,v in request.items() if k not in ('schemaVersion','baseModel','settings')}
        prepared_run={k:v for k,v in plan['request'].items() if k not in ('schemaVersion','configuration')}
        portable_id='experiment-'+canonical_sha256({'teamId':request['teamId'],'operationId':request['operationId'],'creatorUserId':plan['creatorUserId']})
        configuration=plan['request']['configuration'];source=plan['source']['modelProject']
        if response['requestHash']!=canonical_sha256(body) or response['requestHash']!=canonical_sha256(request) or canonical_sha256(run)!=canonical_sha256(prepared_run) or source['portableProjectId']!=portable_id or source['revision']!=configuration['expectedRevision'] or source['contentHash']!=configuration['expectedEtag']:
            raise ProtocolError('training_experiment_setup_mismatch')
    if schema=='TrainingPreparationReceiptSchema':
        response=verify_preparation(response,team_id,parameters.get('id'))
        if method=='prepare_run' and response['plan']['requestHash']!=canonical_sha256(body):raise ProtocolError('training_preparation_request_mismatch')
        if method in ('start_preparation','cancel_preparation') and (response['plan']['contentHash']!=body['planHash'] or response['state']!=('submitted' if method=='start_preparation' else 'cancelled')):raise ProtocolError('training_preparation_control_mismatch')
        if method=='start_preparation' and (response['plan'].get('usageQuote') or {}).get('contentHash')!=body.get('usageQuoteHash'):raise ProtocolError('training_usage_quote_mismatch')
    if schema=='TrainingPreparationPageSchema':
        for receipt in response['items']:
            verify_preparation(receipt,team_id)
            if body.get('projectId') and receipt['plan']['request']['projectId']!=body['projectId'] or body.get('state') and receipt['state']!=body['state']:raise ProtocolError('preparation_filter_mismatch')
        if response['nextCursor'] is not None and (not response['items'] or response['nextCursor']!=response['items'][-1]['plan']['id']):raise ProtocolError('invalid_page_cursor')
    if schema=='TrainingExecutionPageSchema':
        from .training_usage_identity import verify_training_usage_snapshot
        for item in response['items']:verify_training_usage_snapshot(item['job'])
        items=response['items']
        if response['projectId']!=body.get('projectId') or len(items)>body.get('limit',30) or len({item['job']['id'] for item in items})!=len(items) or body.get('cursor') and response['nextCursor']==body['cursor']:
            raise ProtocolError('training_execution_page_mismatch')
        for item in items:
            if item['job']['teamId']!=team_id or body.get('datasetHash') and (item['dataset'] or {}).get('contentHash')!=body['datasetHash']:
                raise ProtocolError('training_execution_page_mismatch')
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
        if method=='add_task' and response['operationId']!=body['operationId']:raise ProtocolError('dataset_task_operation_mismatch')
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
    if schema=='TrainingEstimateSchema':
        from .estimate_identity import verify_estimate
        verify_estimate(response,body,team_id)
    if schema=='DatasetTrainingReviewReceiptSchema':
        from .dataset_review_identity import verify_dataset_review
        verify_dataset_review(response,body,team_id)
    if schema in ('TrainingFundingSchema','TrainingFundingHandoffSchema'):
        from .funding_identity import verify_funding
        verify_funding(response,body,team_id)
    if operation['client']=='OpenPondLearningClient':
        if method in ('command','submit_example','submit_feedback') and response['operationId']!=body['command']['operationId']:raise ProtocolError('operation_identity_mismatch')
        if method=='publish_batch' and response['batchId']!=body['batchId']:raise ProtocolError('batch_identity_mismatch')
        if method in ('get','inspect_evidence','inspect_policy'):
            # A resource may itself contain policy/evidence references. Only
            # inspection envelopes bind those nested references; get binds the
            # requested kind's validated top-level resource identity.
            field={'inspect_evidence':'evidence','inspect_policy':'policy'}.get(method)
            ref=body[field] if field else body
            actual=response[field] if field else response
            if ref.get('id')!=actual.get('id') or 'revision' in ref and ref['revision']!=actual.get('revision') or 'contentHash' in ref and ref['contentHash']!=actual.get('contentHash'):raise ProtocolError('learning_resource_identity_mismatch')
        if method=='inspect_task_queue' and response['modelProjectId']!=body['modelProjectId']:raise ProtocolError('model_identity_mismatch')
        if method=='source_configuration' and response['source']['id']!=body['sourceId']:raise ProtocolError('credential_identity_mismatch')
        if method=='list_source_credentials':
            if len(response['items'])>body['limit'] or any(item['sourceId']!=body['sourceId'] for item in response['items']):raise ProtocolError('credential_identity_mismatch')
        if method=='revoke_source_credential' and (response['sourceId']!=body['sourceId'] or response['id']!=body['id'] or response['revokedAt'] is None):raise ProtocolError('credential_identity_mismatch')
        if method=='create_source_credential':
            scoped(response['credential'],team_id)
            if response['apiKey']!=body['apiKey'] or response['credential']['sourceId']!=body['sourceId'] or not body['apiKey'].startswith(response['credential']['keyPrefix']+'_'):raise ProtocolError('credential_identity_mismatch')
    if schema=='TrainingHardwareCatalogSchema':hardware_identity.verify_catalog(response)
    if schema=='TrainingGpuCatalogSchema':hardware_identity.verify_gpu_catalog(response,query)
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
                cursor_limit=2048 if schema in ('ManagedEngramExecutionPageSchema','ManagedDecisionExecutionPageSchema') else 2000
                if cursor is not None and (not isinstance(cursor,str) or not cursor or len(cursor)>cursor_limit or cursor==previous or not response[field]):raise ProtocolError('invalid_page_cursor')
    return response
