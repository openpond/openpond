"""Saved-version, registry and routing identity for native serving reads."""
from typing import Any
from .errors import ProtocolError
from .managed_serving_usage_identity import approval_matches, verify_usage_billing
from .serverless_serving import serverless_approval_matches, verify_serverless_review
from .wire import canonical_sha256
from .training_model_identity import verify_training_model_version


def serving_state(value: dict[str, Any]) -> str:
    control = value['control']
    if control is not None and control['desiredState'] == 'stopped':
        return 'retiring' if control['phase'] == 'stopping' else 'unavailable' if value['bindings'] else 'inactive'
    if control is not None and control['phase'] == 'failed':
        return 'unavailable'
    registry = value['registry']
    if registry is None:
        return 'unpublished'
    if not registry['qualified']:
        return 'qualification_pending' if registry['reason'] in ('evaluation_pending', 'post_training_pending') else 'unavailable'
    pools = {row['id']: row for row in value['pools']}
    deployments = {row['id']: row for row in value['deployments']}
    for binding in value['bindings']:
        deployment = deployments.get(binding['deploymentId'], {})
        pool = pools.get(deployment.get('poolId'), {})
        if deployment.get('state') == 'ready' and not deployment.get('revoked') and pool.get('state') == 'ready' and pool.get('endpointRecorded'):
            return 'active'
    if control is not None and control['desiredState'] == 'active' and control['phase'] == 'starting':
        return 'starting'
    if any(row['state'] in ('requested', 'deploying') or pools.get(row['poolId'], {}).get('state') in ('requested', 'provisioning') for row in value['deployments']):
        return 'starting'
    if any(row['state'] == 'deleting' for row in value['deployments'] + value['pools']):
        return 'retiring'
    return 'unavailable' if value['bindings'] else 'inactive'


def verify_training_model_serving(value: dict[str, Any], team_id: str, model_id: str, version_hash: str) -> None:
    def fail() -> None:
        raise ProtocolError('training_model_serving_mismatch')
    verify_usage_billing(value, team_id, model_id, version_hash, 'training')
    if value.get('serverlessReview') is not None:
        verify_serverless_review(value['serverlessReview'], team_id, model_id, version_hash, (value.get('registry') or {}).get('artifact'))
    retained = value.get('control') or {}
    if retained.get('serverless') is not None:
        verify_serverless_review(retained['serverless']['review'], team_id, model_id, retained['versionHash'], retained['artifact'])
    version = value['version']
    verify_training_model_version(version, team_id, model_id)
    if (len({row['operationId'] for row in value['cleanup']}) != len(value['cleanup'])
            or any(row['teamId'] != team_id or row['modelProjectId'] != model_id or row['desiredState'] != 'stopped' for row in value['cleanup'])):
        fail()
    if (value['teamId'] != team_id or value['modelProjectId'] != model_id or version['contentHash'] != version_hash
            or value['contentHash'] != canonical_sha256({k: v for k, v in value.items() if k != 'contentHash'})
            or value['state'] != serving_state(value)):
        fail()

    for key in ('deployments', 'pools', 'bindings'):
        if len({row['id'] for row in value[key]}) != len(value[key]):
            fail()
    registry = value['registry']
    control = value['control']
    if control is not None and (control['teamId'] != team_id or control['modelProjectId'] != model_id
            or control['versionHash'] != version['contentHash'] and not (control['desiredState'] == 'stopped' and control['phase'] == 'stopped')
            or control['desiredState'] == 'active' and registry is not None and control['artifact'] != registry['artifact']):
        fail()
    if registry is None:
        if value['deployments'] or value['pools'] or value['bindings'] or value['lastVerifiedInference']:
            fail()
        return
    source = registry['source']
    if (source['jobId'] != version['jobId'] or source['checkpointId'] != version['candidate']['checkpointId']
            or source['artifact'] != version['candidate']['artifact'] or registry['qualified'] != (registry['reason'] == 'qualified')
            or registry['qualified'] and (registry['state'] != 'promotable' or registry['revoked'] or registry['deleted'])):
        fail()
    deployments = {row['id']: row for row in value['deployments']}
    pools = {row['id']: row for row in value['pools']}
    if (any(row['artifactId'] != registry['artifact']['id'] or row['poolId'] is not None and row['poolId'] not in pools for row in value['deployments'])
            or any(row['artifactId'] != registry['artifact']['id'] or row['deploymentId'] not in deployments for row in value['bindings'])
            or any(row['workersMin'] > row['workersMax'] or not any(deployment['poolId'] == row['id'] for deployment in value['deployments']) for row in value['pools'])):
        fail()
    evidence = value['lastVerifiedInference']
    if evidence and (evidence['artifact'] != registry['artifact'] or evidence['receipt']['id'] != evidence['requestId']
            or deployments.get(evidence['deploymentId'], {}).get('poolId') != evidence['poolId']
            or pools.get(evidence['poolId'], {}).get('workerImageDigest') != evidence['workerImageDigest']):
        fail()

def verify_training_serving_control(value: dict[str, Any], request: dict[str, Any], team_id: str, model_id: str) -> None:
    control = value['control']
    if control.get('serverless') is not None:
        verify_serverless_review(control['serverless']['review'], team_id, model_id, request['versionHash'], request['artifact'])
    if (not serverless_approval_matches(request, control) or not approval_matches(request, control) or value['contentHash'] != canonical_sha256({k: v for k, v in value.items() if k != 'contentHash'})
            or value['request'] != request or value['teamId'] != team_id or request['teamId'] != team_id
            or value['modelProjectId'] != model_id or control['teamId'] != team_id or control['modelProjectId'] != model_id
            or control['actorId'] != value['actorId'] or control['operationId'] != request['operationId']
            or control['versionHash'] != request['versionHash'] or control['artifact'] != request['artifact']
            or control['modelId'] != 'personalized:model:' + model_id
            or control['revision'] != request['expectedRevision'] + 1 or control['idleTimeoutSeconds'] != request['idleTimeoutSeconds']
            or control['desiredState'] != ('active' if request['action'] == 'activate' else 'stopped')
            or request['action'] == 'activate' and control['phase'] not in ('starting', 'active')
            or request['action'] == 'stop' and control['phase'] not in ('stopping', 'stopped')):
        raise ProtocolError('training_model_serving_control_mismatch')
