from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import openpond_training.prime_rl_execution as prime
import pytest
from openpond_training.canonical_json import content_hash
from openpond_training.engine_adapters import (
    PRIME_RL_BASE_IMAGE_DIGEST,
    PRIME_RL_UPSTREAM_REVISION,
)
from openpond_training.prime_rl_worker import read_signal_journal

WORKER_DIGEST = f"sha256:{'7' * 64}"


def plan() -> dict:
    recipe = {
        "schemaVersion": "openpond.rftRecipe.v1",
        "method": "grpo",
        "parameterization": "lora",
        "baseModel": {
            "id": "Qwen/Qwen3-4B-Instruct-2507",
            "revision": "model-revision",
            "tokenizerRevision": "tokenizer-revision",
            "chatTemplateHash": "1" * 64,
        },
        "dataset": {
            "trainSplit": "train",
            "validationSplit": "frozen_eval",
            "maxPromptTokens": 2_048,
            "maxExamples": 8,
            "selectionStrategy": "stable_hash_top_n",
        },
        "lora": {"rank": 8},
        "rollout": {
            "groupSize": 2,
            "concurrency": 2,
            "maxTurns": 4,
            "maxOutputTokens": 512,
            "temperature": 0.8,
            "topP": 0.95,
            "seed": 17,
        },
        "optimizer": {"learningRate": 0.00001, "maxSteps": 1},
        "loss": {"method": "grpo", "klBeta": None},
        "reward": {
            "graderId": "grader",
            "graderHash": "2" * 64,
            "environmentId": "environment",
            "environmentVersion": "1",
            "toolContractHash": "3" * 64,
        },
        "resourceLimits": {
            "wallTimeMs": 60_000,
            "maxRollouts": 16,
            "maxPayloadBytes": 1_000_000,
        },
        "policyOptimization": {
            "schemaVersion": "openpond.policyOptimization.v1",
            "policyModel": {
                "id": "Qwen/Qwen3-4B-Instruct-2507",
                "revision": "model-revision",
                "tokenizerRevision": "tokenizer-revision",
                "chatTemplateHash": "1" * 64,
            },
            "referenceModel": {
                "id": "Qwen/Qwen3-4B-Instruct-2507",
                "revision": "model-revision",
                "tokenizerRevision": "tokenizer-revision",
                "chatTemplateHash": "1" * 64,
            },
            "dataset": {
                "tasksetId": "taskset",
                "tasksetHash": "4" * 64,
                "split": "train",
                "selectionStrategy": "stable_hash_top_n",
                "selectionSeed": 17,
                "maxExamples": 8,
            },
            "sampler": {
                "temperature": 0.8,
                "topP": 0.95,
                "maxOutputTokens": 512,
                "maxTurns": 4,
                "concurrency": 2,
            },
            "environment": {
                "id": "environment",
                "version": "1",
                "toolContractHash": "3" * 64,
            },
            "reward": {
                "graderId": "grader",
                "graderHash": "2" * 64,
            },
            "kl": {
                "coefficient": None,
                "referenceConstraint": "fixed_reference",
            },
            "budgets": {
                "maxRollouts": 16,
                "maxEnvironmentExecutions": 16,
                "maxInputTokens": 32_768,
                "maxOutputTokens": 8_192,
                "maxOptimizerSteps": 1,
                "wallTimeMs": 60_000,
                "maximumCostUsd": 1,
            },
            "checkpointEverySteps": 1,
            "seed": 17,
            "evaluationSplit": "frozen_eval",
            "optimizer": {
                "method": "grpo",
                "groupSize": 2,
                "normalization": "group_standardized",
                "loss": "grpo",
            },
        },
    }
    engine = {
        "adapterId": "connected-prime-rl",
        "workerVersion": "catalog-release",
        "workerImageDigest": WORKER_DIGEST,
        "upstreamRevision": PRIME_RL_UPSTREAM_REVISION,
        "capabilityReceipt": "a" * 64,
    }
    runtime = {
        "adapterId": "local-harness",
        "placement": "remote",
        "capabilityReceipt": "9" * 64,
        "runtimeVersion": "1",
        "dataPlane": None,
    }
    compute = {
        "adapterId": "prime-raw",
        "kind": "managed",
        "deviceOrPool": "h100",
        "capabilityReceipt": "f" * 64,
        "provider": "prime",
    }
    manifest_base = {
        "schemaVersion": "openpond.harnessRunManifest.v1",
        "id": "run-prime-1",
        "datasetRelease": {
            "id": "dataset-release",
            "contentHash": "6" * 64,
        },
        "harnessRelease": {
            "id": "harness-release",
            "contentHash": "8" * 64,
        },
        "evidenceSets": [],
        "model": {
            "source": "local",
            "revision": "model-revision",
            "artifactHash": None,
            "tokenizerRevision": "tokenizer-revision",
            "chatTemplateHash": "1" * 64,
        },
        "recipe": {
            "method": "grpo",
            "version": "openpond.trainingRecipe.v1",
            "configHash": content_hash(recipe),
        },
        "runtimeTarget": runtime,
        "computeTarget": compute,
        "resolvedBundleHash": "0" * 64,
        "secretLeaseRefs": [],
        "approval": {
            "approvalHash": "1" * 64,
            "approvedAt": "2026-07-23T12:00:00.000Z",
            "maximumSpendUsd": 1,
        },
        "engine": engine,
        "createdAt": "2026-07-23T12:00:00.000Z",
    }
    manifest = {
        **manifest_base,
        "contentHash": content_hash(manifest_base),
    }
    plan_base = {
        "schemaVersion": "openpond.resolvedTrainingPlan.v1",
        "manifest": manifest,
        "recipe": recipe,
        "runtime": runtime,
        "compute": compute,
        "engine": engine,
        "maximumSpendUsd": 1,
        "approvalHash": "1" * 64,
    }
    return {**plan_base, "contentHash": content_hash(plan_base)}


