from __future__ import annotations

import argparse
import hashlib
import io
import json
import shutil
from pathlib import Path

from openpond_training.worker import evaluate, run
from openpond_training.ppo_worker import generalized_advantage_estimation


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
        "dataset": {"trainSplit": "train", "validationSplit": "frozen_eval", "completionOnly": True, "maxSequenceLength": 64, "maxExamples": 1_000, "selectionStrategy": "stable_hash_top_n", "selectionSeed": 17},
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
    target.write_text(json.dumps({"tasks": [
        {"id": "train-1", "split": "train", "input": {"prompt": "Say hello"}, "expectedOutput": {"text": "Hello friend"}},
        {"id": "eval-1", "split": "frozen_eval", "input": {"prompt": "Say hello"}},
    ]}), encoding="utf-8")
    return target


def write_dpo_bundle(root: Path) -> Path:
    bundle = write_bundle(root)
    train = (
        b'{"id":"pair-1","prompt":"Choose a greeting: ","chosen":"Hello friend",'
        b'"rejected":"Go away","sourceRefs":["source-1"]}\n'
    )
    recipe = {
        "schemaVersion": "openpond.dpoRecipe.v1",
        "method": "dpo",
        "parameterization": "lora",
        "policyModel": {"id": "openpond/tiny-cpu-gpt2-fixture", "revision": "architecture-v2-seed-17-context-512", "tokenizerRevision": "wordlevel-v1", "chatTemplateHash": "fixture00000000"},
        "referenceModel": {"id": "openpond/tiny-cpu-gpt2-fixture", "revision": "architecture-v2-seed-17-context-512", "tokenizerRevision": "wordlevel-v1", "chatTemplateHash": "fixture00000000"},
        "dataset": {"trainSplit": "train", "validationSplit": "frozen_eval", "maxPairs": 1, "maxPromptTokens": 32, "maxCompletionTokens": 32, "selectionStrategy": "stable_hash_top_n", "selectionSeed": 17},
        "lora": {"rank": 2, "alpha": 4, "dropout": 0, "targetModules": ["c_attn"]},
        "loss": {"variant": "sigmoid", "beta": 0.1, "labelSmoothing": 0},
        "optimizer": {"learningRate": 0.01, "epochs": 1, "maxSteps": 2, "batchSize": 1, "gradientAccumulationSteps": 1, "seed": 17},
        "referenceLogprobs": {"cacheSchemaVersion": "openpond.dpoReferenceLogprobs.v1", "cacheKey": "cachekey123", "invalidationHash": "invalidate123"},
        "resourceLimits": {"cpuThreads": 2, "memoryBytes": 2_000_000_000, "wallTimeMs": 120_000},
    }
    recipe_bytes = (json.dumps(recipe, indent=2, sort_keys=True) + "\n").encode()
    replacements = {
        "data/train.jsonl": train,
        "recipe.json": recipe_bytes,
    }
    manifest_path = bundle / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    for relative, content in replacements.items():
        (bundle / relative).write_bytes(content)
        item = next(entry for entry in manifest["files"] if entry["path"] == relative)
        item["sha256"] = sha(content)
        item["sizeBytes"] = len(content)
    manifest["totalSizeBytes"] = sum(
        item["sizeBytes"] for item in manifest["files"] if item["path"] != "manifest.json"
    )
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    return bundle


