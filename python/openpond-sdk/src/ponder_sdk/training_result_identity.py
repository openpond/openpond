"""Bind retained training results to their Job, request and output inventory.

Checkpoint publication does not attest model quality or serving readiness.
"""
from typing import Any
from .errors import ProtocolError
from .wire import canonical_sha256


def verify_training_result(value: dict[str, Any], team_id: str, job_id: str) -> None:
    def fail() -> None:
        raise ProtocolError('training_result_mismatch')

    job = value['job']
    outputs = value['outputs']['outputs']
    request = value['request']
    receipt = value['outputs']['receipt']
    candidate = value['candidate']
    model = value['model']
    if (value['contentHash'] != canonical_sha256({k: v for k, v in value.items() if k != 'contentHash'})
            or value['teamId'] != team_id or job['teamId'] != team_id or job['id'] != job_id
            or any(output['jobId'] != job_id for output in outputs)
            or len({output['id'] for output in outputs}) != len(outputs)):
        fail()
    if model is not None and (model['id'] != job['modelProjectId'] or model['teamId'] != team_id or model['portableProjectId'] != job['portableProjectId']):
        fail()
    if request is not None:
        source = request['source']['modelProject']
        if (request['submissionHash'] != job['submissionHash'] or source['id'] != job['modelProjectId']
                or source['portableProjectId'] != job['portableProjectId']
                or source['revision'] != job['sourceProjectRevision']):
            fail()
    payload = {output['id']: output['contentHash'] for output in outputs if output['kind'] != 'receipt'}
    receipt_outputs = [output for output in outputs if output['kind'] == 'receipt']
    if receipt is not None:
        if (receipt['jobId'] != job_id or receipt['teamId'] != team_id
                or receipt['submissionHash'] != job['submissionHash']
                or len(receipt['outputs']) != len(payload)
                or len({ref['id'] for ref in receipt['outputs']}) != len(receipt['outputs'])
                or {ref['id']: ref['contentHash'] for ref in receipt['outputs']} != payload
                or request is not None and receipt['manifestHash'] != request['source']['harnessRunManifest']['contentHash']):
            fail()
    if (len(receipt_outputs) > 1 or receipt is None and receipt_outputs
            or receipt_outputs and (receipt_outputs[0]['id'] != receipt['id'] + ':output'
                                    or receipt_outputs[0]['contentHash'] != canonical_sha256(receipt))):
        fail()
    if (candidate is not None) != (value['candidateState'] == 'retained'):
        fail()
    if candidate is not None:
        artifact = next((output for output in outputs if output['id'] == candidate['artifact']['id']
                         and output['contentHash'] == candidate['artifact']['contentHash']), None)
        if (request is None or job['state'] != 'succeeded' or job['kind'] != 'policy_optimize'
                or job.get('executionMode') or receipt is None or not receipt['cleanupComplete']
                or artifact is None or artifact['kind'] != 'adapter'
                or artifact['metadata'].get('checkpointId') != candidate['checkpointId']
                or (candidate['composition'] == 'base') != (candidate['parent'] is None)):
            fail()
        source = request['source']
        refs = [source[key] for key in ('harnessRunManifest', 'harnessRelease', 'tasksetRelease', 'dataset')]
        refs.extend(source['evidenceSets'])
        if any(ref not in receipt['inputs'] for ref in refs):
            fail()
    if value['savedVersion'] is not None:
        from .training_model_identity import verify_training_model_version
        saved = value['savedVersion']
        verify_training_model_version(saved, team_id, job['modelProjectId'], job_id)
        if (request is None or candidate is None or canonical_sha256(saved['request']) != canonical_sha256(request)
                or saved['candidate'] != {k: v for k, v in candidate.items() if k != 'registryArtifactId'}):
            fail()