def optimizer_sample(request_id: str) -> dict:
    return {
        "schemaVersion": "openpond.optimizerTrainingSample.v1",
        "tokenIds": [11, 12, 13],
        "mask": [False, True, True],
        "logprobs": [0.0, -0.1, -0.2],
        "temperatures": [0.8, 0.8, 0.8],
        "envName": "fixture",
        "modelRequestId": request_id,
        "promptTokenCount": 1,
        "completionTokenCount": 2,
        "servedPolicyVersion": 0,
    }


def signal(kind: str, episode: int, payload: dict) -> dict:
    exact_plan = plan()
    value = {
        "schemaVersion": "openpond.learningSignal.v1",
        "id": f"{kind}-{episode}",
        "taskId": f"task-{episode}",
        "episodeId": f"episode-{episode}",
        "policyVersion": 0,
        "kind": kind,
        "payload": payload,
        "lineage": {
            "datasetRelease": exact_plan["manifest"]["datasetRelease"],
            "harnessRelease": exact_plan["manifest"]["harnessRelease"],
            "evidenceSetRelease": None,
            "profileRelease": None,
            "model": {
                "source": exact_plan["manifest"]["model"]["source"],
                "revision": exact_plan["manifest"]["model"]["revision"],
                "artifactHash": None,
            },
            "environmentHash": "b" * 64,
            "graderHash": "2" * 64,
            "toolContractHash": "3" * 64,
            "verificationReceiptHash": "e" * 64,
        },
        "approved": True,
        "verifier": "deterministic",
        "createdAt": "2026-07-23T12:00:00.000Z",
        "metadata": {},
    }
    return {**value, "contentHash": content_hash(value)}


def signals() -> list[dict]:
    values: list[dict] = []
    for episode, reward in ((1, 0.0), (2, 1.0)):
        values.extend(
            [
                signal(
                    "trajectory",
                    episode,
                    {
                        "traceRef": f"r2://traces/{episode}.json",
                        "traceHash": f"{episode}" * 64,
                        "terminal": True,
                        "failureClass": None,
                        "optimizerSample": optimizer_sample(
                            f"request-{episode}"
                        ),
                    },
                ),
                signal(
                    "reward",
                    episode,
                    {
                        "reward": reward,
                        "components": {"grader": reward},
                        "eligible": True,
                        "graderEvidenceRefs": [f"grader-{episode}"],
                    },
                ),
            ]
        )
    return values


