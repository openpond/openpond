"""Verify shared admission and native no-op/reference grading for one task."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import time
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--root", type=Path, required=True)
parser.add_argument("--task", required=True)
parser.add_argument("--reference-patch", type=Path, required=True)
args = parser.parse_args()
status = args.root / "cleanup/shared-runtime-qualification.json"
state = {"pid": os.getpid(), "taskId": args.task, "coverage": "One representative task; common package covers all 2698 IDs"}
def checkpoint(stage, **details):
    state.update(status=stage, updatedAt=time.time(), **details)
    temporary = status.with_suffix(".writing")
    temporary.write_text(json.dumps(state, indent=2))
    temporary.replace(status)
    print(json.dumps({"status": stage, **details}), flush=True)

checkpoint("loading_runtime")
module_path = args.root / "runtime-code/graders/mimo_code_bridge.py"
spec = importlib.util.spec_from_file_location("mimo_code_bridge", module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
bridge = None
try:
    checkpoint("warming_selected_image")
    bridge = module.Bridge(module.ROOT, args.task)
    initialized = bridge.initialize()
    receipt = bridge.runtime.receipt
    identity = bridge.runtime.execute("id -u; grep -E 'Cap(Eff|Bnd)|NoNewPrivs' /proc/self/status; git rev-list --all --count; git fsck --full --no-reflogs --unreachable")
    if identity.returncode or not identity.stdout.startswith(b"65532\n") or b"0000000000000000" not in identity.stdout:
        raise ValueError("Agent privilege isolation check failed")
    checkpoint("grading_no_op", admission=receipt, agentIdentity=identity.stdout.decode())
    baseline = bridge.finish("qualification_no_op")
    bridge.close()
    bridge = None
    if baseline["reward"] != 0:
        raise ValueError("Unchanged baseline received a positive reward")
    checkpoint("grading_reference", noOpReward=baseline["reward"])
    bridge = module.Bridge(module.ROOT, args.task)
    bridge.initialize()
    with tempfile.TemporaryDirectory(prefix="qualification-reference-") as temporary:
        readable = Path(temporary) / "reference.patch"
        readable.write_bytes(args.reference_patch.read_bytes())
        readable.chmod(0o644)
        bridge.docker.run("cp", str(readable), bridge.runtime.name + ":/tmp/qualification-reference.patch")
    applied = bridge.runtime.execute("git -c core.hooksPath=/dev/null apply /tmp/qualification-reference.patch")
    if applied.returncode:
        raise ValueError("Trusted reference patch did not apply")
    reference = bridge.finish("qualification_reference")
    if reference["reward"] != 1:
        raise ValueError("Trusted reference failed native grading")
    checkpoint("complete", referenceReward=reference["reward"], nativeProtocol="openpond.managedRlJsonlRuntime.v1",
        publicationQualification="independent_residual_review_and_additional_image_qualification_pending")
except BaseException as error:
    checkpoint("failed", errorType=type(error).__name__, message=str(error)[:1000])
    raise
finally:
    if bridge is not None:
        bridge.close()
