"""Verify every immutable source byte before local-only native model loading."""
from __future__ import annotations
import importlib.util
from pathlib import Path
from .artifacts import require, file_hash, read_json
from ..wire import canonical_sha256


def verify_sources(model, directories, check):
    from ponder_sdk.decision_identity import verify_decision_model_identity
    model = verify_decision_model_identity(model)
    require(type(directories) is dict and set(directories) == {"backbone", "originalAdapter", "tokenizer", "reference", "backboneLicense", "releaseLicense"}, "source_directories")
    manifests = {"backbone": model["backbone"]["source"], "originalAdapter": model["originalAdapter"],
                 "tokenizer": model["tokenizer"], "reference": model["reference"],
                 "backboneLicense": model["license"]["files"][0], "releaseLicense": model["license"]["files"][1]}
    roots = {}
    for key, manifest in manifests.items():
        root = Path(directories[key])
        require(root.is_dir() and not root.is_symlink(), "source_directory_invalid")
        expected = {row["path"] for row in manifest["files"]}
        # Local-only HF loading must not discover an unverified extra config,
        # tokenizer or weight file. Each logical directory is exactly its pin.
        require({path.name for path in root.iterdir()} == expected, "source_file_inventory")
        for row in manifest["files"]:
            check()
            path = root / row["path"]
            require(path.is_file() and not path.is_symlink() and path.stat().st_size == row["sizeBytes"]
                    and file_hash(path, check) == row["sha256"], "source_file_changed")
        require(canonical_sha256({key: value for key, value in manifest.items() if key != "contentHash"}) == manifest["contentHash"], "source_manifest_changed")
        roots[key] = root
    schema = read_json(roots["reference"] / "schema_config.json")
    require(schema["task"] == "schema_candidate_classification_v1" and schema["model"] == model["backbone"]["source"]["repository"]
            and schema["revision"] == model["backbone"]["source"]["revision"] and schema["max_length"] == 2048
            and schema["prompt_code_sha256"] == "a0a0f94d0f65e972bc20d088678ad3d595ff1c42b9c0d78f96034526303f63fc", "reference_contract_changed")
    vendored = Path(__file__).parent / "decision_prompt" / "parallel_schema.py"
    require(file_hash(vendored, check) == schema["prompt_code_sha256"], "vendored_prompt_changed")
    spec = importlib.util.spec_from_file_location("openpond_decision_pinned_prompts", vendored)
    require(spec is not None and spec.loader is not None, "prompt_import_unavailable")
    module = importlib.util.module_from_spec(spec)
    # dataclasses introspects its defining module; register only this immutable
    # source-owned module, never a caller path or downloaded executable module.
    import sys
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return roots, module.prepare_prompts
