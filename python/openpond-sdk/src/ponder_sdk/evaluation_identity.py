"""Bind retained evaluation projections; Harness seals remain host-authenticated."""
from __future__ import annotations
from typing import Any
from .errors import ProtocolError
from .wire import canonical_json,canonical_sha256,verify_hash


def details(value: dict[str,Any],team_id: str,identifier: str | None = None,request_body: Any = None) -> None:
    summary=value['summary'];request=value['request'];manifest=value['manifest'];snapshot=value['policySnapshot']
    if summary['teamId']!=team_id or request['teamId']!=team_id or identifier is not None and summary['id']!=identifier:raise ProtocolError('evaluation_scope_mismatch')
    if request_body is not None and canonical_json(request)!=canonical_json(request_body):raise ProtocolError('evaluation_request_mismatch')
    pairs=[(manifest['contentHash'],summary['manifestHash']),(manifest['id'],summary['id']),(manifest['createdAt'],summary['createdAt']),(summary['modelProjectId'],request['modelProjectId']),(summary.get('project'),request.get('project')),(manifest['metadata'].get('project'),request.get('project')),(summary.get('name'),request.get('name')),(summary['operationId'],request['operationId']),(summary['policyKind'],request['policy']['kind']),(summary['totalCount'],len(request['population'])),(summary['metricName'],manifest['metricPolicy']['primaryMetric']),(summary['taskset'],request['taskset']),(manifest['tasksetRelease']['id'],request['taskset']['id']),(manifest['tasksetRelease']['contentHash'],request['taskset']['contentHash']),(manifest['population'],request['population'])]
    if any(canonical_json(left)!=canonical_json(right) for left,right in pairs):raise ProtocolError('evaluation_manifest_mismatch')
    if sum(summary['counts'].values())!=summary['totalCount']:raise ProtocolError('evaluation_population_mismatch')
    terminal=summary['status'] in ('completed','failed','cancelled')
    if terminal and (summary['counts']['pending'] or summary['counts']['running'] or not summary['completedAt']):raise ProtocolError('evaluation_terminal_mismatch')
    if summary['status']!='completed' and summary['score'] is not None or summary['resultAvailable'] and not terminal or summary['status']=='completed' and (not summary['cleanupComplete'] or not summary['resultAvailable']) or summary['status']=='cancelled' and not summary['cleanupComplete']:raise ProtocolError('evaluation_terminal_mismatch')
    if request['policy']['kind']=='fixture':
        if manifest['policy']['kind']!='fixture' or snapshot is not None:raise ProtocolError('evaluation_policy_mismatch')
    elif request['policy']['kind']=='hosted_chat':
        policy=request['policy']
        if manifest['policy']['kind']!='model' or snapshot is None or snapshot['modelId']!=policy['modelId']:raise ProtocolError('evaluation_policy_mismatch')
        model=manifest['policy']['model']
        if model['provider']!=snapshot['provider'] or model['model']!=snapshot['upstreamModelId'] or model['revision'] is not None or model['artifactHash']!=(policy.get('candidate') or {}).get('contentHash') or model['tokenizerRevision'] is not None or model['chatTemplateHash'] is not None or manifest['policy']['configurationHash']!=canonical_sha256({'policy':policy,'snapshot':snapshot}):raise ProtocolError('evaluation_policy_mismatch')
    elif snapshot is not None:raise ProtocolError('evaluation_policy_mismatch')


def result(value: dict[str,Any],team_id:str,identifier:str|None=None) -> None:
    verify_hash(value,'contentHash');details(value['run'],team_id,identifier)
    summary=value['run']['summary'];manifest=value['run']['manifest']
    if not summary['resultAvailable'] or summary['status'] not in ('completed','failed','cancelled'):raise ProtocolError('evaluation_result_not_terminal')
    if [receipt['id'] for receipt in value['receipts']]!=[member['receiptId'] for member in manifest['population']]:raise ProtocolError('evaluation_receipt_order_mismatch')
    metric=value['metric']
    if (summary['status']=='completed')!=(metric is not None):raise ProtocolError('evaluation_metric_mismatch')
    if metric is not None and (metric['runManifest']!={'id':manifest['id'],'contentHash':manifest['contentHash']} or metric['tasksetRelease']!=manifest['tasksetRelease'] or metric['policy']!=manifest['metricPolicy'] or metric['receiptRefs']!=[{'id':receipt['id'],'contentHash':receipt['contentHash']} for receipt in value['receipts']] or metric['value']!=summary['score']):raise ProtocolError('evaluation_metric_mismatch')