def test_projects_exact_external_batch_and_configs() -> None:
    settings = prime.resolve_prime_rl_settings(plan())
    assert settings.group_size == 2
    assert settings.sequence_length == 2_560
    batch = prime.project_prime_rl_batch(
        plan=plan(), signal_values=signals(), step=1
    )
    assert batch.reward_mean == 0.5
    assert batch.records[0]["advantages"] == [0.0, -1.0, -1.0]
    assert batch.records[1]["advantages"] == [0.0, 1.0, 1.0]
    trainer = prime.render_prime_rl_trainer_config(
        settings=settings,
        model_path=Path("/models/exact"),
        output_root=Path("/output"),
        step=1,
        manifest_hash=plan()["manifest"]["contentHash"],
    )
    assert f"# prime_rl_commit = {PRIME_RL_UPSTREAM_REVISION}" in trainer
    assert "resume_step" not in trainer
    assert "interval = 1" in trainer
    run = prime.render_prime_rl_run_config(
        settings=settings,
        model_path=Path("/models/exact"),
        output_root=Path("/output"),
        step=1,
    )
    assert '[renderer]\nname = "default"' in run
    assert "[orchestrator.renderer]" not in run
    assert PRIME_RL_BASE_IMAGE_DIGEST.startswith("sha256:")


def test_rejects_recipe_drift_and_incomplete_optimizer_samples() -> None:
    drifted = plan()
    drifted["recipe"]["optimizer"]["learningRate"] = 0.5
    drifted_content = {
        key: value
        for key, value in drifted.items()
        if key != "contentHash"
    }
    drifted["contentHash"] = content_hash(drifted_content)
    with pytest.raises(
        prime.PrimeRlExecutionError, match="recipe_hash_mismatch"
    ):
        prime.resolve_prime_rl_settings(drifted)
    incomplete = signals()
    incomplete[0]["payload"].pop("optimizerSample")
    content = {
        key: value
        for key, value in incomplete[0].items()
        if key != "contentHash"
    }
    incomplete[0]["contentHash"] = content_hash(content)
    with pytest.raises(
        prime.PrimeRlExecutionError, match="signal_projection_invalid"
    ):
        prime.project_prime_rl_batch(
            plan=plan(), signal_values=incomplete, step=1
        )


def test_executes_pinned_trainer_command_and_exports_artifacts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    exact_plan = plan()
    settings = prime.resolve_prime_rl_settings(exact_plan)
    batch = prime.project_prime_rl_batch(
        plan=exact_plan, signal_values=signals(), step=1
    )
    commands: list[list[str]] = []

    def fake_batch(path: Path, _batch: prime.PrimeRlBatch) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"batch")

    def fake_run(arguments, **_kwargs):
        commands.append(arguments)
        engine_output = tmp_path / "engine" / "output"
        weights = engine_output / "weights" / "step_1"
        checkpoint = engine_output / "checkpoints" / "step_1"
        weights.mkdir(parents=True)
        checkpoint.mkdir(parents=True)
        (weights / "adapter_config.json").write_text("{}")
        (weights / "adapter_model.safetensors").write_bytes(b"adapter")
        (checkpoint / "optimizer.pt").write_bytes(b"optimizer")
        return subprocess.CompletedProcess(arguments, 0)

    monkeypatch.setattr(prime, "write_prime_rl_batch", fake_batch)
    receipt = prime.execute_prime_rl_step(
        plan=exact_plan,
        settings=settings,
        batch=batch,
        engine_root=tmp_path / "engine",
        output_directory=tmp_path / "artifacts",
        model_path=tmp_path / "model",
        timeout_seconds=30,
        run_process=fake_run,
    )
    assert commands[0][0:3] == [
        sys.executable,
        "-m",
        "torch.distributed.run",
    ]
    assert commands[0][-4:] == [
        "-m",
        "prime_rl.trainer.rl.train",
        "@",
        str(tmp_path / "engine" / "config" / "trainer.toml"),
    ]
    assert (
        tmp_path / "artifacts" / "adapter" / "adapter_model.safetensors"
    ).is_file()
    assert receipt["workerImageDigest"] == WORKER_DIGEST
    assert receipt["contentHash"] == content_hash(
        {
            key: value
            for key, value in receipt.items()
            if key != "contentHash"
        }
    )
    next_step, consumed = prime.load_prime_rl_progress(
        output_directory=tmp_path / "artifacts",
        plan=exact_plan,
        settings=settings,
    )
    assert next_step == 2
    assert consumed == set(batch.consumed_signal_ids)
    (
        tmp_path
        / "artifacts"
        / "checkpoints"
        / "step-1"
        / "optimizer.pt"
    ).write_bytes(b"tampered")
    with pytest.raises(
        prime.PrimeRlExecutionError,
        match="step_receipt_invalid",
    ):
        prime.load_prime_rl_progress(
            output_directory=tmp_path / "artifacts",
            plan=exact_plan,
            settings=settings,
        )


