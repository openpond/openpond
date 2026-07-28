from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from .learning_signals import (
    CanonicalSignal,
    project_dpo_records,
    project_online_rollouts,
    project_sft_records,
)


TRL_UPSTREAM_REVISION = "0.26.2"


@dataclass(frozen=True)
class EngineProjection:
    adapter_id: str
    upstream_revision: str
    method: str
    records: list[dict[str, Any]]
    configuration: dict[str, Any]


class EngineAdapter(Protocol):
    adapter_id: str
    upstream_revision: str

    def project(
        self,
        *,
        method: str,
        signals: list[CanonicalSignal],
        manifest: dict[str, Any],
    ) -> EngineProjection: ...


class TrlEngineAdapter:
    adapter_id = "trl"
    upstream_revision = TRL_UPSTREAM_REVISION

    def project(
        self,
        *,
        method: str,
        signals: list[CanonicalSignal],
        manifest: dict[str, Any],
    ) -> EngineProjection:
        validate_signal_lineage(signals, manifest)
        normalized = method.lower()
        if normalized in {"sft", "sdft"}:
            records = project_sft_records(signals)
            trainer = "trl.SFTTrainer"
        elif normalized in {"dpo", "orpo"}:
            records = project_dpo_records(signals)
            trainer = (
                "trl.DPOTrainer"
                if normalized == "dpo"
                else "trl.ORPOTrainer"
            )
        elif normalized in {"ppo", "grpo"}:
            records = project_online_rollouts(signals)
            trainer = "trl.PPOTrainer" if normalized == "ppo" else "trl.GRPOTrainer"
        else:
            raise ValueError(f"TRL adapter does not support {method}")
        if not records:
            raise ValueError(f"no canonical {normalized} records were available")
        return EngineProjection(
            adapter_id=self.adapter_id,
            upstream_revision=self.upstream_revision,
            method=normalized,
            records=records,
            configuration={
                "trainer": trainer,
                "technique": (
                    "self-distillation"
                    if normalized == "sdft"
                    else "odds-ratio-preference-optimization"
                    if normalized == "orpo"
                    else normalized
                ),
                "manifestHash": _manifest_hash(manifest),
                "model": manifest.get("model"),
                "recipe": manifest.get("recipe"),
            },
        )


def _manifest_hash(manifest: dict[str, Any]) -> str:
    value = manifest.get("contentHash")
    if not isinstance(value, str) or len(value) != 64:
        raise ValueError("engine adapter requires a canonical Harness Run Manifest")
    return value


def validate_signal_lineage(
    signals: list[CanonicalSignal],
    manifest: dict[str, Any],
) -> None:
    dataset = manifest.get("datasetRelease")
    harness = manifest.get("harnessRelease")
    model = manifest.get("model")
    evidence = manifest.get("evidenceSets")
    if (
        not isinstance(dataset, dict)
        or not isinstance(harness, dict)
        or not isinstance(model, dict)
        or not isinstance(evidence, list)
    ):
        raise ValueError(
            "engine adapter requires complete release and Model lineage"
        )
    evidence_identities = {
        (item.get("id"), item.get("contentHash"))
        for item in evidence
        if isinstance(item, dict)
    }
    for signal in signals:
        lineage = signal.lineage
        if (
            lineage.get("datasetRelease") != dataset
            or lineage.get("harnessRelease") != harness
            or lineage.get("model") != {
                "source": model.get("source"),
                "revision": model.get("revision"),
                "artifactHash": model.get("artifactHash"),
            }
        ):
            raise ValueError(
                f"learning signal {signal.id} does not match the run manifest"
            )
        evidence_ref = lineage.get("evidenceSetRelease")
        if evidence_ref is not None and (
            evidence_ref.get("id"),
            evidence_ref.get("contentHash"),
        ) not in evidence_identities:
            raise ValueError(
                f"learning signal {signal.id} Evidence Set is not in the run manifest"
            )
