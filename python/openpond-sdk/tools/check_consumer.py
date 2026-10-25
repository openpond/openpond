"""Install the same reviewed wheel with pip and uv in disposable clean consumers.

Failure story: a workspace-only import or omitted schema/native runtime file can
pass editable checks but fail for actual customers. No API/compute is contacted.
"""
from __future__ import annotations
import argparse,hashlib,json,shutil,subprocess,sys,tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('wheel',type=Path);p.add_argument('--sha256',required=True);p.add_argument('--receipt',type=Path,required=True);p.add_argument('--python',default=sys.executable);args=p.parse_args()
wheel=args.wheel.resolve()
if hashlib.sha256(wheel.read_bytes()).hexdigest()!=args.sha256:raise SystemExit('Wheel hash mismatch.')
proof='''import json,sys
from pathlib import Path
import ponder_sdk
from ponder_sdk import Client,AsyncClient,models,inputs,canonical_json
from ponder_sdk.wire import schemas
origin=Path(ponder_sdk.__file__).resolve()
assert Path(sys.prefix).resolve() in origin.parents
assert ponder_sdk.__version__=='0.1.1'
assert schemas()['schemas']['TrainingPreparationReceiptSchema']
assert models.TrainingPreparationReceipt.__annotations__
assert inputs.TrainingPreparationRequest.__annotations__
assert canonical_json({'2':2,'10':1})=='{"2":2,"10":1}'
print(json.dumps({'installedFromWheel':True,'runtime':'python','pythonVersion':sys.version.split()[0],'schemas':len(schemas()['schemas']),'noNodeSubprocess':True}))
'''
results=[]
with tempfile.TemporaryDirectory(prefix='ponder-sdk-consumer-') as temporary:
    root=Path(temporary);copy=root/wheel.name;shutil.copyfile(wheel,copy)
    for installer in ('pip','uv'):
        environment=root/installer
        subprocess.run(['uv','venv','--python',args.python,*(['--seed'] if installer=='pip' else []),str(environment)],check=True,timeout=120)
        python=environment/('Scripts/python.exe' if sys.platform=='win32' else 'bin/python')
        command=[str(python),'-m','pip','install','--disable-pip-version-check','--no-input',str(copy)] if installer=='pip' else ['uv','pip','install','--python',str(python),str(copy)]
        subprocess.run(command,cwd=root,check=True,timeout=180)
        result=subprocess.run([str(python),'-I','-c',proof],cwd=root,capture_output=True,text=True,check=True,timeout=30)
        results.append({'installer':installer,**json.loads(result.stdout)})
    receipt={'schemaVersion':'openpond.pythonSdkCleanConsumer.v1','wheel':wheel.name,'sha256':args.sha256,'results':results,'temporaryConsumersRemovedOnExit':True,'publication':'not attempted','hostedExecution':'not attempted'}
with args.receipt.open('x',encoding='utf-8') as file:json.dump(receipt,file,indent=2);file.write('\n')
print(json.dumps({'status':'PASS','consumerCount':len(results),'receipt':str(args.receipt)}))
