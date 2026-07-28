"""Pinned vLLM bootstrap and process lifecycle utilities."""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

VLLM_VERSION = "0.24.0"
VLLM_WHEEL_URL = (
    "https://github.com/vllm-project/vllm/releases/download/v0.24.0/"
    "vllm-0.24.0%2Bcu129-cp38-abi3-manylinux_2_28_x86_64.whl"
    "#sha256=597949743f2a00c0539d9e2ff0f67b32c608a378e973f99e7529fd6fa9445f70"
)
TORCH_WHEEL_URL = (
    "https://download-r2.pytorch.org/whl/cu128/"
    "torch-2.11.0%2Bcu128-cp312-cp312-manylinux_2_28_x86_64.whl"
    "#sha256=d252cf975fb18c94a85336323ad425f473df56dab35a44b00399bd70c7a3b997"
)
TORCHVISION_WHEEL_URL = (
    "https://download-r2.pytorch.org/whl/cu128/"
    "torchvision-0.26.0%2Bcu128-cp312-cp312-manylinux_2_28_x86_64.whl"
    "#sha256=ccf26b4b659cfce6f2208cb8326071d51c70219a34856dfdf468d1e19af52c0d"
)
TORCHAUDIO_WHEEL_URL = (
    "https://download-r2.pytorch.org/whl/cu128/"
    "torchaudio-2.11.0%2Bcu128-cp312-cp312-manylinux_2_28_x86_64.whl"
    "#sha256=78b86a17f164bdaabdcee93fdfde2587fc43b9ebf15cd61dcf730b4f8615176b"
)
TRANSFORMERS_VERSION = "5.6.2"


def timestamp() -> str:
    return (
        time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
        + f".{int(time.time_ns() / 1_000_000) % 1_000:03d}Z"
    )


def wait_for_vllm(
    port: int,
    process: subprocess.Popen[bytes],
    timeout: float,
    log_path: Path,
) -> None:
    deadline = time.monotonic() + timeout
    url = f"http://127.0.0.1:{port}/v1/models"
    last_error = "vLLM did not answer."
    while time.monotonic() < deadline:
        code = process.poll()
        if code is not None:
            tail = log_path.read_text("utf-8", errors="replace")[-4000:]
            raise RuntimeError(
                f"vLLM exited before readiness with code {code}.\n"
                f"vLLM log tail:\n{tail}"
            )
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                if response.status == 200:
                    return
                last_error = f"vLLM readiness returned {response.status}."
        except (OSError, urllib.error.URLError) as error:
            last_error = str(error)
        time.sleep(2)
    raise RuntimeError(f"vLLM readiness timed out: {last_error}")


def start_vllm(launch: dict[str, Any], run_dir: Path) -> tuple[subprocess.Popen[bytes], Any]:
    model = launch["assignment"]["model"]
    port = int(launch["assignment"]["inferencePort"])
    model_source = str(
        model.get("path")
        or model.get("source")
        or model["id"]
    )
    command = [
        sys.executable,
        "-m",
        "vllm.entrypoints.openai.api_server",
        "--model",
        model_source,
    ]
    help_text = ensure_vllm_runtime(run_dir)
    command.extend(
        [
            "--served-model-name",
            str(model.get("servedId") or model["id"]),
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--max-model-len",
            "8192",
            "--gpu-memory-utilization",
            "0.5",
            "--enable-lora",
            "--max-loras",
            "1",
            "--max-cpu-loras",
            "1",
            "--enable-auto-tool-choice",
            "--tool-call-parser",
            "hermes",
        ]
    )
    if not model.get("path"):
        command.extend(["--revision", model["revision"]])
    if "--reasoning-parser" in help_text and "qwen3" in help_text.lower():
        command.extend(["--reasoning-parser", "qwen3"])
    log = (run_dir / "vllm.log").open("wb")
    env = dict(os.environ)
    env.setdefault("VLLM_ENFORCE_STRICT_TOOL_CALLING", "1")
    env.setdefault("VLLM_USE_FLASHINFER_SAMPLER", "0")
    env.setdefault("VLLM_ALLOW_RUNTIME_LORA_UPDATING", "True")
    process = subprocess.Popen(
        command,
        cwd=run_dir,
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    return process, log


def ensure_vllm_runtime(run_dir: Path) -> str:
    command = [
        sys.executable,
        "-m",
        "vllm.entrypoints.openai.api_server",
    ]
    help_result, help_text = inspect_vllm_cli(command, run_dir)
    required_flags = ("--enable-auto-tool-choice", "--tool-call-parser")
    if (
        help_result.returncode != 0
        or any(flag not in help_text for flag in required_flags)
    ):
        bootstrap_vllm(run_dir)
        help_result, help_text = inspect_vllm_cli(command, run_dir)
    (run_dir / "vllm-help.txt").write_text(help_text, encoding="utf-8")
    if help_result.returncode != 0:
        raise RuntimeError(
            "The prebuilt image could not inspect its vLLM API server CLI."
        )
    for required_flag in required_flags:
        if required_flag not in help_text:
            raise RuntimeError(
                f"vLLM {VLLM_VERSION} lacks required {required_flag} support."
            )
    return help_text


def inspect_vllm_cli(
    command: list[str],
    run_dir: Path,
) -> tuple[subprocess.CompletedProcess[str], str]:
    result = subprocess.run(
        [*command[:3], "--help"],
        cwd=run_dir,
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
    )
    return result, f"{result.stdout}\n{result.stderr}"


def bootstrap_vllm(run_dir: Path) -> None:
    command = vllm_bootstrap_command()
    with (run_dir / "vllm-bootstrap.log").open("wb") as log:
        result = subprocess.run(
            command,
            cwd=run_dir,
            check=False,
            stdout=log,
            stderr=subprocess.STDOUT,
            timeout=15 * 60,
        )
    if result.returncode != 0:
        tail = (run_dir / "vllm-bootstrap.log").read_text(
            "utf-8",
            errors="replace",
        )[-4000:]
        raise RuntimeError(
            f"Installing pinned vLLM {VLLM_VERSION} failed "
            f"with code {result.returncode}.\nBootstrap log tail:\n{tail}"
        )


def vllm_bootstrap_command() -> list[str]:
    uv = shutil.which("uv")
    if not uv:
        raise RuntimeError(
            "The managed evaluation image contract requires the uv executable "
            "for isolated, PEP 668-compatible package installation."
        )
    return [
        uv,
        "pip",
        "install",
        "--system",
        "--break-system-packages",
        "--python",
        sys.executable,
        "--no-progress",
        "--upgrade",
        f"vllm @ {VLLM_WHEEL_URL}",
        f"torch @ {TORCH_WHEEL_URL}",
        f"torchvision @ {TORCHVISION_WHEEL_URL}",
        f"torchaudio @ {TORCHAUDIO_WHEEL_URL}",
        f"transformers=={TRANSFORMERS_VERSION}",
    ]


def terminate_process(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=15)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=10)
