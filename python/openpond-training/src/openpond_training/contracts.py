from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from jsonschema import Draft7Validator


class ContractError(ValueError):
    pass


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_contract(name: str, value: Any) -> None:
    schema_path = Path(__file__).with_name("schemas") / f"{name}.schema.json"
    if not schema_path.is_file():
        raise ContractError(f"Generated contract schema is missing: {schema_path.name}.")
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    errors = sorted(Draft7Validator(schema).iter_errors(value), key=lambda error: list(error.path))
    if errors:
        first = errors[0]
        location = ".".join(str(part) for part in first.path) or "<root>"
        raise ContractError(f"{name} contract failed at {location}: {first.message}")


def load_bundle(directory: Path) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    manifest_path = directory / "manifest.json"
    if not manifest_path.is_file():
        raise ContractError("Training Bundle manifest.json is missing.")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    validate_contract("training-bundle", manifest)
    if manifest.get("schemaVersion") != "openpond.trainingBundle.v1":
        raise ContractError("Unsupported Training Bundle schemaVersion.")
    if manifest.get("containsRawChats") or manifest.get("containsSecrets") or manifest.get("containsHiddenGraderAssets"):
        raise ContractError("Training Bundle privacy flags are unsafe.")
    for item in manifest.get("files", []):
        if item.get("path") == "manifest.json":
            continue
        relative = Path(str(item.get("path", "")))
        if relative.is_absolute() or ".." in relative.parts:
            raise ContractError(f"Unsafe bundle file path: {relative}.")
        target = directory / relative
        if not target.is_file():
            raise ContractError(f"Bundle file is missing: {relative}.")
        if sha256_file(target) != item.get("sha256"):
            raise ContractError(f"Bundle file hash mismatch: {relative}.")
        if target.stat().st_size != item.get("sizeBytes"):
            raise ContractError(f"Bundle file size mismatch: {relative}.")
    recipe = json.loads((directory / "recipe.json").read_text(encoding="utf-8"))
    method = recipe.get("method")
    if method == "sft":
        validate_contract("sft-recipe", recipe)
        if recipe.get("schemaVersion") != "openpond.sftRecipe.v1":
            raise ContractError("Unsupported SFT recipe schemaVersion.")
        record_contract = "sft-training-record"
    elif method == "dpo":
        validate_contract("dpo-recipe", recipe)
        if recipe.get("schemaVersion") != "openpond.dpoRecipe.v1":
            raise ContractError("Unsupported DPO recipe schemaVersion.")
        record_contract = "dpo-training-record"
    elif method == "ppo":
        validate_contract("ppo-recipe", recipe)
        if recipe.get("schemaVersion") != "openpond.ppoRecipe.v1":
            raise ContractError("Unsupported PPO recipe schemaVersion.")
        record_contract = "policy-training-record"
    else:
        raise ContractError("The local worker executes only SFT, DPO, and PPO recipes.")
    if recipe.get("parameterization") != "lora":
        raise ContractError("The local worker requires LoRA parameterization.")
    records: list[dict[str, Any]] = []
    for line in (directory / "data" / "train.jsonl").read_text(encoding="utf-8").splitlines():
        if line.strip():
            record = json.loads(line)
            validate_contract(record_contract, record)
            if method == "sft" and (
                not isinstance(record.get("input"), dict)
                or not isinstance(record.get("expectedOutput"), dict)
            ):
                raise ContractError("Every SFT record requires input and expectedOutput objects.")
            records.append(record)
    if not records:
        raise ContractError("Training dataset is empty.")
    return manifest, recipe, records
