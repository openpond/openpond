from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .contracts import ContractError, sha256_file
from .events import utc_now


def build_artifact_manifest(
    *, job_id: str, output_directory: Path, base_model_id: str, base_revision: str,
    tokenizer_revision: str, tokenizer_hash: str, chat_template_hash: str, metadata: dict[str, Any]
) -> dict[str, Any]:
    artifacts = []
    for file in sorted(output_directory.rglob("*")):
        if not file.is_file() or file.name in {"artifact-manifest.json", "events.jsonl"}:
            continue
        artifacts.append({"path": str(file.relative_to(output_directory)), "sha256": sha256_file(file), "sizeBytes": file.stat().st_size})
    manifest = {
        "schemaVersion": "openpond.localTrainingArtifactManifest.v1",
        "jobId": job_id,
        "nonProduction": True,
        "baseModel": {"id": base_model_id, "revision": base_revision},
        "tokenizerRevision": tokenizer_revision,
        "tokenizerHash": tokenizer_hash,
        "chatTemplateHash": chat_template_hash,
        "artifacts": artifacts,
        "metadata": metadata,
        "createdAt": utc_now(),
    }
    target = output_directory / "artifact-manifest.json"
    target.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return manifest


def validate_artifact_manifest(directory: Path) -> dict[str, Any]:
    target = directory / "artifact-manifest.json"
    if not target.is_file():
        raise ContractError("Portable artifact manifest is missing.")
    manifest = json.loads(target.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != "openpond.localTrainingArtifactManifest.v1":
        raise ContractError("Unsupported portable artifact manifest schemaVersion.")
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list):
        raise ContractError("Portable artifact manifest has no artifact list.")
    for item in artifacts:
        relative = Path(str(item.get("path", "")))
        if relative.is_absolute() or ".." in relative.parts:
            raise ContractError(f"Unsafe artifact path: {relative}.")
        file = directory / relative
        if not file.is_file() or file.is_symlink():
            raise ContractError(f"Artifact is missing or unsafe: {relative}.")
        if sha256_file(file) != item.get("sha256") or file.stat().st_size != item.get("sizeBytes"):
            raise ContractError(f"Artifact hash or size mismatch: {relative}.")
    if not (directory / "adapter" / "adapter_model.safetensors").is_file():
        raise ContractError("Portable artifact contains no LoRA safetensors adapter.")
    return manifest
