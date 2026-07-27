"""Bounded vLLM process used by OpenPond's raw-Prime evaluation sessions."""

from __future__ import annotations

import argparse
import json
import os
import signal
import time
from pathlib import Path
from typing import Any

from .vllm_runtime import (
    start_vllm,
    terminate_process,
    wait_for_vllm,
)
from .vllm_policy_manager import VllmPolicyManager


def run(args: argparse.Namespace) -> int:
    run_dir = Path(args.run_dir).resolve()
    run_dir.mkdir(parents=True, exist_ok=True)
    pid_path = claim_runner(run_dir)
    cancelled = [False]

    def cancel(_signum: int, _frame: Any) -> None:
        cancelled[0] = True

    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    launch = {
        "assignment": {
            "model": {
                "id": args.model_repository,
                "servedId": args.base_alias,
                "revision": args.model_revision,
                "path": args.model_path,
            },
            "inferencePort": args.port,
        }
    }
    process = None
    log: Any = None
    try:
        process, log = start_vllm(launch, run_dir)
        wait_for_vllm(
            args.port,
            process,
            args.model_timeout_seconds,
            run_dir / "vllm.log",
        )
        adapter_receipt = None
        if args.adapter_path:
            manager = VllmPolicyManager(
                base_url=f"http://127.0.0.1:{args.port}",
                base_model=args.base_alias,
            )
            adapter_receipt = manager.reload(
                policy_version=1,
                adapter_path=Path(args.adapter_path).resolve(),
                config_sha256=args.adapter_config_sha256,
                weights_sha256=args.adapter_weights_sha256,
                timeout_seconds=60,
            )
            verify_adapter_alias(
                adapter_receipt,
                args.adapter_alias,
            )
        receipt = {
            "schemaVersion": "openpond.vllmEvaluationServer.v1",
            "model": {
                "repository": args.model_repository,
                "revision": args.model_revision,
                "path": args.model_path,
                "baseAlias": args.base_alias,
                "adapterAlias": (
                    args.adapter_alias if args.adapter_path else None
                ),
            },
            "adapterReload": adapter_receipt,
            "port": args.port,
            "readyAt": utc_timestamp(),
        }
        (run_dir / "evaluation-server-receipt.json").write_text(
            json.dumps(receipt, sort_keys=True, indent=2) + "\n",
            encoding="utf-8",
        )
        while (
            not cancelled[0]
            and not (run_dir / "cancel").exists()
            and process.poll() is None
        ):
            time.sleep(0.25)
        if process.poll() is not None and not cancelled[0]:
            raise RuntimeError(
                f"vllm_evaluation_server_exited_{process.returncode}"
            )
        return 0
    finally:
        terminate_process(process)
        if log is not None:
            log.close()
        release_runner(pid_path)


def utc_timestamp() -> str:
    return (
        time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
        + f".{int(time.time_ns() / 1_000_000) % 1_000:03d}Z"
    )


def claim_runner(run_dir: Path) -> Path:
    run_dir.mkdir(parents=True, exist_ok=True)
    pid_path = run_dir / "openpond-runner.pid"
    for _attempt in range(2):
        try:
            descriptor = os.open(
                pid_path,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
        except FileExistsError:
            try:
                existing = int(pid_path.read_text(encoding="utf-8").strip())
            except (OSError, ValueError):
                existing = -1
            if existing > 0 and process_exists(existing):
                raise RuntimeError("vllm_evaluation_runner_already_active")
            pid_path.unlink(missing_ok=True)
            continue
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(f"{os.getpid()}\n")
            handle.flush()
            os.fsync(handle.fileno())
        return pid_path
    raise RuntimeError("vllm_evaluation_runner_lock_failed")


def release_runner(pid_path: Path) -> None:
    try:
        owner = int(pid_path.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return
    if owner == os.getpid():
        pid_path.unlink(missing_ok=True)


def process_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def verify_adapter_alias(
    adapter_receipt: dict[str, Any],
    expected_alias: str,
) -> None:
    if adapter_receipt.get("servedAlias") != expected_alias:
        raise RuntimeError(
            "vllm_evaluation_adapter_alias_mismatch"
        )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="OpenPond raw-Prime vLLM evaluation server"
    )
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--model-repository", required=True)
    parser.add_argument("--model-revision", required=True)
    parser.add_argument("--model-path", default="")
    parser.add_argument("--base-alias", required=True)
    parser.add_argument("--port", type=int, default=8_000)
    parser.add_argument("--model-timeout-seconds", type=int, default=900)
    parser.add_argument("--adapter-path", default="")
    parser.add_argument(
        "--adapter-config-sha256",
        default="",
    )
    parser.add_argument(
        "--adapter-weights-sha256",
        default="",
    )
    parser.add_argument(
        "--adapter-alias",
        default="openpond-policy-v1",
    )
    args = parser.parse_args()
    if not args.model_path:
        args.model_path = None
    raise SystemExit(run(args))


if __name__ == "__main__":
    main()
