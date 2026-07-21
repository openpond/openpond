from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from openpond_training.dataset_worker import materialize, project, rows


def test_materializes_split_parquet_and_reads_bounded_rows(
    tmp_path: Path, capsys
) -> None:
    source = tmp_path / "source.parquet"
    pq.write_table(
        pa.Table.from_pylist(
            [
                {
                    "prompt": [{"role": "user", "content": f"Problem {index}"}],
                    "reward_model": {"ground_truth": str(index)},
                    "row_id": f"row-{index}",
                }
                for index in range(40)
            ]
        ),
        source,
    )
    output = tmp_path / "artifact"
    mapping = {
        "schemaVersion": "openpond.datasetImportMapping.v1",
        "sourceSchemaHash": "schemahash",
        "configuration": "default",
        "upstreamSplits": ["train"],
        "preset": "prompt_expected_answer",
        "bindings": [
            {
                "sourcePath": "row_id",
                "target": "row_id",
                "transform": "string",
                "policy": "metadata",
                "required": True,
            },
            {
                "sourcePath": "prompt",
                "target": "messages",
                "transform": "messages",
                "policy": "visible",
                "required": True,
            },
            {
                "sourcePath": "reward_model.ground_truth",
                "target": "expected_output",
                "transform": "math_final_answer",
                "policy": "privileged",
                "required": True,
            },
        ],
        "nullPolicy": "reject",
        "invalidRowPolicy": "reject_import",
        "splitPolicy": {
            "seed": 17,
            "assignments": {"train": "train"},
            "validationPercent": 20,
            "frozenEvalPercent": 20,
        },
        "importerVersion": "test",
        "mappingHash": "mappinghash",
    }
    control = tmp_path / "control.json"
    control.write_text(
        json.dumps(
            {
                "schemaVersion": "openpond.datasetMaterializeControl.v1",
                "outputRoot": str(output),
                "files": [
                    {
                        "path": str(source),
                        "upstreamSplit": "train",
                    }
                ],
                "sourceId": "source-1",
                "sourceHash": "sourcehash",
                "mapping": mapping,
                "shardRows": 12,
                "rowGroupRows": 5,
                "previewRows": 3,
            }
        ),
        encoding="utf-8",
    )
    result_path = tmp_path / "result.json"
    assert (
        materialize(
            argparse.Namespace(control=str(control), result=str(result_path))
        )
        == 0
    )
    result = json.loads(result_path.read_text(encoding="utf-8"))
    assert result["rowCount"] == 40
    assert sum(result["splitCounts"].values()) == 40
    assert len(result["previewRows"]) == 3
    assert all(shard["rowCount"] <= 12 for shard in result["shards"])
    assert all(
        _sha256(output / shard["path"]) == shard["contentHash"]
        for shard in result["shards"]
    )

    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "schemaVersion": "openpond.datasetArtifact.v1",
                "shards": result["shards"],
            }
        ),
        encoding="utf-8",
    )
    capsys.readouterr()
    assert (
        rows(
            argparse.Namespace(
                manifest=str(manifest),
                root=str(output),
                split=None,
                offset=4,
                limit=3,
                columns=None,
            )
        )
        == 0
    )
    page = json.loads(capsys.readouterr().out)
    assert len(page["rows"]) == 3
    assert page["rows"][0]["schemaVersion"] == "openpond.taskData.v1"
    assert page["rows"][0]["sourceRefs"] == ["source-1"]


