from __future__ import annotations

import argparse
import hashlib
import io
import json
import shutil
from pathlib import Path

from openpond_training.worker import evaluate, run


def sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def write_bundle(root: Path) -> Path:
    bundle = root / "bundle"
    (bundle / "data").mkdir(parents=True)
    train = b'{"id":"train-1","input":{"prompt":"Say hello"},"expectedOutput":{"text":"Hello friend"},"tags":["fixture"]}\n'
    recipe = {
        "schemaVersion": "openpond.sftRecipe.v1",
        "method": "sft",
        "parameterization": "lora",
        "baseModel": {"id": "openpond/tiny-cpu-gpt2-fixture", "revision": "architecture-v2-seed-17-context-512", "tokenizerRevision": "wordlevel-v1", "chatTemplateHash": "fixture00000000"},
        "dataset": {"trainSplit": "train", "validationSplit": "frozen_eval", "completionOnly": True, "maxSequenceLength": 64},
        "lora": {"rank": 2, "alpha": 4, "dropout": 0, "targetModules": ["c_attn"]},
        "optimizer": {"learningRate": 0.01, "epochs": 1, "maxSteps": 2, "batchSize": 1, "gradientAccumulationSteps": 1, "seed": 17},
        "resourceLimits": {"cpuThreads": 2, "memoryBytes": 2_000_000_000, "wallTimeMs": 120_000},
    }
    recipe_bytes = (json.dumps(recipe, indent=2, sort_keys=True) + "\n").encode()
    policy = b'{"sourceIds":["source-1"]}\n'
    provenance = b'{"schemaVersion":"openpond.taskAuthoringProvenance.v1"}\n'
    assets = [("data/train.jsonl", train, "task_data"), ("recipe.json", recipe_bytes, "recipe"), ("policy.json", policy, "policy"), ("provenance.json", provenance, "provenance")]
    files = [{"path": "manifest.json", "sha256": "00000000", "sizeBytes": 0, "role": "manifest"}]
    for relative, content, role in assets:
        target = bundle / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        files.append({"path": relative, "sha256": sha(content), "sizeBytes": len(content), "role": role})
    manifest = {"schemaVersion": "openpond.trainingBundle.v1", "id": "bundle-fixture", "planId": "plan-fixture", "tasksetId": "taskset-fixture", "tasksetHash": "tasksethash", "recipeHash": "recipehash", "files": files, "totalSizeBytes": sum(item[1].__len__() for item in assets), "sourceIds": ["source-1"], "excludedSourceIds": [], "containsRawChats": False, "containsSecrets": False, "containsHiddenGraderAssets": False, "createdAt": "2026-07-12T00:00:00Z", "contentHash": "bundlehash"}
    (bundle / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return bundle


def write_taskset(root: Path) -> Path:
    target = root / "taskset.json"
    target.write_text(json.dumps({"tasks": [{"id": "eval-1", "split": "frozen_eval", "input": {"prompt": "Say hello"}}]}), encoding="utf-8")
    return target


def test_cpu_lora_worker_saves_reloads_and_evaluates(tmp_path: Path, monkeypatch) -> None:
    output = tmp_path / "output"
    stream = io.StringIO()
    monkeypatch.setattr("sys.stdout", stream)
    result = run(argparse.Namespace(bundle=str(write_bundle(tmp_path)), output=str(output), job_id="job-fixture", cancel_file=None, taskset=str(write_taskset(tmp_path))))
    assert result == 0
    assert (output / "adapter" / "adapter_model.safetensors").is_file()
    assert (output / "artifact-manifest.json").is_file()
    assert (output / "frozen-eval-predictions.jsonl").is_file()
    metrics = json.loads((output / "metrics.json").read_text())
    assert metrics["logitDelta"] > 0
    assert metrics["adapterParameterCount"] > 0
    assert metrics["completionOnly"] is True
    assert metrics["assistantTargetCount"] == 1
    assert metrics["trainingExampleCount"] == 1
    events = [json.loads(line) for line in stream.getvalue().splitlines() if line.startswith("{")]
    event_types = [event["type"] for event in events]
    step_metrics = [event for event in events if event["type"] == "metric" and event["payload"].get("metricKind") == "sft_step"]
    assert event_types[0] == "start"
    assert "progress" in event_types
    assert event_types[-2:] == ["metric", "complete"]
    assert len(step_metrics) == 2
    assert [metric["payload"]["step"] for metric in step_metrics] == [1, 2]
    assert all(metric["payload"]["loss"] >= 0 for metric in step_metrics)
    assert (output / "step-metrics.jsonl").is_file()


def test_worker_failure_is_structured(tmp_path: Path, monkeypatch) -> None:
    stream = io.StringIO()
    monkeypatch.setattr("sys.stdout", stream)
    monkeypatch.setenv("OPENPOND_TRAINING_INJECT_FAILURE", "1")
    result = run(argparse.Namespace(bundle=str(write_bundle(tmp_path)), output=str(tmp_path / "failed"), job_id="job-failed", cancel_file=None, taskset=None))
    assert result == 1
    events = [json.loads(line) for line in stream.getvalue().splitlines() if line.startswith("{")]
    assert events[-1]["type"] == "failure"


def test_worker_cancellation_is_structured(tmp_path: Path, monkeypatch) -> None:
    stream = io.StringIO()
    cancel_file = tmp_path / "cancel.requested"
    cancel_file.write_text("cancel\n")
    monkeypatch.setattr("sys.stdout", stream)
    result = run(argparse.Namespace(bundle=str(write_bundle(tmp_path)), output=str(tmp_path / "cancelled"), job_id="job-cancelled", cancel_file=str(cancel_file), taskset=None))
    assert result == 130
    events = [json.loads(line) for line in stream.getvalue().splitlines() if line.startswith("{")]
    assert events[-1]["type"] == "cancel"
    assert not (tmp_path / "cancelled" / "adapter" / "adapter_model.safetensors").exists()


def test_manual_import_reloads_and_runs_frozen_evaluation(tmp_path: Path, monkeypatch) -> None:
    bundle = write_bundle(tmp_path)
    taskset = write_taskset(tmp_path)
    trained = tmp_path / "trained"
    monkeypatch.setattr("sys.stdout", io.StringIO())
    assert run(argparse.Namespace(bundle=str(bundle), output=str(trained), job_id="job-trained", cancel_file=None, taskset=str(taskset))) == 0
    imported = tmp_path / "imported"
    shutil.copytree(trained, imported)
    (imported / "events.jsonl").unlink()
    stream = io.StringIO()
    monkeypatch.setattr("sys.stdout", stream)
    result = evaluate(argparse.Namespace(bundle=str(bundle), output=str(imported), job_id="job-imported", cancel_file=None, taskset=str(taskset)))
    assert result == 0
    manifest = json.loads((imported / "artifact-manifest.json").read_text())
    assert manifest["metadata"]["manualImport"] is True
    assert manifest["metadata"]["reloadVerified"] is True
    assert (imported / "frozen-eval-predictions.jsonl").is_file()
    events = [json.loads(line) for line in stream.getvalue().splitlines() if line.startswith("{")]
    assert [event["type"] for event in events] == ["start", "metric", "complete"]


def test_worker_cleans_temporary_directory_on_failure(tmp_path: Path, monkeypatch) -> None:
    temporary = tmp_path / "controlled-temp"
    temporary.mkdir()
    monkeypatch.setattr("openpond_training.worker.tempfile.mkdtemp", lambda **_kwargs: str(temporary))
    monkeypatch.setenv("OPENPOND_TRAINING_INJECT_FAILURE", "1")
    monkeypatch.setattr("sys.stdout", io.StringIO())
    assert run(argparse.Namespace(bundle=str(write_bundle(tmp_path)), output=str(tmp_path / "failed-cleanup"), job_id="job-cleanup", cancel_file=None, taskset=None)) == 1
    assert not temporary.exists()
