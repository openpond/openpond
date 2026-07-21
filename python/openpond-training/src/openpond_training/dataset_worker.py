from __future__ import annotations

import argparse
import heapq
import hashlib
import json
from pathlib import Path
import re
import sys
from typing import Any, Iterable
import unicodedata

import pyarrow as pa
import pyarrow.dataset as pads
import pyarrow.parquet as pq


CANONICAL_SCHEMA = pa.schema(
    [
        ("id", pa.string()),
        ("cluster_key", pa.string()),
        ("split", pa.string()),
        ("input_json", pa.string()),
        ("expected_output_json", pa.string()),
        ("policy_visible_context_json", pa.string()),
        ("privileged_context_ref", pa.string()),
        ("source_refs", pa.list_(pa.string())),
        ("tags", pa.list_(pa.string())),
        ("metadata_json", pa.string()),
    ]
)


def materialize(args: argparse.Namespace) -> int:
    control_path = Path(args.control).resolve()
    control = load_json(control_path)
    require_schema(control, "openpond.datasetMaterializeControl.v1")
    output_root = Path(required_string(control, "outputRoot")).resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    file_specs = required_list(control, "files")
    if not all(isinstance(value, dict) for value in file_specs):
        raise ValueError("files must contain source file objects.")
    files = [
        (
            Path(required_string(value, "path")).resolve(),
            required_string(value, "upstreamSplit"),
        )
        for value in file_specs
    ]
    if not files or any(not file.is_file() for file, _split in files):
        raise ValueError("Every verified source Parquet file must exist.")
    mapping = required_record(control, "mapping")
    source_id = required_string(control, "sourceId")
    source_hash = required_string(control, "sourceHash")
    mapping_hash = required_string(mapping, "mappingHash")
    split_policy = required_record(mapping, "splitPolicy")
    shard_rows = positive_int(control.get("shardRows"), 100_000)
    row_group_rows = positive_int(control.get("rowGroupRows"), 10_000)
    preview_rows = positive_int(control.get("previewRows"), 25)

    emit({"type": "progress", "phase": "mapping", "completedRows": 0})
    writers: dict[str, ShardWriter] = {}
    counts = {split: 0 for split in ("train", "validation", "test", "frozen_eval")}
    first_ids: dict[str, str] = {}
    previews: list[dict[str, Any]] = []
    dropped = 0
    duplicate_rows = 0
    processed = 0
    assignments = required_record(split_policy, "assignments")
    seen_rows: dict[str, str] = {}
    cluster_splits: dict[str, str] = {}

    try:
        for file, upstream_split in files:
            assigned_split = assignments.get(upstream_split, upstream_split)
            if assigned_split not in counts:
                raise ValueError(
                    f"Unsupported canonical split {assigned_split!r}."
                )
            dataset = pads.dataset(str(file), format="parquet")
            for batch in dataset.scanner(batch_size=row_group_rows).to_batches():
                canonical: dict[str, list[dict[str, Any]]] = {
                    split: [] for split in counts
                }
                for source_row in batch.to_pylist():
                    processed += 1
                    try:
                        record = canonical_record(
                            source_row,
                            processed - 1,
                            source_id=source_id,
                            source_hash=source_hash,
                            mapping=mapping,
                            mapping_hash=mapping_hash,
                            assigned_split=assigned_split,
                        )
                    except (KeyError, TypeError, ValueError):
                        if mapping.get("invalidRowPolicy") != "drop_with_receipt":
                            raise
                        dropped += 1
                        continue
                    fingerprint = record_fingerprint(record)
                    existing_fingerprint = seen_rows.get(record["id"])
                    if existing_fingerprint is not None:
                        if existing_fingerprint != fingerprint:
                            raise ValueError(
                                "Duplicate mapped row identity produced conflicting "
                                f"content: {record['id']}"
                            )
                        duplicate_rows += 1
                        continue
                    seen_rows[record["id"]] = fingerprint
                    existing_split = cluster_splits.setdefault(
                        record["clusterKey"], record["split"]
                    )
                    if existing_split != record["split"]:
                        raise ValueError(
                            "A Dataset cluster was assigned to more than one split."
                        )
                    split = record["split"]
                    canonical[split].append(physical_record(record))
                    counts[split] += 1
                    first_ids.setdefault(split, record["id"])
                    if len(previews) < preview_rows:
                        previews.append(record)
                for split, rows in canonical.items():
                    if not rows:
                        continue
                    writer = writers.setdefault(
                        split,
                        ShardWriter(
                            output_root=output_root,
                            split=split,
                            shard_rows=shard_rows,
                            row_group_rows=row_group_rows,
                        ),
                    )
                    writer.write(rows)
                if processed % 10_000 < batch.num_rows:
                    emit(
                        {
                            "type": "progress",
                            "phase": "parquet_write",
                            "completedRows": processed,
                            "writtenRows": sum(counts.values()),
                        }
                    )
    finally:
        for writer in writers.values():
            writer.close()

    shards = [
        shard
        for split in ("train", "validation", "test", "frozen_eval")
        for shard in writers.get(split, ShardWriter.empty()).shards
    ]
    if not shards:
        raise ValueError("The approved mapping produced no canonical rows.")
    schema_hash = sha256_bytes(str(CANONICAL_SCHEMA).encode("utf-8"))
    quality = {
        "processedRows": processed,
        "writtenRows": sum(counts.values()),
        "droppedRows": dropped,
        "duplicateRows": duplicate_rows,
        "uniqueRowIdentities": len(seen_rows),
        "uniqueClusters": len(cluster_splits),
        "splitCounts": counts,
        "splitIsolationVerified": True,
        "splitIsolationStrategy": "cluster_key_hash",
    }
    result = {
        "schemaVersion": "openpond.datasetMaterializeResult.v1",
        "rowCount": sum(counts.values()),
        "splitCounts": counts,
        "shards": shards,
        "schemaHash": schema_hash,
        "qualityReport": quality,
        "qualityReportHash": sha256_json(quality),
        "previewRows": previews,
        "firstTaskIds": first_ids,
    }
    result_path = Path(args.result).resolve()
    atomic_json(result_path, result)
    emit(
        {
            "type": "complete",
            "phase": "verification",
            "completedRows": processed,
            "writtenRows": result["rowCount"],
            "result": str(result_path),
        }
    )
    return 0


