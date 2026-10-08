"""Capture pinned MiMo source rows without projecting private tests into prompts."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request
import pyarrow.parquet as pq

REPOSITORY = "XiaomiMiMo/MiMo-V2.6-RL-oss"
REVISION = "639865fd3374018d6cb29b9fb82dd531406fcf5f"
SOURCES = {
    "code": ("code.parquet", 2698, 13314620, "e15733cf2451cfbc5492a4120f7f8cfddbad818aa9f0b324c79888dd1fece161"),
    "cyber": ("cyber.parquet", 1000, 227632, "9e6e69034f4f3e6cfb5c901de642dddc7f4bacf35ab886b0e8eb53eb03084ba1"),
    "general": ("general/train.parquet", 989, 3122244, "9bfdc8b05d2bf2cb9e89815443d35507e4be30368aebf70928421795c10259b9"),
    "music": ("music.parquet", 1000, 135467, "8fa2c95fb008df032eae184f3304dd3a73e3d25727e3aac0a715484859fa4856"),
    "webdev": ("webdev.parquet", 2093, 4120378, "56ca6c96642666a27b756e20694ba60a4386d1761baadae86fd6768553d2cbac"),
}

def prepare(root, inventory):
    source_root = root / "source"
    output_root = root / "prepared"
    output_root.mkdir(parents=True, exist_ok=True)
    original = json.loads(inventory.read_text())
    if original["dataset"] != REPOSITORY or original["revision"] != REVISION:
        raise ValueError("Source inventory differs from the pinned original dataset")
    descriptors = {entry["domain"]: entry for entry in original["domains"]}
    for domain, (relative, count, size, reviewed_hash) in SOURCES.items():
        descriptor = descriptors[domain]
        if (descriptor["file"], descriptor["rows"], descriptor["bytes"]) != (relative, count, size):
            raise ValueError(f"{domain}: inventory counts or path changed")
        if reviewed_hash and descriptor["sha256"] != reviewed_hash:
            raise ValueError(f"{domain}: inventory hash changed")
        source = source_root / relative
        source.parent.mkdir(parents=True, exist_ok=True)
        if not source.exists():
            urllib.request.urlretrieve(f"https://huggingface.co/datasets/{REPOSITORY}/resolve/{REVISION}/{relative}", source)
        raw = source.read_bytes()
        if len(raw) != size or hashlib.sha256(raw).hexdigest() != descriptor["sha256"]:
            raise ValueError(f"{domain}: source bytes differ from reviewed inventory")
        rows = pq.read_table(source).to_pylist()
        if len(rows) != count:
            raise ValueError(f"{domain}: source row count changed")
        tasks, ids = [], set()
        for index, row in enumerate(rows):
            extra = row["extra_info"]
            instance = json.loads(extra["instance_json"]) if "instance_json" in extra else extra
            source_id = str(instance.get("instance_id") or instance.get("src_id") or index)
            task_id = f"mimo-{domain}-{source_id}"
            if task_id in ids:
                raise ValueError(f"{domain}: duplicate source task ID {source_id}")
            ids.add(task_id)
            messages = row["prompt"]
            if not messages or any(not isinstance(item.get("content"), str) for item in messages):
                raise ValueError(f"{task_id}: malformed original prompt")
            tags = [domain, row["data_source"]]
            for field in ("category", "subcategory", "tag"):
                value = instance.get(field)
                if isinstance(value, str) and value.strip(): tags.append(value)
            if "env_task_dir" in instance:
                tags.append("workplace")
                industry = source_id.removeprefix("s3k_").split("_", 1)[-1].split("_en_", 1)[0]
                if industry in descriptor["workplace_categories"]: tags.append(industry)
            tasks.append({
                "schemaVersion": "openpond.taskData.v1", "id": task_id,
                "clusterKey": task_id, "split": "train", "input": {"messages": messages},
                "expectedOutput": None, "policyVisibleContext": {},
                "privilegedContextRef": f"mimo-{domain}-source-row-{index}",
                "sourceRefs": [f"mimo-{domain}-source"], "tags": tags,
                "metadata": {"sourceRowIndex": index, "sourceTaskId": source_id,
                             "sourceDataSource": row["data_source"], "sourceFileHash": descriptor["sha256"]},
            })
        output = {"repository": REPOSITORY, "revision": REVISION, "descriptor": descriptor, "tasks": tasks}
        destination = output_root / f"{domain}.json"
        destination.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")))
        print(json.dumps({"domain": domain, "tasks": len(tasks), "sourceHash": descriptor["sha256"], "preparedBytes": destination.stat().st_size}), flush=True)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--inventory", type=Path, required=True)
    args = parser.parse_args()
    prepare(args.root, args.inventory)
