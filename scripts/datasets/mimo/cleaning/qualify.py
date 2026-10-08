"""Exercise original hidden tests in fresh, offline grading containers."""
import json
from pathlib import Path
import subprocess
import tempfile
import uuid
from source import digest

def score(docker, task, receipt, root, candidate=None):
    directory = root / "cleanup/code" / task["id"]
    label = "reference" if candidate else "no-op"
    with tempfile.TemporaryDirectory(prefix="grading-", dir=directory) as temporary:
        payload = Path(temporary)
        payload.chmod(0o755)
        instance = task["instance"]
        (payload / "tests.patch").write_text(instance["test_patch"])
        (payload / "request.json").write_text(json.dumps({"cwd": instance["cwd"], "base": receipt["cleanBaselineCommit"], "command": instance["test_command"], "timeout": instance["verifier_timeout_sec"]}))
        (payload / "grade.py").write_bytes((Path(__file__).parent / "grade_guest.py").read_bytes())
        if candidate:
            (payload / "candidate.patch").write_bytes(candidate.read_bytes())
        name = "openpond-mimo-grade-" + uuid.uuid4().hex
        try:
            process = subprocess.run(["docker", "run", "--name", name, "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "256", "--cpus", "2", "--memory", "2g", "--user", "65532:65532", "--mount", f"type=bind,source={payload},target=/run/openpond-grading,readonly", "--entrypoint", "/bin/bash", receipt["cleanImageId"], "-lc", "python3 /run/openpond-grading/grade.py"], env=docker.env, capture_output=True, timeout=instance["verifier_timeout_sec"] + 60)
            output = process.stdout.decode().strip().splitlines()
            result = json.loads(output[-1]) if output else {"status": "unscorable", "errorType": "container_failed"}
            if process.returncode and result["status"] == "scored":
                raise ValueError("Grader exit and score disagree")
            if result["status"] == "scored":
                docker.run("cp", f"{name}:/tmp/qualification-command.log", str(directory / f"{label}-command.log"))
            (directory / f"{label}-result.json").write_text(json.dumps(result, indent=2))
            return result
        finally:
            subprocess.run(["docker", "rm", "-f", name], env=docker.env, capture_output=True, check=False)

def qualify(docker, task, receipt, root, candidate=None):
    baseline = score(docker, task, receipt, root)
    reference = score(docker, task, receipt, root, candidate) if candidate else None
    qualified = baseline.get("status") == "scored" and baseline.get("reward") == 0 and reference is not None and reference.get("status") == "scored" and reference.get("reward") == 1
    result = {"taskId": task["id"], "cleanImageId": receipt["cleanImageId"], "noOp": baseline, "reference": reference,
              "referencePatchHash": digest(candidate.read_bytes()) if candidate else None,
              "status": "scoring_verified_pending_independent_leak_audit" if qualified else "quarantined_scoring_not_verified"}
    (root / "cleanup/code" / task["id"] / "qualification.json").write_text(json.dumps(result, indent=2))
    return result