def rows(args: argparse.Namespace) -> int:
    manifest = load_json(Path(args.manifest).resolve())
    require_schema(manifest, "openpond.datasetArtifact.v1")
    root = Path(args.root).resolve()
    split = args.split
    offset = max(0, args.offset)
    limit = max(1, min(args.limit, 100))
    requested_columns = [
        value.strip() for value in (args.columns or "").split(",") if value.strip()
    ]
    start_shard = getattr(args, "start_shard", None)
    reached_start = start_shard is None
    selected: list[dict[str, Any]] = []
    skipped = 0
    for shard in manifest.get("shards", []):
        if not isinstance(shard, dict):
            continue
        if split and shard.get("split") != split:
            continue
        if not reached_start:
            if shard.get("id") != start_shard:
                continue
            reached_start = True
        relative = required_string(shard, "path")
        file = safe_child(root, relative)
        expected = required_string(shard, "contentHash")
        if sha256_file(file) != expected:
            raise ValueError(f"Dataset shard failed integrity verification: {relative}")
        parquet = pq.ParquetFile(file)
        for batch in parquet.iter_batches(batch_size=256):
            for physical in batch.to_pylist():
                if skipped < offset:
                    skipped += 1
                    continue
                logical = logical_record(physical)
                if requested_columns:
                    logical = {
                        key: value
                        for key, value in logical.items()
                        if key in requested_columns
                    }
                selected.append(logical)
                if len(selected) >= limit:
                    print(json.dumps({"rows": selected}, ensure_ascii=False))
                    return 0
    if not reached_start:
        raise ValueError("Dataset row cursor referenced an unknown shard.")
    print(json.dumps({"rows": selected}, ensure_ascii=False))
    return 0


