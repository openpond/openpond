"""Build flattened Code images; qualify scoring separately before publication."""
import argparse
import json
from pathlib import Path
import sys
import urllib.request
import re
import shlex
import subprocess

sys.path.insert(0, str(Path(__file__).parent / "cleaning"))
from source import code_tasks, LOCK_URL, LOCK_REVISION, REVISION, digest
from docker import Docker
from build import build_image
from qualify import qualify
from audit import audit

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--task", action="append", default=[])
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--qualify", action="store_true")
    parser.add_argument("--reference-commit", help="Trusted source fix commit for a single task; stays private")
    args = parser.parse_args()
    if (args.qualify or args.reference_commit) and not args.apply:
        parser.error("Qualification requires --apply")
    if args.reference_commit and not args.qualify:
        parser.error("A reference commit requires --qualify")
    lock_path = args.root / "source/fineenvs-images.lock.json"
    if not lock_path.exists():
        lock_path.write_bytes(urllib.request.urlopen(LOCK_URL, timeout=60).read())
    tasks = code_tasks(args.root)
    plan = {"schemaVersion": "openpond.mimoCodeCleanupPlan.v1", "sourceRevision": REVISION,
            "imageLockSource": LOCK_URL, "imageLockRevision": LOCK_REVISION,
            "imageLockHash": digest(lock_path.read_bytes()), "taskCount": len(tasks),
            "tasks": [{k: t[k] for k in ("id", "rowIndex", "image", "sourceImageTag")} for t in tasks.values()]}
    output = args.root / "cleanup"
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    (output / "code-plan.json").write_text(json.dumps(plan, indent=2))
    print(json.dumps({"plannedTasks": len(tasks), "plan": str(output / "code-plan.json")}))
    if not args.apply:
        return
    if bool(args.task) == args.all:
        raise ValueError("Choose --task ID (repeatable) or --all with --apply")
    if args.reference_commit and (len(args.task) != 1 or not re.fullmatch(r"[0-9a-f]{40}", args.reference_commit)):
        raise ValueError("A reference commit requires exactly one task and a full commit hash")
    docker = Docker(args.root)
    for task_id in tasks if args.all else args.task:
        task = tasks[task_id]
        try:
            docker.inspect(task["image"])
        except subprocess.CalledProcessError:
            manifest = json.loads(docker.run("manifest", "inspect", task["image"]).stdout)
            compressed = sum(layer["size"] for layer in manifest.get("layers", []))
            if not compressed or compressed > 4_000_000_000:
                raise ValueError("Image requires a larger cleanup worker before pulling")
            docker.run("pull", task["image"], timeout=900)
        receipt = build_image(docker, task, args.root)
        audit(docker, task, receipt, args.root)
        print(json.dumps({k: receipt[k] for k in ("taskId", "sourceBaseCommit", "cleanImageId", "status", "retainedFiles")}))
        if args.qualify:
            candidate = None
            if args.reference_commit:
                candidate = output / "code" / task_id / "reference.patch"
                cwd = shlex.quote(task["instance"]["cwd"])
                commit = args.reference_commit
                patch = docker.guest(task["image"], f"git -c safe.directory={cwd} -C {cwd} diff --binary {commit}^ {commit}").stdout
                if not patch:
                    raise ValueError("Empty reference patch")
                candidate.write_bytes(patch)
                candidate.chmod(0o600)
            result = qualify(docker, task, receipt, args.root, candidate)
            print(json.dumps(result))

if __name__ == "__main__":
    main()
