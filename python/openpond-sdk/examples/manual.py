"""Native reviewed-batch orchestration; each mutation is selected explicitly.

OPENPOND_API_URL / OPENPOND_API_KEY / OPENPOND_TEAM_ID are existing credentials,
not a second login. Never execute this example as a test without approval.
"""
import argparse,asyncio,json,os
from datetime import datetime,timezone
from pathlib import Path
from ponder_sdk import AsyncClient,ProtocolError

async def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('action',choices=['prepare','start','status','results','cancel'])
    parser.add_argument('input',type=Path);parser.add_argument('output',type=Path)
    args=parser.parse_args()
    raw=args.input.read_bytes()
    if len(raw)>1048576:raise ProtocolError('input_too_large')
    value=json.loads(raw)
    async with AsyncClient(base_url=os.environ['OPENPOND_API_URL'],api_key=os.environ['OPENPOND_API_KEY'],team_id=os.environ['OPENPOND_TEAM_ID']) as client:
        if args.action=='prepare':
            capabilities=await client.training.capabilities()
            if 'grpo' not in capabilities['methods']:raise ProtocolError('grpo_not_available')
            response=await client.training.prepare_run(value)
        else:
            retained=await client.training.get_preparation(value['plan']['id'])
            if retained['plan']['contentHash']!=value['plan']['contentHash']:raise ProtocolError('preparation_identity_mismatch')
            if args.action=='start':
                if retained['state']!='prepared':raise ProtocolError('reconcile_existing_preparation')
                # No estimate endpoint is invented. The retained request already
                # binds explicit maximum spend; fresh offerings/server admission apply.
                catalog=await client.training.gpu_catalog()
                if datetime.fromisoformat(catalog['expiresAt'].replace('Z','+00:00'))<=datetime.now(timezone.utc):raise ProtocolError('gpu_catalog_expired')
                catalog_fd=os.open(args.output.with_suffix(args.output.suffix+'.catalog.json'),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
                with os.fdopen(catalog_fd,'w',encoding='utf-8') as file:json.dump(catalog,file)
                response=await client.training.start_preparation(retained['plan']['id'],{'teamId':client.team_id,'planHash':retained['plan']['contentHash'],'expectedRevision':retained['revision']})
            elif args.action=='cancel':
                if retained['jobId']:
                    job=await client.training.get_job(retained['jobId'])
                    response=await client.training.cancel_job(job['id'],{'expectedVersion':job['version']})
                else:response=await client.training.cancel_preparation(retained['plan']['id'],{'teamId':client.team_id,'planHash':retained['plan']['contentHash'],'expectedRevision':retained['revision']})
            elif args.action=='status':response={'preparation':retained,'job':await client.training.get_job(retained['jobId']) if retained['jobId'] else None}
            else:
                if not retained['jobId']:raise ProtocolError('preparation_not_submitted')
                response=await client.training.outputs(retained['jobId'])
        # Receipts may contain private evidence. Do not print them to a shared log.
        fd=os.open(args.output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w',encoding='utf-8') as file:json.dump(response,file,ensure_ascii=True)
    print('Saved the retained response. Execution/acceptance remain separate gates.')

asyncio.run(asyncio.wait_for(main(),timeout=120))