def task(args: argparse.Namespace) -> int:
    manifest = load_json(Path(args.manifest).resolve())
    require_schema(manifest, "openpond.datasetArtifact.v1")
    root = Path(args.root).resolve()
    for shard in manifest.get("shards", []):
        if not isinstance(shard, dict):
            continue
        if args.split and shard.get("split") != args.split:
            continue
        relative = required_string(shard, "path")
        file = safe_child(root, relative)
        expected = required_string(shard, "contentHash")
        if sha256_file(file) != expected:
            raise ValueError(
                f"Dataset shard failed integrity verification: {relative}"
            )
        parquet = pq.ParquetFile(file)
        for batch in parquet.iter_batches(batch_size=256):
            for physical in batch.to_pylist():
                if physical.get("id") == args.task_id:
                    print(
                        json.dumps(
                            {"task": logical_record(physical)},
                            ensure_ascii=False,
                        )
                    )
                    return 0
    raise ValueError(f"Dataset task was not found: {args.task_id}")


def project(args: argparse.Namespace) -> int:
    manifest = load_json(Path(args.manifest).resolve())
    require_schema(manifest, "openpond.datasetArtifact.v1")
    root = Path(args.root).resolve()
    output = Path(args.output).resolve()
    split = args.split
    limit = max(1, min(args.limit, 100_000))
    mode = args.mode
    approved_sources = {
        value.strip()
        for value in (args.approved_sources or "").split(",")
        if value.strip()
    }
    selection_strategy = getattr(args, "selection_strategy", "stable_hash_top_n")
    selected: list[tuple[int, str, str]] = []
    seen: dict[str, str] = {}
    seen_curriculum_prompts: set[str] = set()
    eligible_rows = 0
    duplicate_rows = 0

    for shard in manifest.get("shards", []):
        if not isinstance(shard, dict) or shard.get("split") != split:
            continue
        relative = required_string(shard, "path")
        file = safe_child(root, relative)
        expected = required_string(shard, "contentHash")
        if sha256_file(file) != expected:
            raise ValueError(
                f"Dataset shard failed integrity verification: {relative}"
            )
        parquet = pq.ParquetFile(file)
        for batch in parquet.iter_batches(batch_size=1_024):
            for physical in batch.to_pylist():
                logical = logical_record(physical)
                if approved_sources and not all(
                    source in approved_sources
                    for source in logical["sourceRefs"]
                ):
                    continue
                fingerprint = record_fingerprint(logical)
                existing_fingerprint = seen.get(logical["id"])
                if existing_fingerprint is not None:
                    if existing_fingerprint != fingerprint:
                        raise ValueError(
                            "Duplicate artifact row identity produced conflicting "
                            f"content: {logical['id']}"
                        )
                    duplicate_rows += 1
                    continue
                seen[logical["id"]] = fingerprint
                if selection_strategy == "rft_easy_curriculum_v1":
                    curriculum_prompt = normalized_curriculum_prompt(logical)
                    if curriculum_prompt in seen_curriculum_prompts:
                        duplicate_rows += 1
                        continue
                    seen_curriculum_prompts.add(curriculum_prompt)
                projected = projected_record(logical, mode)
                encoded = canonical_json(projected)
                stable_priority = int(
                    sha256_json([
                        manifest.get("contentHash"),
                        args.seed,
                        split,
                        logical["id"],
                    ]),
                    16,
                )
                priority = (
                    curriculum_priority(logical, stable_priority)
                    if selection_strategy == "rft_easy_curriculum_v1"
                    else stable_priority
                )
                eligible_rows += 1
                candidate = (-priority, logical["id"], encoded)
                if len(selected) < limit:
                    heapq.heappush(selected, candidate)
                elif priority < -selected[0][0]:
                    heapq.heapreplace(selected, candidate)

    if not selected:
        raise ValueError(
            f"Dataset projection produced no approved {split} examples."
        )
    ordered = sorted(
        ((-negative_priority, task_id, encoded)
         for negative_priority, task_id, encoded in selected),
        key=lambda item: (item[0], item[1]),
    )
    payload = "".join(f"{encoded}\n" for _priority, _task_id, encoded in ordered)
    atomic_text(output, payload)
    payload_bytes = payload.encode("utf-8")
    print(
        json.dumps(
            {
                "schemaVersion": "openpond.datasetProjectionResult.v1",
                "split": split,
                "mode": mode,
                "exampleCount": len(ordered),
                "eligibleRows": eligible_rows,
                "duplicateRows": duplicate_rows,
                "selectionSeed": args.seed,
                "selectionStrategy": selection_strategy,
                "contentHash": sha256_bytes(payload_bytes),
                "sizeBytes": len(payload_bytes),
                "taskIdsHash": sha256_json(
                    [task_id for _priority, task_id, _encoded in ordered]
                ),
            },
            ensure_ascii=False,
        )
    )
    return 0


