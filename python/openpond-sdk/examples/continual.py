"""Inspect a pinned policy or explicitly send an existing Learning command.

This orchestrates published resources; it does not run Python Reward/Harness code.
"""
import argparse,asyncio,json,os
from pathlib import Path
from ponder_sdk import AsyncClient,ProtocolError

async def main():
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['inspect','command']);parser.add_argument('input',type=Path);parser.add_argument('output',type=Path);args=parser.parse_args()
    raw=args.input.read_bytes()
    if len(raw)>16777216:raise ProtocolError('input_too_large')
    value=json.loads(raw)
    async with AsyncClient(base_url=os.environ['OPENPOND_API_URL'],api_key=os.environ['OPENPOND_API_KEY'],team_id=os.environ['OPENPOND_TEAM_ID']) as client:
        # Keep the command's original operationId after uncertain replies.
        response=await client.learning.inspect_policy({'action':'inspect_policy','scope':client.team_id,'policy':value}) if args.action=='inspect' else await client.learning.command({'scope':client.team_id,'command':value})
        fd=os.open(args.output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w',encoding='utf-8') as file:json.dump(response,file,ensure_ascii=True)
    print('Saved the retained response. Inspection does not reserve an iteration.')

asyncio.run(main())
