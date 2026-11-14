"""Build and bind a reviewable candidate. This command never publishes."""
from __future__ import annotations
import argparse,hashlib,json,subprocess,zipfile,tarfile,ast
try:import tomllib
except ImportError:import tomli as tomllib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--expected-version',required=True)
p.add_argument('--build-timeout-seconds',type=int,default=180,help='Maximum time for the source distribution and isolated wheel build (default 180).')
args=p.parse_args()
if not 1 <= args.build_timeout_seconds <= 1800:p.error('--build-timeout-seconds must be between 1 and 1800')
metadata=tomllib.loads((ROOT/'pyproject.toml').read_text())['project']
if metadata['name']!='ponder-sdk' or metadata['version']!=args.expected_version:raise SystemExit('Candidate package/version differs from reviewed input.')
output=args.output.resolve();output.mkdir(parents=True,exist_ok=False)
subprocess.run(['uv','build','--project',str(ROOT),'--no-sources','--out-dir',str(output/'distributions')],check=True,timeout=args.build_timeout_seconds)
artifacts=sorted(file for file in (output/'distributions').glob('*') if file.name.endswith(('.whl','.tar.gz')))
if len(artifacts)!=2 or {file.suffix for file in artifacts}!={'.whl','.gz'}:raise SystemExit('Expected exactly one wheel and one source distribution.')
# Validate the actual distributable boundary before issuing its candidate receipt.
for artifact in artifacts:
    if artifact.suffix == '.whl':
        with zipfile.ZipFile(artifact) as archive: names=archive.namelist()
    else:
        with tarfile.open(artifact) as archive: names=archive.getnames()
    if any(Path(name).name in {'worker_envelopes.py','worker-schemas.json'} or 'private-worker' in Path(name).parts or 'reference' in Path(name).parts for name in names):
        raise SystemExit('Public Python artifacts must not contain internal execution implementations.')
    if artifact.suffix == '.whl':
        with zipfile.ZipFile(artifact) as archive:
            for name in names:
                if not name.startswith('ponder_sdk/') or not name.endswith('.py'): continue
                for node in ast.walk(ast.parse(archive.read(name).decode('utf-8'))):
                    imported = [item.name for item in node.names] if isinstance(node,ast.Import) else [node.module or ''] if isinstance(node,ast.ImportFrom) and node.level == 0 else []
                    if any(item.split('.')[0] in {'torch','transformers','peft','safetensors','openpond_model_runtime'} for item in imported):
                        raise SystemExit('Public Python artifacts must not import numerical worker implementations.')
sha=lambda file:hashlib.sha256(file.read_bytes()).hexdigest()
source={str(file.relative_to(ROOT)):sha(file) for directory in ('src','tools','examples','tests') for file in sorted((ROOT/directory).rglob('*')) if file.is_file() and '__pycache__' not in file.parts}
for name in ('pyproject.toml','uv.lock','README.md','LICENSE','hatch_build.py','.gitignore'):source[name]=sha(ROOT/name)
manifest={'schemaVersion':'openpond.pythonSdkReleaseCandidate.v1','distribution':metadata['name'],'version':metadata['version'],'artifacts':{file.name:sha(file) for file in artifacts},'sourceFiles':source,'publication':'HELD: reviewed exact artifacts and independently verified PyPI publisher ownership required; no publish attempted','hostedQualification':'not inferred from build/consumer proofs'}
(output/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'manifest':str(output/'manifest.json'),'sha256':sha(output/'manifest.json'),'publication':'NOT_ATTEMPTED'}))