class ShardWriter:
    def __init__(
        self,
        *,
        output_root: Path,
        split: str,
        shard_rows: int,
        row_group_rows: int,
    ) -> None:
        self.output_root = output_root
        self.split = split
        self.shard_rows = shard_rows
        self.row_group_rows = row_group_rows
        self.writer: pq.ParquetWriter | None = None
        self.path: Path | None = None
        self.rows_in_shard = 0
        self.index = 0
        self.shards: list[dict[str, Any]] = []

    @classmethod
    def empty(cls) -> "ShardWriter":
        instance = cls.__new__(cls)
        instance.shards = []
        return instance

    def write(self, rows: list[dict[str, Any]]) -> None:
        remaining = rows
        while remaining:
            if self.writer is None:
                self._open()
            capacity = self.shard_rows - self.rows_in_shard
            current, remaining = remaining[:capacity], remaining[capacity:]
            table = pa.Table.from_pylist(current, schema=CANONICAL_SCHEMA)
            self.writer.write_table(table, row_group_size=self.row_group_rows)
            self.rows_in_shard += len(current)
            if self.rows_in_shard >= self.shard_rows:
                self._finalize()

    def close(self) -> None:
        if self.writer is not None:
            self._finalize()

    def _open(self) -> None:
        relative = Path("data") / f"{self.split}-{self.index:05d}.parquet"
        self.path = self.output_root / relative
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.writer = pq.ParquetWriter(
            self.path,
            CANONICAL_SCHEMA,
            compression="zstd",
            write_statistics=True,
        )
        self.rows_in_shard = 0

    def _finalize(self) -> None:
        assert self.writer is not None and self.path is not None
        self.writer.close()
        parquet = pq.ParquetFile(self.path)
        if parquet.metadata.num_rows != self.rows_in_shard:
            raise ValueError(f"Parquet row count verification failed for {self.path}.")
        relative = self.path.relative_to(self.output_root).as_posix()
        content_hash = sha256_file(self.path)
        self.shards.append(
            {
                "id": f"shard_{content_hash[:24]}",
                "split": self.split,
                "path": relative,
                "contentHash": content_hash,
                "sizeBytes": self.path.stat().st_size,
                "rowCount": self.rows_in_shard,
                "rowGroupCount": parquet.metadata.num_row_groups,
            }
        )
        self.writer = None
        self.path = None
        self.rows_in_shard = 0
        self.index += 1