def write_ppo_bundle(root: Path) -> Path:
    bundle = write_bundle(root)
    train = b'{"id":"train-1","input":{"prompt":"Say hello"},"tags":["fixture"]}\n'
    policy = {"id": "openpond/tiny-cpu-gpt2-fixture", "revision": "architecture-v2-seed-17-context-512", "tokenizerRevision": "wordlevel-v1", "chatTemplateHash": "fixture00000000"}
    value_model = {**policy, "id": "openpond/tiny-cpu-gpt2-fixture:value-head-v1"}
    recipe = {
        "schemaVersion": "openpond.ppoRecipe.v1",
        "method": "ppo",
        "parameterization": "lora",
        "policyOptimization": {
            "schemaVersion": "openpond.policyOptimization.v1",
            "policyModel": policy,
            "referenceModel": policy,
            "dataset": {"tasksetId": "taskset-fixture", "tasksetHash": "tasksethash", "split": "train", "selectionStrategy": "stable_hash_top_n", "selectionSeed": 17, "maxExamples": 1},
            "sampler": {"temperature": 0.8, "topP": 0.95, "maxOutputTokens": 4, "maxTurns": 1, "concurrency": 1},
            "environment": {"id": "fixture-environment", "version": "v1", "toolContractHash": "no-tools-v1"},
            "reward": {"graderId": "exact", "graderHash": "graderhash"},
            "kl": {"coefficient": 0.05, "referenceConstraint": "fixed_reference"},
            "budgets": {"maxRollouts": 2, "maxEnvironmentExecutions": 2, "maxInputTokens": 256, "maxOutputTokens": 8, "maxOptimizerSteps": 2, "wallTimeMs": 120_000, "maximumCostUsd": 0},
            "checkpointEverySteps": 1,
            "seed": 17,
            "evaluationSplit": "frozen_eval",
            "optimizer": {"method": "ppo", "valueModel": value_model, "gamma": 1, "gaeLambda": 0.95, "policyClip": 0.2, "valueClip": 0.2, "valueLossCoefficient": 0.5, "ppoEpochs": 2, "minibatchSize": 1},
        },
        "lora": {"rank": 2, "alpha": 4, "dropout": 0, "targetModules": ["c_attn"]},
        "valueHead": {"initialization": "policy_hidden_state_linear", "optimizerLearningRate": 0.01, "artifactName": "value_head.safetensors"},
        "policyLearningRate": 0.01,
        "resume": {"checkpointId": None, "policyHash": "policyhash", "referenceHash": "referencehash", "valueModelHash": "valuemodelhash", "optimizerStateHash": None},
        "resourceLimits": {"cpuThreads": 2, "memoryBytes": 2_000_000_000, "wallTimeMs": 120_000},
    }
    recipe_bytes = (json.dumps(recipe, indent=2, sort_keys=True) + "\n").encode()
    replacements = {"data/train.jsonl": train, "recipe.json": recipe_bytes}
    manifest_path = bundle / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    for relative, content in replacements.items():
        (bundle / relative).write_bytes(content)
        item = next(entry for entry in manifest["files"] if entry["path"] == relative)
        item["sha256"] = sha(content)
        item["sizeBytes"] = len(content)
    manifest["totalSizeBytes"] = sum(
        item["sizeBytes"] for item in manifest["files"] if item["path"] != "manifest.json"
    )
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    return bundle


def test_cpu_lora_worker_saves_reloads_and_evaluates(tmp_path: Path, monkeypatch) -> None:
    output = tmp_path / "output"
    stream = io.StringIO()
    monkeypatch.setattr("sys.stdout", stream)
    result = run(argparse.Namespace(bundle=str(write_bundle(tmp_path)), output=str(output), job_id="job-fixture", cancel_file=None, taskset=str(write_taskset(tmp_path))))
    assert result == 0, stream.getvalue()
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


def test_cpu_dpo_worker_records_preference_metrics_and_reference_cache(tmp_path: Path, monkeypatch) -> None:
    output = tmp_path / "dpo-output"
    stream = io.StringIO()
    monkeypatch.setattr("sys.stdout", stream)
    result = run(argparse.Namespace(
        bundle=str(write_dpo_bundle(tmp_path)),
        output=str(output),
        job_id="job-dpo",
        cancel_file=None,
        taskset=str(write_taskset(tmp_path)),
    ))
    assert result == 0
    metrics = json.loads((output / "metrics.json").read_text())
    assert metrics["method"] == "dpo"
    assert metrics["logitDelta"] > 0
    cache_rows = [
        json.loads(line)
        for line in (output / "reference-logprobs.jsonl").read_text().splitlines()
    ]
    assert cache_rows[0]["cacheKey"] == "cachekey123"
    assert cache_rows[0]["invalidationHash"] == "invalidate123"
    events = [json.loads(line) for line in stream.getvalue().splitlines() if line.startswith("{")]
    dpo_metrics = [
        event["payload"] for event in events
        if event["type"] == "metric"
        and event["payload"].get("metricKind") == "dpo_step"
        and event["payload"].get("preferenceAccuracy") is not None
    ]
    assert dpo_metrics
    assert (output / "adapter" / "adapter_model.safetensors").is_file()
    assert (output / "frozen-eval-predictions.jsonl").is_file()


