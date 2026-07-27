"""Exact vLLM LoRA reload and served-policy verification."""

from __future__ import annotations

import hashlib
import json
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .grouped_grpo_coordinator import content_hash, utc_timestamp


class VllmPolicyManagerError(RuntimeError):
    pass


RequestJson = Callable[
    [str, str, dict[str, Any] | None, float],
    dict[str, Any],
]
RequestOk = Callable[
    [str, str, dict[str, Any] | None, float],
    None,
]


class VllmPolicyManager:
    def __init__(
        self,
        *,
        base_url: str,
        base_model: str,
        request_json: RequestJson | None = None,
        request_ok: RequestOk | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.base_model = base_model
        self.request_json = request_json or _request_json
        self.request_ok = request_ok or _request_ok
        self.loaded_alias: str | None = None

    def reload(
        self,
        *,
        policy_version: int,
        adapter_path: Path,
        config_sha256: str,
        weights_sha256: str,
        timeout_seconds: float,
    ) -> dict[str, Any]:
        if policy_version <= 0:
            raise VllmPolicyManagerError("vllm_policy_version_invalid")
        adapter = adapter_path.resolve()
        config = adapter / "adapter_config.json"
        weights = adapter / "adapter_model.safetensors"
        if (
            not config.is_file()
            or not weights.is_file()
            or hashlib.sha256(config.read_bytes()).hexdigest() != config_sha256
            or hashlib.sha256(weights.read_bytes()).hexdigest() != weights_sha256
        ):
            raise VllmPolicyManagerError("vllm_adapter_identity_mismatch")
        previous = self.loaded_alias
        if previous:
            self.request_ok(
                "POST",
                f"{self.base_url}/v1/unload_lora_adapter",
                {"lora_name": previous},
                timeout_seconds,
            )
        alias = f"openpond-policy-v{policy_version}"
        self.request_ok(
            "POST",
            f"{self.base_url}/v1/load_lora_adapter",
            {
                "lora_name": alias,
                "lora_path": str(adapter),
            },
            timeout_seconds,
        )
        models = self.request_json(
            "GET",
            f"{self.base_url}/v1/models",
            None,
            timeout_seconds,
        )
        entries = models.get("data")
        model = (
            next(
                (
                    value
                    for value in entries
                    if isinstance(value, dict) and value.get("id") == alias
                ),
                None,
            )
            if isinstance(entries, list)
            else None
        )
        if not isinstance(model, dict):
            raise VllmPolicyManagerError("vllm_reloaded_alias_missing")
        response = self.request_json(
            "POST",
            f"{self.base_url}/v1/chat/completions",
            {
                "model": alias,
                "messages": [
                    {
                        "role": "user",
                        "content": "Return exactly one short acknowledgement.",
                    }
                ],
                "temperature": 0.2,
                "top_p": 0.95,
                "max_tokens": 8,
                "logprobs": True,
                "top_logprobs": 0,
                "return_token_ids": True,
            },
            timeout_seconds,
        )
        if (
            response.get("model") != alias
            or not isinstance(response.get("id"), str)
            or not response["id"]
            or not isinstance(response.get("choices"), list)
            or not response["choices"]
        ):
            raise VllmPolicyManagerError("vllm_post_reload_inference_mismatch")
        core = {
            "schemaVersion": "openpond.policyReloadVerification.v1",
            "baseModel": self.base_model,
            "servedAlias": alias,
            "servedPolicyVersion": policy_version,
            "adapterConfigSha256": config_sha256,
            "adapterWeightsSha256": weights_sha256,
            "modelResponseId": response["id"],
            "verified": True,
            "verifiedAt": utc_timestamp(),
        }
        receipt = {**core, "contentHash": content_hash(core)}
        self.loaded_alias = alias
        return receipt


def _request_json(
    method: str,
    url: str,
    payload: dict[str, Any] | None,
    timeout_seconds: float,
) -> dict[str, Any]:
    raw = _request_bytes(method, url, payload, timeout_seconds)
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise VllmPolicyManagerError("vllm_policy_response_invalid_json") from error
    if not isinstance(value, dict):
        raise VllmPolicyManagerError("vllm_policy_response_invalid")
    return value


def _request_ok(
    method: str,
    url: str,
    payload: dict[str, Any] | None,
    timeout_seconds: float,
) -> None:
    # vLLM's adapter mutation endpoints return a plain-text success body.
    # The following model-list and inference probes prove the mutation itself.
    _request_bytes(method, url, payload, timeout_seconds)


def _request_bytes(
    method: str,
    url: str,
    payload: dict[str, Any] | None,
    timeout_seconds: float,
) -> bytes:
    body = json.dumps(payload, sort_keys=True).encode() if payload is not None else None
    request = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={
            "accept": "application/json",
            "content-type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(
            request,
            timeout=timeout_seconds,
        ) as response:
            raw = response.read(4 * 1024 * 1024)
            if response.status < 200 or response.status >= 300:
                raise VllmPolicyManagerError(
                    f"vllm_policy_request_failed_{response.status}"
                )
    except urllib.error.HTTPError as error:
        raise VllmPolicyManagerError(
            f"vllm_policy_request_failed_{error.code}"
        ) from error
    return raw