def canonical_record(
    source_row: dict[str, Any],
    row_index: int,
    *,
    source_id: str,
    source_hash: str,
    mapping: dict[str, Any],
    mapping_hash: str,
    assigned_split: str,
) -> dict[str, Any]:
    values: dict[str, list[Any]] = {}
    for binding in required_list(mapping, "bindings"):
        if not isinstance(binding, dict):
            raise TypeError("Dataset bindings must be objects.")
        target = required_string(binding, "target")
        source_path = required_string(binding, "sourcePath")
        try:
            value = nested_value(source_row, source_path)
        except KeyError:
            if binding.get("required") is True:
                raise
            continue
        if value is None and binding.get("required") is True:
            raise ValueError(f"Required source field {source_path} is null.")
        if value is None and mapping.get("nullPolicy") == "drop":
            raise ValueError(f"Source field {source_path} is null.")
        values.setdefault(target, []).append(
            transform(value, required_string(binding, "transform"))
        )

    source_row_id = scalar(values.get("row_id")) or str(row_index)
    stable = sha256_json([source_hash, source_row_id, mapping_hash])
    task_id = f"task_{stable[:24]}"

    messages = first(values.get("messages"))
    prompt = scalar(values.get("prompt"))
    if isinstance(messages, list):
        messages = normalize_messages(messages)
        if not prompt:
            prompt = next(
                (
                    message["content"]
                    for message in reversed(messages)
                    if message["role"] == "user"
                ),
                None,
            )
    if not prompt and not messages:
        raise ValueError("The mapping produced neither a prompt nor messages.")
    input_value: dict[str, Any] = {}
    if prompt:
        input_value["prompt"] = prompt
    if messages:
        input_value["messages"] = messages
    cluster_key = (
        scalar(values.get("cluster_id"))
        or f"input_{sha256_json(input_value)[:24]}"
    )
    split = assigned_split
    if assigned_split == "train":
        split_identity = sha256_json(
            [
                source_hash,
                "cluster",
                cluster_key,
                mapping_hash,
                required_record(mapping, "splitPolicy").get("seed", 0),
            ]
        )
        split = deterministic_holdout(
            split_identity,
            validation_percent=float(
                required_record(mapping, "splitPolicy").get(
                    "validationPercent", 0
                )
            ),
            frozen_percent=float(
                required_record(mapping, "splitPolicy").get(
                    "frozenEvalPercent", 0
                )
            ),
        )

    expected: dict[str, Any] = {}
    expected_text = (
        scalar(values.get("demonstration"))
        or scalar(values.get("expected_output"))
    )
    if expected_text is not None:
        expected["text"] = expected_text
    for target in ("chosen", "rejected", "reward", "feedback"):
        value = first(values.get(target))
        if value is not None:
            expected[target] = value
    expected_output = expected or None
    privileged = first(values.get("privileged_context"))
    metadata_values = values.get("metadata", [])
    metadata = {
        "exampleOrigin": "extracted",
        "sourceRowIndex": row_index,
        "sourceRowId": source_row_id,
        "mappingHash": mapping_hash,
        "upstreamMetadata": metadata_values,
    }
    tags = ["imported", *[str(value) for value in values.get("tag", [])]]
    return {
        "schemaVersion": "openpond.taskData.v1",
        "id": task_id,
        "clusterKey": cluster_key,
        "split": split,
        "input": input_value,
        "expectedOutput": expected_output,
        "policyVisibleContext": {},
        "privilegedContextRef": (
            f"privileged_{stable[:24]}"
            if privileged is not None or expected_output is not None
            else None
        ),
        "sourceRefs": [source_id],
        "tags": tags,
        "metadata": metadata,
    }


def physical_record(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": record["id"],
        "cluster_key": record["clusterKey"],
        "split": record["split"],
        "input_json": canonical_json(record["input"]),
        "expected_output_json": (
            canonical_json(record["expectedOutput"])
            if record["expectedOutput"] is not None
            else None
        ),
        "policy_visible_context_json": canonical_json(
            record["policyVisibleContext"]
        ),
        "privileged_context_ref": record["privilegedContextRef"],
        "source_refs": record["sourceRefs"],
        "tags": record["tags"],
        "metadata_json": canonical_json(record["metadata"]),
    }


def logical_record(physical: dict[str, Any]) -> dict[str, Any]:
    return {
        "schemaVersion": "openpond.taskData.v1",
        "id": physical["id"],
        "clusterKey": physical["cluster_key"],
        "split": physical["split"],
        "input": json.loads(physical["input_json"]),
        "expectedOutput": (
            json.loads(physical["expected_output_json"])
            if physical.get("expected_output_json")
            else None
        ),
        "policyVisibleContext": json.loads(
            physical["policy_visible_context_json"]
        ),
        "privilegedContextRef": physical.get("privileged_context_ref"),
        "sourceRefs": physical["source_refs"],
        "tags": physical["tags"],
        "metadata": json.loads(physical["metadata_json"]),
    }


def record_fingerprint(record: dict[str, Any]) -> str:
    metadata = dict(record.get("metadata") or {})
    metadata.pop("sourceRowIndex", None)
    return sha256_json(
        {
            **record,
            "metadata": metadata,
        }
    )


