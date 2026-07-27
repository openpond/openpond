"""Stable facade for the focused Prime RL execution modules."""

from __future__ import annotations

import os
import signal
import subprocess
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .canonical_json import content_hash
from .prime_rl_batch import (
    project_prime_rl_batch,
    write_prime_rl_batch,
)
from .prime_rl_configuration import (
    render_prime_rl_run_config,
    render_prime_rl_trainer_config,
)
from .prime_rl_contracts import (
    PrimeRlBatch,
    PrimeRlExecutionError,
    PrimeRlSettings,
)
from .prime_rl_model import materialize_pinned_model
from .prime_rl_settings import resolve_prime_rl_settings
from .prime_rl_step import (
    directory_content_hash,
    execute_prime_rl_step as _execute_prime_rl_step,
    load_prime_rl_progress,
)


def execute_prime_rl_step(
    *,
    plan: dict[str, Any],
    settings: PrimeRlSettings,
    batch: PrimeRlBatch,
    engine_root: Path,
    output_directory: Path,
    model_path: Path,
    timeout_seconds: int,
    run_process: Callable[..., subprocess.CompletedProcess[Any]] = subprocess.run,
    cancelled: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    return _execute_prime_rl_step(
        plan=plan,
        settings=settings,
        batch=batch,
        engine_root=engine_root,
        output_directory=output_directory,
        model_path=model_path,
        timeout_seconds=timeout_seconds,
        write_batch=write_prime_rl_batch,
        run_cancellable=run_cancellable_command,
        run_process=run_process,
        cancelled=cancelled,
    )


def run_cancellable_command(
    command: list[str],
    *,
    cwd: Path,
    timeout_seconds: int,
    cancelled: Callable[[], bool],
) -> int:
    process = subprocess.Popen(
        command,
        cwd=cwd,
        start_new_session=True,
    )
    deadline = time.monotonic() + timeout_seconds
    while True:
        code = process.poll()
        if code is not None:
            return code
        if cancelled():
            _terminate_process_group(process)
            return 130
        if time.monotonic() >= deadline:
            _terminate_process_group(process)
            raise PrimeRlExecutionError("prime_rl_trainer_step_timeout")
        time.sleep(0.25)


def _terminate_process_group(process: subprocess.Popen[Any]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=15)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=5)