def test_materializes_model_and_tokenizer_at_their_exact_revisions(
    tmp_path: Path,
) -> None:
    settings = prime.resolve_prime_rl_settings(plan())
    commands: list[list[str]] = []

    def fake_run(arguments, **_kwargs):
        commands.append(arguments)
        destination = Path(arguments[arguments.index("--local-dir") + 1])
        destination.mkdir(parents=True, exist_ok=True)
        if arguments[arguments.index("--revision") + 1] == settings.model_revision:
            (destination / "config.json").write_text("{}")
        else:
            (destination / "tokenizer.json").write_text("{}")
        return subprocess.CompletedProcess(arguments, 0)

    model_path = prime.materialize_pinned_model(
        settings=settings,
        model_root=tmp_path,
        run_process=fake_run,
    )
    assert (model_path / "config.json").is_file()
    assert (model_path / "tokenizer.json").is_file()
    assert [command[command.index("--revision") + 1] for command in commands] == [
        settings.model_revision,
        settings.tokenizer_revision,
    ]
    assert prime.materialize_pinned_model(
        settings=settings,
        model_root=tmp_path,
        run_process=fake_run,
    ) == model_path
    assert len(commands) == 2


def test_signal_journal_is_hash_and_sequence_bound(tmp_path: Path) -> None:
    exact_plan = plan()
    batch_value = {
        "schemaVersion": "openpond.learningSignalBatch.v1",
        "manifestId": exact_plan["manifest"]["id"],
        "manifestHash": exact_plan["manifest"]["contentHash"],
        "sequence": 0,
        "signals": signals(),
    }
    batch = {**batch_value, "contentHash": content_hash(batch_value)}
    journal = tmp_path / "signals.jsonl"
    journal.write_text(json.dumps(batch) + "\n", encoding="utf-8")
    assert len(
        read_signal_journal(
            journal,
            manifest_id=exact_plan["manifest"]["id"],
            manifest_hash=exact_plan["manifest"]["contentHash"],
        )
    ) == 4
    batch["contentHash"] = "0" * 64
    journal.write_text(json.dumps(batch) + "\n", encoding="utf-8")
    with pytest.raises(
        prime.PrimeRlExecutionError, match="batch_hash_mismatch"
    ):
        read_signal_journal(
            journal,
            manifest_id=exact_plan["manifest"]["id"],
            manifest_hash=exact_plan["manifest"]["contentHash"],
        )


def test_cancellable_trainer_terminates_the_process_group(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    terminated: list[int] = []

    class Process:
        pid = 99

        def poll(self):
            return None

    monkeypatch.setattr(prime.subprocess, "Popen", lambda *_args, **_kwargs: Process())
    monkeypatch.setattr(
        prime,
        "_terminate_process_group",
        lambda process: terminated.append(process.pid),
    )
    assert (
        prime.run_cancellable_command(
            ["trainer"],
            cwd=tmp_path,
            timeout_seconds=30,
            cancelled=lambda: True,
        )
        == 130
    )
    assert terminated == [99]
