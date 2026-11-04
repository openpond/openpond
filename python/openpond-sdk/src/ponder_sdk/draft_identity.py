"""Identity checks for standalone authoring documents; never execution admission."""
from __future__ import annotations
from typing import Any
from .errors import ProtocolError
from .wire import canonical_sha256, verify_hash


def validate_draft_document(draft: dict[str, Any], team_id: str | None = None) -> None:
    selected = draft.get('startingModel')
    activation_source = (draft.get('activationForm') or {}).get('startingProfile')
    engram = draft.get('engramForm')
    decision = draft.get('decisionForm')
    alpha = draft.get('alphaEditForm')
    neuron = draft.get('neuronTrainingForm')
    if alpha is not None and draft['operationType'] != 'alphaedit':
        raise ProtocolError('experiment_draft_alphaedit_source_mismatch')
    if neuron is not None and draft['operationType'] != 'selective_neuron_training':
        raise ProtocolError('experiment_draft_neuron_training_source_mismatch')
    if draft['operationType'] == 'alphaedit' and selected:
        if (selected['source'] not in ('managed','alphaedit')
                or alpha is not None and alpha.get('baseModel') is not None and alpha['baseModel'] != selected['baseModel']):
            raise ProtocolError('experiment_draft_alphaedit_source_mismatch')
    if selected and selected['source'] == 'alphaedit':
        if (draft['operationType'] != 'alphaedit' or not alpha or alpha['baseModel'] != selected['baseModel']
                or alpha.get('startingModule') != selected['alphaedit'] or alpha['parentArtifact'] != selected['alphaedit']['artifact']):
            raise ProtocolError('experiment_draft_alphaedit_source_mismatch')
    elif alpha and alpha.get('startingModule') is not None:
        raise ProtocolError('experiment_draft_alphaedit_source_mismatch')
    if draft['operationType'] == 'selective_neuron_training' and selected:
        if (selected['source'] != 'managed'
                or neuron is not None and neuron.get('baseModel') is not None and neuron['baseModel'] != selected['baseModel']):
            raise ProtocolError('experiment_draft_neuron_training_source_mismatch')
    # Learned column deltas have no continuation optimizer. Never drop a saved
    # patch implicitly, even when a different operation is selected.
    if selected and selected['source'] == 'neuron_training':
        raise ProtocolError('experiment_draft_neuron_training_source_mismatch')
    if decision is not None and draft['operationType'] != 'decision_model':
        raise ProtocolError('experiment_draft_decision_source_mismatch')
    if draft['operationType'] == 'decision_model' and selected:
        if (selected['source'] not in ('managed','decision')
                or decision is not None and decision.get('baseModel') is not None and canonical_sha256(decision['baseModel']) != canonical_sha256(selected['baseModel'])):
            raise ProtocolError('experiment_draft_decision_source_mismatch')
    if selected and selected['source'] == 'decision':
        from .decision_version_identity import decision_source_preference
        if (draft['operationType'] != 'decision_model' or not decision or selected['inferenceModelId'] is not None
                or canonical_sha256(selected['baseModel']) != canonical_sha256(decision_source_preference())
                or canonical_sha256(decision['baseModel']) != canonical_sha256(selected['baseModel'])
                or decision.get('startingDecision') != selected['decision'] or decision['parentArtifact'] != selected['decision']['artifact']):
            raise ProtocolError('experiment_draft_decision_source_mismatch')
    elif decision and decision.get('startingDecision') is not None:
        raise ProtocolError('experiment_draft_decision_source_mismatch')
    if engram is not None and draft['operationType'] != 'engram_adapter':
        raise ProtocolError('experiment_draft_engram_source_mismatch')
    if draft['operationType'] == 'engram_adapter' and selected:
        if (selected['source'] not in ('managed', 'engram')
                or engram is not None and engram.get('baseModel') is not None and engram['baseModel'] != selected['baseModel']):
            raise ProtocolError('experiment_draft_engram_source_mismatch')
    if selected and selected['source'] == 'engram':
        if (draft['operationType'] != 'engram_adapter' or not engram
                or engram['baseModel'] != selected['baseModel'] or engram['parentArtifact'] != selected['engram']['artifact']
                or engram.get('startingModule') != selected['engram']):
            raise ProtocolError('experiment_draft_engram_source_mismatch')
    if selected and selected['source'] == 'steering':
        activation = draft.get('activationForm')
        if (draft['operationType'] != 'neuron_steering' or not activation
                or selected['inferenceModelId'] is not None or activation.get('baseModel') != selected['baseModel']
                or activation_source != selected['steering']):
            raise ProtocolError('experiment_draft_steering_source_mismatch')
    elif activation_source is not None:
        raise ProtocolError('experiment_draft_steering_source_mismatch')
    if selected and selected['source'] == 'trained':
        from .training_model_identity import verify_training_model_version
        version = selected['trainedVersion']
        verify_training_model_version(version, team_id or version['teamId'], version['modelProjectId'])
        base = version['request']['baseModel']
        if selected['inferenceModelId'] is not None or selected['baseModel'] != base:
            raise ProtocolError('experiment_draft_trained_source_mismatch')
        for key in ('trainingForm', 'training', 'activationForm'):
            form = draft.get(key)
            if form and form.get('baseModel') is not None and form['baseModel'] != base:
                raise ProtocolError('experiment_draft_trained_source_mismatch')
        parent = (draft.get('trainingForm') or {}).get('parent')
        if parent and (parent['jobId'] != version['jobId'] or parent['artifact'] != version['candidate']['artifact']
                or parent['checkpointId'] != version['candidate']['checkpointId']):
            raise ProtocolError('experiment_draft_trained_source_mismatch')
    elif selected and 'trainedVersion' in selected:
        raise ProtocolError('experiment_draft_trained_source_mismatch')
    if draft.get('evaluationForm') is not None and draft['operationType']!='evaluate':
        raise ProtocolError('experiment_draft_method_mismatch')
    method=draft['operationType'];form=draft.get('trainingForm');training=draft.get('training')
    if form is not None and (method not in ('sft','grpo') or form['recipe']['method']!=method):
        raise ProtocolError('experiment_draft_method_mismatch')
    if training is not None and (method not in ('sft','grpo') or training.get('settings') is not None and training['settings']['method']!=method):
        raise ProtocolError('experiment_draft_method_mismatch')
    activation=draft.get('activationForm')
    if activation is not None:
        if method not in ('neuron_steering','inspect_activations'):
            raise ProtocolError('experiment_draft_method_mismatch')
        for key in ('prompts','coordinates'):
            if len({row['id'] for row in activation[key]})!=len(activation[key]):
                raise ProtocolError('experiment_draft_row_identity_mismatch')


