"""Prime-side grouped-GRPO runner for an OpenPond saved Model Run."""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .grouped_grpo_coordinator import (
    GroupedGrpoCoordinator,
    GroupedGrpoCoordinatorDependencies,
    GroupedGrpoCoordinatorSettings,
    canonical_json,
)
from .prime_rl_execution import (
    materialize_pinned_model,
    resolve_prime_rl_settings,
)
from .prime_rl_runtime import ensure_prime_grpo_runtime
from .prime_rollout_smoke_coordinator import (
    start_vllm,
    terminate_process,
    wait_for_vllm,
)
from .vllm_policy_manager import VllmPolicyManager


class PrimeGrpoRunnerError(RuntimeError):
    pass


class PrimeGrpoRuntime:
    def __init__(
        self,
        *,
        run_dir: Path,
        plan: dict[str, Any],
        callback_port: int,
        inference_port: int,
        callback_timeout_seconds: float,
        cancelled: Callable[[], bool],
    ) -> None:
        self.run_dir = run_dir
        self.plan = plan
        self.callback_port = callback_port
        self.inference_port = inference_port
        self.callback_timeout_seconds = callback_timeout_seconds
        self.cancelled = cancelled
        self.signals_path = run_dir / "signals.jsonl"
        self.output_directory = run_dir / "output"
        self.worker_log_path = run_dir / "prime-rl-worker.log"
        self.worker_process: subprocess.Popen[bytes] | None = None
        self.worker_log: Any = None
        self.reload_receipts: dict[int, dict[str, Any]] = {}
        self.policy_manager = VllmPolicyManager(
            base_url=f"http://127.0.0.1:{inference_port}",
            base_model=str(plan["recipe"]["baseModel"]["id"]),
        )

    def start_worker(self, project_root: Path, model_cache: Path) -> None:
        self.output_directory.mkdir(parents=True, exist_ok=True)
        self.signals_path.touch(exist_ok=True)
        cancel_path = self.run_dir / "cancel"
        command = [
            sys.executable,
            "-m",
            "openpond_training.prime_rl_worker",
            "--bundle",
            str(self.run_dir / "resolved-training-bundle"),
            "--plan",
            str(self.run_dir / "resolved-plan.json"),
            "--output",
            str(self.output_directory),
            "--signals",
            str(self.signals_path),
            "--job-id",
            str(self.plan["manifest"]["id"]),
            "--cancel-file",
            str(cancel_path),
        ]
        environment = dict(os.environ)
        environment["PYTHONPATH"] = str(project_root / "src")
        environment["OPENPOND_PRIME_RL_MODEL_CACHE"] = str(model_cache)
        self.worker_log = self.worker_log_path.open("wb")
        self.worker_process = subprocess.Popen(
            command,
            cwd=project_root,
            env=environment,
            stdout=self.worker_log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

    def close(self) -> None:
        terminate_process(self.worker_process)
        if self.worker_log is not None:
            self.worker_log.close()

    def rollout(self, assignment: dict[str, Any]) -> dict[str, Any]:
        return post_json(
            f"http://127.0.0.1:{self.callback_port}/grouped-rollout",
            assignment,
            self.callback_timeout_seconds,
        )

    def deliver_signals(self, batch: dict[str, Any]) -> None:
        with self.signals_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(batch, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())

    def wait_optimizer(
        self,
        step: int,
        timeout_seconds: float,
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_seconds
        receipt_path = (
            self.output_directory / "prime-rl-step-receipts.jsonl"
        )
        while time.monotonic() < deadline:
            if self.cancelled():
                raise PrimeGrpoRunnerError("prime_grpo_cancelled")
            receipt = read_step_receipt(receipt_path, step)
            if receipt is not None:
                return receipt
            if (
                self.worker_process is not None
                and self.worker_process.poll() is not None
            ):
                tail = read_log_tail(self.worker_log_path)
                raise PrimeGrpoRunnerError(
                    "prime_rl_worker_exited_before_optimizer_receipt"
                    f" (code {self.worker_process.returncode}): {tail}"
                )
            time.sleep(0.25)
        raise PrimeGrpoRunnerError("prime_rl_optimizer_timeout")

    def reload_adapter(
        self,
        step: int,
        optimizer: dict[str, Any],
    ) -> int:
        policy_version = step
        adapter = optimizer["adapter"]
        receipt = self.policy_manager.reload(
            policy_version=policy_version,
            adapter_path=Path(str(adapter["path"])),
            config_sha256=str(adapter["configSha256"]),
            weights_sha256=str(adapter["weightsSha256"]),
            timeout_seconds=60,
        )
        self.reload_receipts[policy_version] = receipt
        return policy_version

    def verify_policy(self, policy_version: int) -> dict[str, Any]:
        receipt = self.reload_receipts.get(policy_version)
        if receipt is None:
            raise PrimeGrpoRunnerError(
                "prime_grpo_reload_receipt_missing"
            )
        return receipt


def run(args: argparse.Namespace) -> int:
    dependency_started = _span_start()
    run_dir = Path(args.run_dir).resolve()
    project_root = Path(args.project_root).resolve()
    plan_path = run_dir / "resolved-plan.json"
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    if not isinstance(plan, dict):
        raise PrimeGrpoRunnerError("prime_grpo_plan_invalid")
    settings = resolve_prime_rl_settings(plan)
    task_ids = load_task_ids(run_dir / "launch.json")
    bootstrap_timeline = [
        _span_finish("dependency_setup", dependency_started)
    ]
    cancelled = [False]

    def request_cancel(_signum: int, _frame: Any) -> None:
        cancelled[0] = True
        (run_dir / "cancel").touch()

    signal.signal(signal.SIGTERM, request_cancel)
    signal.signal(signal.SIGINT, request_cancel)
    is_cancelled = lambda: cancelled[0] or (run_dir / "cancel").exists()
    runner_pid_path = claim_runner(run_dir)
    vllm_process: subprocess.Popen[bytes] | None = None
    vllm_log: Any = None
    runtime: PrimeGrpoRuntime | None = None
    try:
        dependency_bootstrap_started = _span_start()
        ensure_prime_grpo_runtime(run_dir)
        bootstrap_timeline.append(
            _span_finish(
                "dependency_bootstrap",
                dependency_bootstrap_started,
            )
        )
        model_cache = run_dir / "model-cache"
        base_materialization_started = _span_start()
        model_path = materialize_pinned_model(
            settings=settings,
            model_root=model_cache,
        )
        bootstrap_timeline.append(
            _span_finish(
                "base_materialization",
                base_materialization_started,
            )
        )
        launch = {
            "assignment": {
                "model": {
                    "id": settings.model_id,
                    "revision": settings.model_revision,
                    "path": str(model_path),
                },
                "inferencePort": args.inference_port,
            }
        }
        runtime = PrimeGrpoRuntime(
            run_dir=run_dir,
            plan=plan,
            callback_port=args.callback_port,
            inference_port=args.inference_port,
            callback_timeout_seconds=args.callback_timeout_seconds,
            cancelled=is_cancelled,
        )
        base_load_started = _span_start()
        vllm_process, vllm_log = start_vllm(launch, run_dir)
        wait_for_vllm(
            args.inference_port,
            vllm_process,
            args.model_timeout_seconds,
            run_dir / "vllm.log",
        )
        bootstrap_timeline.append(
            _span_finish("base_engine_load", base_load_started)
        )
        restore_served_policy(
            run_dir / "grouped-grpo-state.json",
            runtime,
        )
        worker_started = _span_start()
        runtime.start_worker(project_root, model_cache)
        bootstrap_timeline.append(
            _span_finish("connected_worker_start", worker_started)
        )
        coordinator = GroupedGrpoCoordinator(
            settings=GroupedGrpoCoordinatorSettings(
                run_id=str(plan["manifest"]["id"]),
                manifest_id=str(plan["manifest"]["id"]),
                manifest_hash=str(plan["manifest"]["contentHash"]),
                task_ids=tuple(task_ids),
                group_size=settings.group_size,
                maximum_steps=settings.maximum_steps,
                initial_policy_version=0,
                seed=int(plan["recipe"]["rollout"]["seed"]),
                timeout_seconds=settings.wall_time_seconds,
                initial_timeline=tuple(bootstrap_timeline),
            ),
            dependencies=GroupedGrpoCoordinatorDependencies(
                rollout=runtime.rollout,
                deliver_signals=runtime.deliver_signals,
                wait_optimizer=runtime.wait_optimizer,
                reload_adapter=runtime.reload_adapter,
                verify_policy=runtime.verify_policy,
                cancelled=is_cancelled,
            ),
            state_path=run_dir / "grouped-grpo-state.json",
        )
        receipt = coordinator.run()
        receipt_path = run_dir / "grouped-grpo-receipt.json"
        receipt_path.write_text(
            canonical_json(receipt),
            encoding="utf-8",
        )
        print(canonical_json(receipt), end="")
        return 0
    finally:
        if runtime is not None:
            runtime.close()
        terminate_process(vllm_process)
        if vllm_log is not None:
            vllm_log.close()
        release_runner(runner_pid_path)


def restore_served_policy(
    state_path: Path,
    runtime: PrimeGrpoRuntime,
) -> int:
    if not state_path.is_file():
        return 0
    state = json.loads(state_path.read_text(encoding="utf-8"))
    if not isinstance(state, dict):
        raise PrimeGrpoRunnerError("prime_grpo_resume_state_invalid")
    policy_version = state.get("policyVersion", 0)
    receipts = state.get("optimizerReceipts", [])
    if (
        not isinstance(policy_version, int)
        or isinstance(policy_version, bool)
        or policy_version < 0
        or not isinstance(receipts, list)
        or policy_version > len(receipts)
    ):
        raise PrimeGrpoRunnerError("prime_grpo_resume_state_invalid")
    if policy_version == 0:
        return 0
    optimizer = receipts[policy_version - 1]
    if (
        not isinstance(optimizer, dict)
        or optimizer.get("step") != policy_version
        or optimizer.get("policyVersion") != policy_version - 1
    ):
        raise PrimeGrpoRunnerError("prime_grpo_resume_state_invalid")
    restored = runtime.reload_adapter(policy_version, optimizer)
    if restored != policy_version:
        raise PrimeGrpoRunnerError(
            "prime_grpo_resume_reload_policy_mismatch"
        )
    runtime.verify_policy(policy_version)
    return policy_version


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
                existing = int(
                    pid_path.read_text(encoding="utf-8").strip()
                )
            except (OSError, ValueError):
                existing = -1
            if existing > 0 and process_exists(existing):
                raise PrimeGrpoRunnerError(
                    "prime_grpo_runner_already_active"
                )
            pid_path.unlink(missing_ok=True)
            continue
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(f"{os.getpid()}\n")
            handle.flush()
            os.fsync(handle.fileno())
        return pid_path
    raise PrimeGrpoRunnerError("prime_grpo_runner_lock_failed")


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


def load_task_ids(path: Path) -> list[str]:
    launch = json.loads(path.read_text(encoding="utf-8"))
    task_ids = launch.get("taskIds") if isinstance(launch, dict) else None
    if (
        not isinstance(task_ids, list)
        or not task_ids
        or any(
            not isinstance(task_id, str) or not task_id
            for task_id in task_ids
        )
        or len(set(task_ids)) != len(task_ids)
    ):
        raise PrimeGrpoRunnerError("prime_grpo_task_ids_invalid")
    return task_ids


def post_json(
    url: str,
    payload: dict[str, Any],
    timeout_seconds: float,
) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, sort_keys=True).encode(),
        method="POST",
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(
            request,
            timeout=timeout_seconds,
        ) as response:
            raw = response.read(16 * 1024 * 1024)
            if response.status != 200:
                raise PrimeGrpoRunnerError(
                    f"prime_grpo_callback_http_{response.status}"
                )
    except urllib.error.HTTPError as error:
        detail = error.read(2_000).decode(
            "utf-8",
            errors="replace",
        )
        raise PrimeGrpoRunnerError(
            f"prime_grpo_callback_http_{error.code}: {detail}"
        ) from error
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise PrimeGrpoRunnerError("prime_grpo_callback_invalid")
    return value


def read_step_receipt(path: Path, step: int) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    raw = path.read_text(encoding="utf-8")
    lines = raw.splitlines()
    if raw and not raw.endswith("\n"):
        lines = lines[:-1]
    matches: list[dict[str, Any]] = []
    for line in lines:
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise PrimeGrpoRunnerError(
                "prime_grpo_optimizer_receipt_invalid"
            )
        if value.get("step") == step:
            matches.append(value)
    if len(matches) > 1:
        raise PrimeGrpoRunnerError(
            "prime_grpo_optimizer_receipt_duplicate"
        )
    return matches[0] if matches else None


def read_log_tail(path: Path) -> str:
    if not path.is_file():
        return "no worker log"
    return path.read_text(
        encoding="utf-8",
        errors="replace",
    )[-4_000:].replace("\n", " ")


def _span_start() -> tuple[float, str]:
    return time.monotonic(), _timestamp()


def _span_finish(
    name: str,
    started: tuple[float, str],
) -> dict[str, Any]:
    return {
        "name": name,
        "startedAt": started[1],
        "completedAt": _timestamp(),
        "durationMs": max(
            0,
            (time.monotonic() - started[0]) * 1_000,
        ),
        "clock": "monotonic",
        "outcome": "succeeded",
    }


def _timestamp() -> str:
    return (
        time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
        + f".{int(time.time_ns() / 1_000_000) % 1_000:03d}Z"
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="OpenPond grouped-GRPO Prime raw GPU runner"
    )
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--callback-port", type=int, required=True)
    parser.add_argument("--inference-port", type=int, default=8_000)
    parser.add_argument("--model-timeout-seconds", type=int, default=900)
    parser.add_argument(
        "--callback-timeout-seconds",
        type=float,
        default=600,
    )
    args = parser.parse_args()
    try:
        raise SystemExit(run(args))
    except Exception as error:
        print(
            json.dumps(
                {
                    "event": "failure",
                    "error": str(error),
                },
                sort_keys=True,
            ),
            file=sys.stderr,
            flush=True,
        )
        raise


if __name__ == "__main__":
    main()
