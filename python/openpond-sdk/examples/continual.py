"""One explicit existing continual transition or finite retained snapshot.

Reservation may trigger paid host dispatch. Never replay an uncertain mutation
with a new operation ID; use read-only reconcile/status instead.
"""
import argparse,asyncio,json,os
from pathlib import Path
from ponder_sdk import AsyncClient,ProtocolError
from ponder_sdk.wire import validate

async def main():
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['inspect','command','reserve','reconcile','status','results','cancel','retry']);parser.add_argument('input',type=Path);parser.add_argument('output',type=Path);args=parser.parse_args()
    raw=args.input.read_bytes()
    if len(raw)>16777216:raise ProtocolError('input_too_large')
    value=json.loads(raw)
    async with AsyncClient(base_url=os.environ['OPENPOND_API_URL'],api_key=os.environ['OPENPOND_API_KEY'],team_id=os.environ['OPENPOND_TEAM_ID']) as client:
        scope=client.team_id
        if args.action=='inspect':response=await client.learning.inspect_policy({'action':'inspect_policy','scope':scope,'policy':value})
        elif args.action=='reconcile':
            value=validate('LearningCommandSchema',value,request=True)
            if value.get('action')!='reserve_iteration' or value['trigger']['kind']!='manual':raise ProtocolError('manual_reservation_command_required')
            inspection=await client.learning.inspect_policy({'action':'inspect_policy','scope':scope,'policy':value['policy']})
            if not inspection['chain']:raise ProtocolError('reservation_not_observed')
            cursor=None;seen=set();response=None
            for _ in range(10):
                page=await client.learning.list({'action':'list','scope':scope,'kind':'reservation','parentId':inspection['chain']['id'],'limit':100,**({'afterId':cursor} if cursor else {})})
                reservation=next((r for r in page['items'] if r['policy']==value['policy'] and r['trigger']==value['trigger']),None)
                if reservation:
                    iteration=await client.learning.get({'action':'get','scope':scope,'kind':'iteration','id':reservation['iterationId']})
                    response={'reservation':reservation,'iteration':iteration};break
                cursor=page['nextCursor']
                if not cursor:break
                if cursor in seen:raise ProtocolError('repeated_cursor')
                seen.add(cursor)
            if response is None:raise ProtocolError('reservation_not_observed_no_replay')
        elif args.action in ('command','reserve'):
            if (args.action=='reserve')!=(value.get('action')=='reserve_iteration'):raise ProtocolError('explicit_reserve_required')
            if args.action=='reserve' and value['trigger']['kind']!='manual':raise ProtocolError('manual_trigger_required')
            operation=await client.learning.command({'scope':scope,'command':value})
            iteration=next((r for r in operation['resources'] if r['schemaVersion']=='openpond.learningIteration.v1'),None)
            response={'operation':operation,**({'iteration':iteration} if iteration else {})}
        else:
            retained=value['iteration']
            iteration=await client.learning.get({'action':'get','scope':scope,'kind':'iteration','id':retained['id']})
            if iteration['policy']!=retained['policy'] or iteration['dispatchId']!=retained['dispatchId']:raise ProtocolError('iteration_binding_changed')
            if args.action in ('cancel','retry'):
                if args.action=='retry':
                    dispatch=await client.learning.get({'action':'get','scope':scope,'kind':'dispatch','id':iteration['dispatchId']})
                    if dispatch['iterationId']!=iteration['id'] or dispatch['state']!='blocked':raise ProtocolError('dispatch_not_blocked')
                operation=await client.learning.command({'scope':scope,'command':{'action':'cancel_iteration' if args.action=='cancel' else 'retry_iteration_dispatch','operationId':value['operationId'],'iterationId':iteration['id'],'expectedRevision':iteration['revision']}})
                response={'operation':operation,'iteration':next((r for r in operation['resources'] if r['schemaVersion']=='openpond.learningIteration.v1'),iteration)}
            else:
                page=await client.learning.list({'action':'list','scope':scope,'kind':'dispatch','parentId':iteration['id'],'limit':2})
                if page['nextCursor'] or len(page['items'])>1 or any(d['id']!=iteration['dispatchId'] for d in page['items']):raise ProtocolError('ambiguous_dispatch_identity')
                dispatch=page['items'][0] if page['items'] else None
                # Worker commits iteration and dispatch together, but these HTTP
                # reads are separate snapshots. Refresh once and refuse a race.
                iteration=await client.learning.get({'action':'get','scope':scope,'kind':'iteration','id':retained['id']})
                if iteration['policy']!=retained['policy'] or iteration['dispatchId']!=retained['dispatchId']:raise ProtocolError('iteration_binding_changed')
                if dispatch and (dispatch['iterationId']!=iteration['id'] or dispatch['policy']!=iteration['policy'] or dispatch['execution']!=iteration['trainingJob']):raise ProtocolError('snapshot_changed_read_again')
                if dispatch is None and iteration['trainingJob'] is not None:raise ProtocolError('snapshot_changed_read_again')
                job=await client.training.get_job(iteration['trainingJob']['id']) if iteration['trainingJob'] else None
                if job and (job['id']!=iteration['trainingJob']['id'] or job['submissionHash']!=iteration['trainingJob']['contentHash']):raise ProtocolError('training_execution_identity_mismatch')
                if args.action=='results' and (not dispatch or dispatch['state']!='settled' or not dispatch['terminalReceipt']):raise ProtocolError('terminal_cleanup_receipt_not_observed')
                if args.action=='results' and job is None and (iteration['status']!='cancelled' or dispatch['execution'] is not None):raise ProtocolError('terminal_job_not_observed')
                response={'iteration':iteration,'dispatch':dispatch,'job':job}
                if args.action=='results' and job:response['outputs']=await client.training.outputs(job['id'])
        fd=os.open(args.output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w',encoding='utf-8') as file:json.dump(response,file,ensure_ascii=True)
    print('Saved one retained transition/snapshot. Local timeout does not cancel remote work.')

# Total client workflow is bounded, including multiple sequential public reads.
asyncio.run(asyncio.wait_for(main(),timeout=120))
