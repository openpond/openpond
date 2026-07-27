from __future__ import annotations

import fcntl
import hashlib
import json
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .prime_rl_contracts import PrimeRlExecutionError, PrimeRlSettings


def materialize_pinned_model(
    *,
    settings: PrimeRlSettings,
    model_root: Path,
    run_process: Callable[..., subprocess.CompletedProcess[Any]] = subprocess.run,
) -> Path:
    identity = hashlib.sha256(
        (
            f"{settings.model_id}@{settings.model_revision}"
            f"#tokenizer={settings.tokenizer_revision}"
        ).encode()
    ).hexdigest()[:24]
    model_root.mkdir(parents=True, exist_ok=True)
    lock_path = model_root / f"{identity}.lock"
    with lock_path.open("a", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            return _materialize_pinned_model_locked(
                settings=settings,
                model_root=model_root,
                identity=identity,
                run_process=run_process,
            )
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def _materialize_pinned_model_locked(
    *,
    settings: PrimeRlSettings,
    model_root: Path,
    identity: str,
    run_process: Callable[..., subprocess.CompletedProcess[Any]],
) -> Path:
    model_path = model_root / identity
    receipt = model_path / "openpond-model-receipt.json"
    if receipt.is_file():
        value = json.loads(receipt.read_text(encoding="utf-8"))
        if (
            value.get("modelId") == settings.model_id
            and value.get("revision") == settings.model_revision
            and (model_path / "config.json").is_file()
        ):
            return model_path
        raise PrimeRlExecutionError("prime_rl_model_cache_lineage_mismatch")
    model_path.mkdir(parents=True, exist_ok=True)
    result = run_process(
        [
            shutil.which("hf") or "hf",
            "download",
            settings.model_id,
            "--revision",
            settings.model_revision,
            "--local-dir",
            str(model_path),
        ],
        check=False,
    )
    if result.returncode != 0 or not (model_path / "config.json").is_file():
        raise PrimeRlExecutionError("prime_rl_model_materialization_failed")
    if settings.tokenizer_revision != settings.model_revision:
        tokenizer_overlay = model_root / f".{identity}-tokenizer"
        shutil.rmtree(tokenizer_overlay, ignore_errors=True)
        tokenizer_result = run_process(
            [
                shutil.which("hf") or "hf",
                "download",
                settings.model_id,
                "--revision",
                settings.tokenizer_revision,
                "--include",
                "tokenizer*",
                "special_tokens_map.json",
                "added_tokens.json",
                "vocab*",
                "merges.txt",
                "*.model",
                "chat_template*",
                "--local-dir",
                str(tokenizer_overlay),
            ],
            check=False,
        )
        tokenizer_files = [
            path
            for path in tokenizer_overlay.rglob("*")
            if path.is_file() and ".cache" not in path.parts
        ]
        if tokenizer_result.returncode != 0 or not tokenizer_files:
            shutil.rmtree(tokenizer_overlay, ignore_errors=True)
            raise PrimeRlExecutionError(
                "prime_rl_tokenizer_materialization_failed"
            )
        for source in tokenizer_files:
            relative = source.relative_to(tokenizer_overlay)
            target = model_path / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        shutil.rmtree(tokenizer_overlay)
    receipt.write_text(
        json.dumps(
            {
                "schemaVersion": "openpond.modelMaterializationReceipt.v1",
                "modelId": settings.model_id,
                "revision": settings.model_revision,
                "tokenizerRevision": settings.tokenizer_revision,
            },
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    return model_path