def test_cpu_ppo_worker_records_policy_reference_critic_lineage(tmp_path: Path, monkeypatch) -> None:
    output = tmp_path / "ppo-output"
    stream = io.StringIO()
    monkeypatch.setattr("sys.stdout", stream)
    result = run(argparse.Namespace(
        bundle=str(write_ppo_bundle(tmp_path)),
        output=str(output),
        job_id="job-ppo",
        cancel_file=None,
        taskset=str(write_taskset(tmp_path)),
        model_path=None,
        checkpoint_path=None,
    ))
    assert result == 0, stream.getvalue()
    assert (output / "adapter" / "adapter_model.safetensors").is_file()
    assert (output / "value_head.safetensors").is_file()
    assert (output / "checkpoints" / "step-2" / "checkpoint.json").is_file()
    trajectories = [
        json.loads(line)
        for line in (output / "ppo-trajectories.jsonl").read_text().splitlines()
    ]
    assert len(trajectories) == 2
    assert trajectories[0]["schemaVersion"] == "openpond.ppoTrajectory.v1"
    assert trajectories[0]["valueModelId"].endswith(":value-head-v1")
    assert all("advantage" in step and "return" in step for step in trajectories[0]["steps"])
    metrics = [
        json.loads(line)
        for line in (output / "policy-metrics.jsonl").read_text().splitlines()
    ]
    assert len(metrics) == 2
    assert all(metric["method"] == "ppo" for metric in metrics)
    assert all(metric["environmentExecutions"] > 0 for metric in metrics)
    assert (output / "base-frozen-eval-predictions.jsonl").is_file()
    assert (output / "frozen-eval-predictions.jsonl").is_file()


def test_gae_reference_values_distinguish_terminal_returns() -> None:
    returns, advantages = generalized_advantage_estimation(
        [0.0, 1.0],
        [0.2, 0.3],
        gamma=1.0,
        gae_lambda=0.95,
    )
    assert len(returns) == len(advantages) == 2
    assert advantages[-1] == 0.7
    assert returns[-1] == 1.0
    assert returns[0] > 0.8


def test_cpu_ppo_resume_restores_policy_value_and_optimizer_state(tmp_path: Path, monkeypatch) -> None:
    bundle = write_ppo_bundle(tmp_path)
    first_output = tmp_path / "ppo-first"
    monkeypatch.setattr("sys.stdout", io.StringIO())
    assert run(argparse.Namespace(
        bundle=str(bundle),
        output=str(first_output),
        job_id="job-ppo-first",
        cancel_file=None,
        taskset=str(write_taskset(tmp_path)),
        model_path=None,
        checkpoint_path=None,
    )) == 0
    recipe_path = bundle / "recipe.json"
    recipe = json.loads(recipe_path.read_text())
    recipe["resume"]["checkpointId"] = "checkpoint-step-1"
    recipe_bytes = (json.dumps(recipe, indent=2, sort_keys=True) + "\n").encode()
    recipe_path.write_bytes(recipe_bytes)
    manifest_path = bundle / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    recipe_file = next(item for item in manifest["files"] if item["path"] == "recipe.json")
    recipe_file["sha256"] = sha(recipe_bytes)
    recipe_file["sizeBytes"] = len(recipe_bytes)
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    resumed_output = tmp_path / "ppo-resumed"
    stream = io.StringIO()
    monkeypatch.setattr("sys.stdout", stream)
    assert run(argparse.Namespace(
        bundle=str(bundle),
        output=str(resumed_output),
        job_id="job-ppo-resumed",
        cancel_file=None,
        taskset=str(write_taskset(tmp_path)),
        model_path=None,
        checkpoint_path=str(first_output / "checkpoints" / "step-1" / "checkpoint.json"),
    )) == 0, stream.getvalue()
    metrics = json.loads((resumed_output / "metrics.json").read_text())
    assert metrics["steps"] == 2
    trajectories = (resumed_output / "ppo-trajectories.jsonl").read_text().splitlines()
    assert len(trajectories) == 1


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
