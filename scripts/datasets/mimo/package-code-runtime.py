"""Package one pinned managed-RL runtime shared by all original Code tasks."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys

sys.path.insert(0, str(Path(__file__).parent / "cleaning"))
from source import code_tasks, REVISION

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--root", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
tasks = code_tasks(args.root)
dependencies = {}
def capture(source, relative):
    destination = args.output / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    dependencies[relative] = hashlib.sha256(destination.read_bytes()).hexdigest()
for name in ("code.parquet", "image-mapping.jsonl", "fineenvs-images.lock.json"):
    capture(args.root / "source" / name, "source/" + name)
helper = Path(__file__).parent / "cleaning"
for name in ("source.py", "docker.py", "archive.py", "runtime.py", "process.py", "setup_guest.py", "grade_guest.py"):
    capture(helper / name, "graders/cleaning/" + name)
module = (helper / "bridge.py").read_text().replace("DEPENDENCY_HASHES = {}", "DEPENDENCY_HASHES = " + repr(dependencies))
destination = args.output / "graders/mimo_code_bridge.py"
destination.write_text(module)
module_hash = hashlib.sha256(destination.read_bytes()).hexdigest()
runtime = {"protocolVersion": "openpond.managedRlJsonlRuntime.v1", "module": "graders/mimo_code_bridge.py",
           "moduleSha256": module_hash, "command": ["python3", "-u", "{module}"], "cwd": ".", "maxTurns": 100}
(args.output / "graders/managed-rl-runtime.json").write_text(json.dumps(runtime, indent=2))
manifest = {"schemaVersion": "openpond.mimoCodeRuntimePackage.v1", "sourceRevision": REVISION,
    "taskCount": len(tasks), "runtimeModuleSha256": module_hash, "dependencies": dependencies,
    "toolNames": ["terminal"], "runtimeAdapterId": "portable-jsonl-stateful-v1",
    "agentAccess": "mandatory_shared_cleanup_before_init_response", "publicationQualification": "pending",
    "tasks": [{"id": task["id"], "image": task["image"]} for task in tasks.values()]}
(args.output / "runtime-package.json").write_text(json.dumps(manifest, indent=2))
print(json.dumps({"packagedTasks": len(tasks), "output": str(args.output), "runtimeModuleSha256": module_hash}))