def test_deduplicates_identical_stable_row_ids_and_projects_private_safe_grpo(
    tmp_path: Path, capsys
) -> None:
    source = tmp_path / "source.parquet"
    unique_rows = [
        {
            "prompt": [{
                "role": "user",
                "content": "Shared problem" if index < 2 else f"Problem {index}",
            }],
            "reward_model": {"ground_truth": str(index)},
            "row_id": f"row-{index}",
        }
        for index in range(20)
    ]
    pq.write_table(
        pa.Table.from_pylist(
            [row for row in unique_rows for _copy in range(3)]
        ),
        source,
    )
    output = tmp_path / "artifact"
    mapping = _mapping(validation_percent=20, frozen_percent=20)
    result_path = _materialize_fixture(
        tmp_path,
        source=source,
        output=output,
        mapping=mapping,
    )
    result = json.loads(result_path.read_text(encoding="utf-8"))
    assert result["rowCount"] == 20
    assert result["qualityReport"] == {
        "processedRows": 60,
        "writtenRows": 20,
        "droppedRows": 0,
        "duplicateRows": 40,
        "uniqueRowIdentities": 20,
        "uniqueClusters": 19,
        "splitCounts": result["splitCounts"],
        "splitIsolationVerified": True,
        "splitIsolationStrategy": "cluster_key_hash",
    }
    artifact_rows = [
        row
        for shard in (output / "data").glob("*.parquet")
        for row in pq.read_table(shard).to_pylist()
    ]
    shared_rows = [
        row
        for row in artifact_rows
        if json.loads(row["input_json"]).get("prompt") == "Shared problem"
    ]
    assert len(shared_rows) == 2
    assert len({row["cluster_key"] for row in shared_rows}) == 1
    assert len({row["split"] for row in shared_rows}) == 1

    manifest = output / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "schemaVersion": "openpond.datasetArtifact.v1",
                "contentHash": "artifacthash",
                "shards": result["shards"],
            }
        ),
        encoding="utf-8",
    )
    projected = tmp_path / "projected.jsonl"
    capsys.readouterr()
    assert (
        project(
            argparse.Namespace(
                manifest=str(manifest),
                root=str(output),
                output=str(projected),
                split="train",
                mode="grpo",
                limit=5,
                seed=17,
                approved_sources="source-1",
            )
        )
        == 0
    )
    projection = json.loads(capsys.readouterr().out)
    records = [
        json.loads(line)
        for line in projected.read_text(encoding="utf-8").splitlines()
    ]
    assert projection["exampleCount"] == min(5, result["splitCounts"]["train"])
    assert len({record["id"] for record in records}) == len(records)
    assert all(set(record) == {"id", "input", "tags"} for record in records)
    assert "expectedOutput" not in projected.read_text(encoding="utf-8")
    assert "ground_truth" not in projected.read_text(encoding="utf-8")

    baseline = tmp_path / "baseline.jsonl"
    assert (
        project(
            argparse.Namespace(
                manifest=str(manifest),
                root=str(output),
                output=str(baseline),
                split="train",
                mode="baseline",
                limit=3,
                seed=17,
                approved_sources="source-1",
            )
        )
        == 0
    )
    baseline_receipt = json.loads(capsys.readouterr().out)
    baseline_records = [
        json.loads(line)
        for line in baseline.read_text(encoding="utf-8").splitlines()
    ]
    assert baseline_receipt["mode"] == "baseline"
    assert len(baseline_records) == min(3, result["splitCounts"]["train"])
    assert all(record["schemaVersion"] == "openpond.taskData.v1" for record in baseline_records)

    easy_baseline = tmp_path / "easy-baseline.jsonl"
    assert project(argparse.Namespace(
        manifest=str(manifest),
        root=str(output),
        output=str(easy_baseline),
        split="train",
        mode="baseline",
        limit=3,
        seed=17,
        approved_sources="source-1",
        selection_strategy="rft_easy_curriculum_v1",
    )) == 0
    easy_baseline_receipt = json.loads(capsys.readouterr().out)
    easy_grpo = tmp_path / "easy-grpo.jsonl"
    assert project(argparse.Namespace(
        manifest=str(manifest),
        root=str(output),
        output=str(easy_grpo),
        split="train",
        mode="grpo",
        limit=3,
        seed=17,
        approved_sources="source-1",
        selection_strategy="rft_easy_curriculum_v1",
    )) == 0
    easy_grpo_receipt = json.loads(capsys.readouterr().out)
    assert easy_baseline_receipt["selectionStrategy"] == "rft_easy_curriculum_v1"
    assert easy_baseline_receipt["taskIdsHash"] == easy_grpo_receipt["taskIdsHash"]
    assert "expectedOutput" not in easy_grpo.read_text(encoding="utf-8")
    assert all(record["expectedOutput"] for record in baseline_records)


def test_rejects_conflicting_content_for_the_same_stable_row_id(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.parquet"
    pq.write_table(
        pa.Table.from_pylist(
            [
                {
                    "prompt": [{"role": "user", "content": "Problem"}],
                    "reward_model": {"ground_truth": "1"},
                    "row_id": "same",
                },
                {
                    "prompt": [{"role": "user", "content": "Different problem"}],
                    "reward_model": {"ground_truth": "2"},
                    "row_id": "same",
                },
            ]
        ),
        source,
    )
    with pytest.raises(ValueError, match="conflicting content"):
        _materialize_fixture(
            tmp_path,
            source=source,
            output=tmp_path / "artifact",
            mapping=_mapping(validation_percent=0, frozen_percent=0),
        )


def _mapping(
    *, validation_percent: int, frozen_percent: int
) -> dict[str, object]:
    return {
        "schemaVersion": "openpond.datasetImportMapping.v1",
        "sourceSchemaHash": "schemahash",
        "configuration": "default",
        "upstreamSplits": ["train"],
        "preset": "prompt_expected_answer",
        "bindings": [
            {
                "sourcePath": "row_id",
                "target": "row_id",
                "transform": "string",
                "policy": "metadata",
                "required": True,
            },
            {
                "sourcePath": "prompt",
                "target": "messages",
                "transform": "messages",
                "policy": "visible",
                "required": True,
            },
            {
                "sourcePath": "reward_model.ground_truth",
                "target": "expected_output",
                "transform": "math_final_answer",
                "policy": "privileged",
                "required": True,
            },
        ],
        "nullPolicy": "reject",
        "invalidRowPolicy": "reject_import",
        "splitPolicy": {
            "seed": 17,
            "assignments": {"train": "train"},
            "validationPercent": validation_percent,
            "frozenEvalPercent": frozen_percent,
        },
        "importerVersion": "test",
        "mappingHash": "mappinghash",
    }


def _materialize_fixture(
    tmp_path: Path,
    *,
    source: Path,
    output: Path,
    mapping: dict[str, object],
) -> Path:
    control = tmp_path / "control.json"
    control.write_text(
        json.dumps(
            {
                "schemaVersion": "openpond.datasetMaterializeControl.v1",
                "outputRoot": str(output),
                "files": [
                    {
                        "path": str(source),
                        "upstreamSplit": "train",
                    }
                ],
                "sourceId": "source-1",
                "sourceHash": "sourcehash",
                "mapping": mapping,
                "shardRows": 12,
                "rowGroupRows": 5,
                "previewRows": 3,
            }
        ),
        encoding="utf-8",
    )
    result_path = tmp_path / "result.json"
    materialize(argparse.Namespace(control=str(control), result=str(result_path)))
    return result_path


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()
