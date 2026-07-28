from __future__ import annotations

from openpond_training.canonical_json import content_hash
from openpond_training.engine_adapters import (
    TrlEngineAdapter,
)
from openpond_training.learning_signals import parse_signals


def signal(kind: str, payload: dict, *, signal_id: str, approved: bool = True) -> dict:
    content = {
        "schemaVersion": "openpond.learningSignal.v1",
        "id": signal_id,
        "taskId": "task-1",
        "episodeId": "episode-1",
        "policyVersion": 0 if kind in {"trajectory", "reward"} else None,
        "kind": kind,
        "payload": payload,
        "lineage": lineage(),
        "approved": approved,
        "verifier": "none"
        if kind == "infrastructure_failure"
        else "deterministic",
        "createdAt": "2026-07-23T12:00:00.000Z",
        "metadata": {},
    }
    return {**content, "contentHash": content_hash(content)}

def manifest() -> dict:
    return {
        "schemaVersion": "openpond.harnessRunManifest.v1",
        "contentHash": "b" * 64,
        "datasetRelease": {
            "id": "dataset-release-1",
            "contentHash": "c" * 64,
        },
        "harnessRelease": {
            "id": "harness-release-1",
            "contentHash": "d" * 64,
        },
        "evidenceSets": [],
        "model": {
            "source": "huggingface",
            "revision": "model-revision",
            "artifactHash": None,
        },
        "recipe": {"method": "grpo", "version": "1"},
        "runtimeTarget": {
            "adapterId": "sandbox",
            "placement": "remote",
            "capabilityReceipt": "c" * 64,
        },
    }


def lineage() -> dict:
    exact_manifest = manifest()
    return {
        "datasetRelease": exact_manifest["datasetRelease"],
        "harnessRelease": exact_manifest["harnessRelease"],
        "evidenceSetRelease": None,
        "profileRelease": None,
        "model": exact_manifest["model"],
        "environmentHash": "e" * 64,
        "graderHash": "f" * 64,
        "toolContractHash": "a" * 64,
        "verificationReceiptHash": "9" * 64,
    }


def test_trl_projects_sft_and_dpo_from_canonical_offline_signals() -> None:
    adapter = TrlEngineAdapter()
    sft = adapter.project(
        method="sft",
        signals=parse_signals(
            [
                signal(
                    "demonstration",
                    {"prompt": "2+2", "response": "4"},
                    signal_id="demo-1",
                )
            ]
        ),
        manifest=manifest(),
    )
    dpo = adapter.project(
        method="dpo",
        signals=parse_signals(
            [
                signal(
                    "preference",
                    {"prompt": "2+2", "chosen": "4", "rejected": "5"},
                    signal_id="preference-1",
                )
            ]
        ),
        manifest=manifest(),
    )
    assert sft.configuration["trainer"] == "trl.SFTTrainer"
    assert sft.records[0]["completion"] == "4"
    assert dpo.configuration["trainer"] == "trl.DPOTrainer"
    assert dpo.records[0]["rejected"] == "5"


def test_trl_projects_sdft_and_orpo_after_canonical_adapter_conformance() -> None:
    adapter = TrlEngineAdapter()
    sdft = adapter.project(
        method="sdft",
        signals=parse_signals(
            [
                signal(
                    "demonstration",
                    {
                        "prompt": "Explain the correction",
                        "response": "Use the verified teacher response.",
                    },
                    signal_id="sdft-demo-1",
                )
            ]
        ),
        manifest=manifest(),
    )
    orpo = adapter.project(
        method="orpo",
        signals=parse_signals(
            [
                signal(
                    "preference",
                    {
                        "prompt": "Choose the verified answer",
                        "chosen": "verified",
                        "rejected": "unverified",
                    },
                    signal_id="orpo-preference-1",
                )
            ]
        ),
        manifest=manifest(),
    )
    assert sdft.configuration["technique"] == "self-distillation"
    assert sdft.configuration["trainer"] == "trl.SFTTrainer"
    assert orpo.configuration["technique"] == "odds-ratio-preference-optimization"
    assert orpo.configuration["trainer"] == "trl.ORPOTrainer"


def test_infrastructure_failures_are_never_training_records() -> None:
    signals = parse_signals(
        [
            signal(
                "infrastructure_failure",
                {
                    "code": "transport",
                    "phase": "step",
                    "retryable": True,
                    "rewardEligible": False,
                },
                signal_id="failure-1",
                approved=False,
            )
        ]
    )
    try:
        TrlEngineAdapter().project(method="grpo", signals=signals, manifest=manifest())
    except ValueError as error:
        assert "no canonical grpo records" in str(error)
    else:
        raise AssertionError("infrastructure failure became a training record")


def test_engine_adapters_reject_signal_lineage_from_another_release() -> None:
    value = signal(
        "demonstration",
        {"prompt": "2+2", "response": "4"},
        signal_id="wrong-lineage",
    )
    value["lineage"]["datasetRelease"]["contentHash"] = "8" * 64
    content = {key: item for key, item in value.items() if key != "contentHash"}
    value["contentHash"] = content_hash(content)
    signals = parse_signals([value])
    try:
        TrlEngineAdapter().project(
            method="sft",
            signals=signals,
            manifest=manifest(),
        )
    except ValueError as error:
        assert "does not match the run manifest" in str(error)
    else:
        raise AssertionError("cross-release learning signal was accepted")
