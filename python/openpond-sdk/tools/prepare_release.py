"""Build and bind a reviewable candidate. This command never publishes."""
from __future__ import annotations
import argparse,hashlib,json,subprocess
try:import tomllib
except ImportError:import tomli as tomllib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--expected-version',required=True);args=p.parse_args()
metadata=tomllib.loads((ROOT/'pyproject.toml').read_text())['project']
if metadata['name']!='ponder-sdk' or metadata['version']!=args.expected_version:raise SystemExit('Candidate package/version differs from reviewed input.')
output=args.output.resolve();output.mkdir(parents=True,exist_ok=False)
subprocess.run(['uv','build','--project',str(ROOT),'--no-sources','--out-dir',str(output/'distributions')],check=True,timeout=180)
artifacts=sorted(file for file in (output/'distributions').glob('*') if file.name.endswith(('.whl','.tar.gz')))
if len(artifacts)!=2 or {file.suffix for file in artifacts}!={'.whl','.gz'}:raise SystemExit('Expected exactly one wheel and one source distribution.')
sha=lambda file:hashlib.sha256(file.read_bytes()).hexdigest()
source={str(file.relative_to(ROOT)):sha(file) for directory in ('src','tools','examples','tests') for file in sorted((ROOT/directory).rglob('*')) if file.is_file() and '__pycache__' not in file.parts}
for name in ('pyproject.toml','uv.lock','README.md','LICENSE'):source[name]=sha(ROOT/name)
manifest={'schemaVersion':'openpond.pythonSdkReleaseCandidate.v1','distribution':metadata['name'],'version':metadata['version'],'artifacts':{file.name:sha(file) for file in artifacts},'sourceFiles':source,'publication':'HELD: reviewed exact artifacts and independently verified PyPI publisher ownership required; no publish attempted','hostedQualification':'not inferred from build/consumer proofs'}
(output/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'manifest':str(output/'manifest.json'),'sha256':sha(output/'manifest.json'),'publication':'NOT_ATTEMPTED'}))