def projected_record(record: dict[str, Any], mode: str) -> dict[str, Any]:
    if mode == "baseline":
        return record
    base = {
        "id": record["id"],
        "input": record["input"],
        "tags": record["tags"],
    }
    if mode == "grpo":
        return base
    expected = record.get("expectedOutput")
    if not isinstance(expected, dict):
        raise ValueError(
            f"SFT projection requires expected output for {record['id']}."
        )
    return {**base, "expectedOutput": expected}


def normalized_curriculum_prompt(record: dict[str, Any]) -> str:
    prompt = curriculum_prompt_text(record)
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", prompt)).strip().casefold()


def curriculum_prompt_text(record: dict[str, Any]) -> str:
    input_value = record.get("input")
    if not isinstance(input_value, dict):
        return record["id"]
    prompt = input_value.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        messages = input_value.get("messages")
        prompt = next(
            (
                message.get("content")
                for message in reversed(messages if isinstance(messages, list) else [])
                if isinstance(message, dict)
                and message.get("role") == "user"
                and isinstance(message.get("content"), str)
            ),
            record["id"],
        )
    return prompt


def curriculum_priority(record: dict[str, Any], stable_priority: int) -> int:
    prompt = curriculum_prompt_text(record)
    sections = [section.strip() for section in prompt.split("\n\n")]
    body = "\n\n".join(sections[1:-1]) if len(sections) >= 3 else prompt
    expected = record.get("expectedOutput")
    expected_text = expected.get("text") if isinstance(expected, dict) else None
    scalar_answer = (
        isinstance(expected_text, str)
        and re.fullmatch(r"[-+]?\d+(?:/\d+)?", expected_text.strip()) is not None
    )
    ascii_ratio = sum(ord(character) < 128 for character in body) / max(1, len(body))
    no_diagram = "[asy]" not in body.casefold() and "diagram" not in body.casefold()
    if scalar_answer and no_diagram and ascii_ratio >= 0.995 and 50 <= len(body) <= 600:
        bucket = 0
    elif scalar_answer and no_diagram and ascii_ratio >= 0.9:
        bucket = 1
    elif no_diagram:
        bucket = 2
    else:
        bucket = 3
    return (bucket << 288) + (min(len(body), 1_000_000) << 256) + stable_priority


def deterministic_holdout(
    stable_hash: str, *, validation_percent: float, frozen_percent: float
) -> str:
    if validation_percent + frozen_percent > 100:
        raise ValueError("Validation and frozen Eval percentages exceed 100.")
    bucket = int(stable_hash[:8], 16) / 0xFFFFFFFF * 100
    if bucket < frozen_percent:
        return "frozen_eval"
    if bucket < frozen_percent + validation_percent:
        return "validation"
    return "train"


def transform(value: Any, name: str) -> Any:
    if name in {"identity", "messages"}:
        return value
    if name == "string":
        return value if isinstance(value, str) else canonical_json(value)
    if name == "json":
        return value
    if name == "numeric":
        if isinstance(value, bool):
            raise TypeError("Boolean values are not numeric rewards.")
        return float(value)
    if name == "math_final_answer":
        return str(value).strip()
    raise ValueError(f"Unsupported safe transform {name!r}.")


def normalize_messages(value: list[Any]) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    for item in value:
        if not isinstance(item, dict):
            raise TypeError("Message arrays must contain objects.")
        role = item.get("role")
        content = item.get("content")
        if role not in {"system", "user", "assistant", "tool"}:
            raise ValueError(f"Unsupported message role {role!r}.")
        if not isinstance(content, str):
            raise TypeError("Message content must be a string.")
        result.append({"role": role, "content": content})
    if not result:
        raise ValueError("Message arrays may not be empty.")
    return result


def nested_value(value: Any, path: str) -> Any:
    current = value
    for segment in path.split("."):
        if not segment:
            raise KeyError(path)
        if isinstance(current, dict) and segment in current:
            current = current[segment]
            continue
        raise KeyError(path)
    return current


def safe_child(root: Path, relative: str) -> Path:
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise ValueError("Dataset shard path escapes its storage root.") from error
    if not candidate.is_file():
        raise ValueError(f"Dataset shard is missing: {relative}")
    return candidate


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object.")
    return value


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.{Path.cwd().name}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def atomic_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.{Path.cwd().name}.tmp")
    temporary.write_text(value, encoding="utf-8")
    temporary.replace(path)