def record(value: dict[str, Any], team_id: str, identity: str | None = None) -> None:
    verify_hash(value,'contentHash');validate_draft_document(value['draft'],team_id)
    if value['teamId']!=team_id or value['id']!=value['draft']['id'] or identity is not None and value['id']!=identity:
        raise ProtocolError('experiment_draft_scope_mismatch')


def finish(schema: str, method: str, value: Any, team_id: str, parameters: dict[str, Any], body: Any) -> None:
    if schema=='ExperimentDraftRecordSchema':record(value,team_id,parameters['id'])
    elif schema=='ExperimentDraftReceiptSchema':
        identity=body['draft']['id'] if method=='save_experiment_draft' else parameters['id']
        row=value['record'];record(row,team_id,identity)
        request=body if method=='save_experiment_draft' else {'id':identity,**body}
        if value['operationId']!=body['operationId'] or value['requestHash']!=canonical_sha256(request) or row['revision']!=body['expectedRevision']+1 or row['status']!=('draft' if method=='save_experiment_draft' else 'archived'):
            raise ProtocolError('experiment_draft_receipt_mismatch')
        if method=='save_experiment_draft' and (row['projectId']!=body['projectId'] or canonical_sha256(row['draft'])!=canonical_sha256(body['draft'])):
            raise ProtocolError('experiment_draft_receipt_mismatch')
    elif schema=='ExperimentDraftPageSchema':
        items=value['items']
        if value['projectId']!=body.get('projectId') or len(items)>body['limit'] or len({item['id'] for item in items})!=len(items) or body.get('cursor') and value['nextCursor']==body['cursor']:
            raise ProtocolError('experiment_draft_page_mismatch')
        for row in items:
            record(row,team_id)
            if row['ownerUserId']!=value['ownerUserId'] or body.get('projectId') and row['projectId']!=body['projectId'] or row['status']!=('archived' if body['archived'] else 'draft'):
                raise ProtocolError('experiment_draft_page_mismatch')
