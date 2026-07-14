from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
import sys
import threading
import time
from pathlib import Path
from typing import Any

from huggingface_hub import hf_hub_download
from safetensors import safe_open

REQUIRED_FILES = [
    "config.json",
    "generation_config.json",
    "merges.txt",
    "model.safetensors",
    "special_tokens_map.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.json",
]


class DownloadCancelled(RuntimeError):
    pass


def emit(kind: str, payload: dict[str, Any]) -> None:
    print(json.dumps({"type": kind, **payload}, sort_keys=True), flush=True)


def directory_bytes(directory: Path) -> int:
    total = 0
    for root, _directories, files in os.walk(directory):
        for name in files:
            try:
                total += (Path(root) / name).stat().st_size
            except OSError:
                pass
    return total


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(args: argparse.Namespace) -> int:
    destination = Path(args.destination).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    cancelled = threading.Event()

    def request_cancel(_signum: int, _frame: Any) -> None:
        cancelled.set()

    signal.signal(signal.SIGTERM, request_cancel)
    signal.signal(signal.SIGINT, request_cancel)
    emit("start", {"destinationPath": str(destination), "expectedBytes": args.expected_bytes})
    try:
        for filename in REQUIRED_FILES:
            if cancelled.is_set():
                raise DownloadCancelled("Model download was cancelled.")
            stop_polling = threading.Event()

            def poll_progress() -> None:
                while not stop_polling.wait(0.5):
                    emit("progress", {"downloadedBytes": min(args.expected_bytes, directory_bytes(destination)), "file": filename})

            poller = threading.Thread(target=poll_progress, daemon=True)
            poller.start()
            try:
                hf_hub_download(repo_id=args.model_id, filename=filename, revision=args.revision, local_dir=destination)
            finally:
                stop_polling.set()
                poller.join(timeout=1)
            emit("progress", {"downloadedBytes": min(args.expected_bytes, directory_bytes(destination)), "file": filename})
        if cancelled.is_set():
            raise DownloadCancelled("Model download was cancelled.")
        emit("verifying", {"downloadedBytes": directory_bytes(destination)})
        weight_path = destination / "model.safetensors"
        actual_hash = sha256_file(weight_path)
        if actual_hash != args.weight_sha256:
            raise RuntimeError(f"Model weight SHA-256 mismatch: expected {args.weight_sha256}, received {actual_hash}.")
        with safe_open(weight_path, framework="pt", device="cpu") as weights:
            tensor_count = len(weights.keys())
            if tensor_count == 0:
                raise RuntimeError("Safetensors model contained no tensors.")
        config = json.loads((destination / "config.json").read_text(encoding="utf-8"))
        tokenizer_config = json.loads((destination / "tokenizer_config.json").read_text(encoding="utf-8"))
        template = tokenizer_config.get("chat_template")
        template_hash = hashlib.sha256(str(template).encode("utf-8")).hexdigest() if isinstance(template, str) else None
        if config.get("architectures") != [args.architecture]:
            raise RuntimeError(f"Unexpected model architecture: {config.get('architectures')}.")
        if template_hash != args.chat_template_hash:
            raise RuntimeError("Downloaded tokenizer chat template did not match the pinned recipe.")
        metadata = {
            "schemaVersion": "openpond.modelSnapshot.v1",
            "modelId": args.model_id,
            "revision": args.revision,
            "tokenizerRevision": args.revision,
            "chatTemplateHash": template_hash,
            "license": args.license,
            "parameterCount": args.parameter_count,
            "architecture": args.architecture,
            "weightSha256": actual_hash,
            "sizeBytes": sum((destination / name).stat().st_size for name in REQUIRED_FILES),
            "tensorCount": tensor_count,
            "verifiedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        temporary = destination / "openpond-model.json.tmp"
        temporary.write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        temporary.replace(destination / "openpond-model.json")
        emit("complete", {"downloadedBytes": metadata["sizeBytes"], "metadata": metadata})
        return 0
    except DownloadCancelled as error:
        emit("cancel", {"message": str(error), "downloadedBytes": directory_bytes(destination)})
        return 130
    except Exception as error:
        emit("failure", {"errorType": type(error).__name__, "message": str(error)[:20000], "downloadedBytes": directory_bytes(destination)})
        return 1


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="openpond-models")
    result.add_argument("command", choices=["download"])
    result.add_argument("--model-id", required=True)
    result.add_argument("--revision", required=True)
    result.add_argument("--destination", required=True)
    result.add_argument("--license", required=True)
    result.add_argument("--expected-bytes", required=True, type=int)
    result.add_argument("--weight-sha256", required=True)
    result.add_argument("--chat-template-hash", required=True)
    result.add_argument("--architecture", required=True)
    result.add_argument("--parameter-count", required=True, type=int)
    return result


def main() -> None:
    args = parser().parse_args()
    raise SystemExit(download(args))


if __name__ == "__main__":
    main()