def emit(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False), flush=True)


def canonical_json(value: Any) -> str:
    return json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    )


def sha256_json(value: Any) -> str:
    return sha256_bytes(canonical_json(value).encode("utf-8"))


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def required_record(value: dict[str, Any], key: str) -> dict[str, Any]:
    item = value.get(key)
    if not isinstance(item, dict):
        raise ValueError(f"{key} must be an object.")
    return item


def required_list(value: dict[str, Any], key: str) -> list[Any]:
    item = value.get(key)
    if not isinstance(item, list):
        raise ValueError(f"{key} must be an array.")
    return item


def required_string(value: dict[str, Any], key: str) -> str:
    item = value.get(key)
    if not isinstance(item, str) or not item.strip():
        raise ValueError(f"{key} must be a non-empty string.")
    return item.strip()


def required_string_list(value: dict[str, Any], key: str) -> list[str]:
    items = required_list(value, key)
    if not all(isinstance(item, str) and item.strip() for item in items):
        raise ValueError(f"{key} must contain non-empty strings.")
    return [item.strip() for item in items]


def require_schema(value: dict[str, Any], expected: str) -> None:
    if value.get("schemaVersion") != expected:
        raise ValueError(f"Expected {expected}.")


def positive_int(value: Any, fallback: int) -> int:
    return value if isinstance(value, int) and value > 0 else fallback


def first(values: list[Any] | None) -> Any:
    return values[0] if values else None


def scalar(values: list[Any] | None) -> str | None:
    value = first(values)
    if value is None:
        return None
    return value if isinstance(value, str) else canonical_json(value)


def first_string(value: Any) -> str | None:
    if not isinstance(value, list):
        return None
    return next(
        (item for item in value if isinstance(item, str) and item.strip()), None
    )


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="openpond-datasets")
    subparsers = result.add_subparsers(dest="command", required=True)
    materialize_parser = subparsers.add_parser("materialize")
    materialize_parser.add_argument("--control", required=True)
    materialize_parser.add_argument("--result", required=True)
    rows_parser = subparsers.add_parser("rows")
    rows_parser.add_argument("--manifest", required=True)
    rows_parser.add_argument("--root", required=True)
    rows_parser.add_argument("--split")
    rows_parser.add_argument("--start-shard")
    rows_parser.add_argument("--offset", type=int, default=0)
    rows_parser.add_argument("--limit", type=int, default=25)
    rows_parser.add_argument("--columns")
    task_parser = subparsers.add_parser("task")
    task_parser.add_argument("--manifest", required=True)
    task_parser.add_argument("--root", required=True)
    task_parser.add_argument("--task-id", required=True)
    task_parser.add_argument("--split")
    project_parser = subparsers.add_parser("project")
    project_parser.add_argument("--manifest", required=True)
    project_parser.add_argument("--root", required=True)
    project_parser.add_argument("--output", required=True)
    project_parser.add_argument(
        "--split",
        choices=["train", "validation", "test", "frozen_eval"],
        required=True,
    )
    project_parser.add_argument(
        "--mode", choices=["sft", "grpo", "baseline"], required=True
    )
    project_parser.add_argument("--limit", type=int, required=True)
    project_parser.add_argument("--seed", type=int, required=True)
    project_parser.add_argument(
        "--selection-strategy",
        choices=["stable_hash_top_n", "rft_easy_curriculum_v1"],
        default="stable_hash_top_n",
    )
    project_parser.add_argument("--approved-sources")
    return result


def main() -> None:
    args = parser().parse_args()
    try:
        if args.command == "materialize":
            code = materialize(args)
        elif args.command == "rows":
            code = rows(args)
        elif args.command == "task":
            code = task(args)
        else:
            code = project(args)
    except Exception as error:
        print(
            json.dumps(
                {
                    "type": "failure",
                    "errorType": type(error).__name__,
                    "message": str(error)[:20_000],
                }
            ),
            file=sys.stderr,
            flush=True,
        )
        raise SystemExit(1) from error
    raise SystemExit(code)


if __name__ == "__main__":
    main()
