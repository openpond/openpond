"""Read immutable source tasks. Never write back into the upstream snapshot."""
import hashlib
import json
import re
from pathlib import PurePosixPath
import pyarrow.parquet as pq

REVISION = "639865fd3374018d6cb29b9fb82dd531406fcf5f"
CODE_HASH = "e15733cf2451cfbc5492a4120f7f8cfddbad818aa9f0b324c79888dd1fece161"
LOCK_REVISION = "78ab98e7b7c5d1f6c4a0cbd6fe89921a7fb9732e"
LOCK_HASH = "2802b857857189561704afe4ad6505843cb3312c2e0315f3dbf14c2ed276309a"
LOCK_URL = f"https://raw.githubusercontent.com/adithya-s-k/FineEnvs/{LOCK_REVISION}/tooling/mimo-rl-explorer/mimo_harbor/images.lock.json"

def digest(data):
    return hashlib.sha256(data).hexdigest()

def code_tasks(root):
    raw = (root / "source/code.parquet").read_bytes()
    if digest(raw) != CODE_HASH:
        raise ValueError("Pinned Code source hash mismatch")
    rows = pq.read_table(root / "source/code.parquet").to_pylist()
    if len(rows) != 2698:
        raise ValueError("Pinned Code row count mismatch")
    mapping = {m["dataset_image"]: m["dockerhub_image"] for m in
               map(json.loads, (root / "source/image-mapping.jsonl").read_text().splitlines())}
    raw_lock = (root / "source/fineenvs-images.lock.json").read_bytes()
    if digest(raw_lock) != LOCK_HASH:
        raise ValueError("Pinned image digest inventory hash mismatch")
    lock = json.loads(raw_lock)
    result = {}
    for index, row in enumerate(rows):
        instance = json.loads(row["extra_info"]["instance_json"])
        task_id = instance["instance_id"]
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", task_id) or task_id in result:
            raise ValueError("Invalid or duplicate task identity")
        cwd = PurePosixPath(instance["cwd"])
        if not cwd.is_absolute() or ".." in cwd.parts or str(cwd) == "/":
            raise ValueError(f"{task_id}: unsafe task directory")
        origin = mapping[instance["docker_image"]]
        tag = origin.rsplit(":", 1)[1]
        image_digest = lock[tag]
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", image_digest):
            raise ValueError(f"{task_id}: unpinned image")
        result[task_id] = {"id": task_id, "rowIndex": index, "instance": instance,
                           "image": origin.rsplit(":", 1)[0] + "@" + image_digest,
                           "sourceImageTag": origin}
    return result
