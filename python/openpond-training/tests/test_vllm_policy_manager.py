from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from openpond_training.vllm_policy_manager import (
    VllmPolicyManager,
    VllmPolicyManagerError,
    _request_json,
    _request_ok,
)


class VllmPolicyManagerTest(unittest.TestCase):
    def test_loads_canonical_adapter_and_verifies_served_alias(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            adapter, config_hash, weights_hash = adapter_fixture(Path(temporary))
            calls: list[tuple[str, str, dict | None]] = []

            def request(
                method: str,
                url: str,
                payload: dict | None,
                _timeout: float,
            ) -> dict:
                calls.append((method, url, payload))
                if url.endswith("/v1/models"):
                    return {"data": [{"id": "openpond-policy-v1"}]}
                if url.endswith("/v1/chat/completions"):
                    return {
                        "id": "chatcmpl-reload",
                        "model": "openpond-policy-v1",
                        "choices": [{"message": {"content": "ok"}}],
                    }
                return {"status": "ok"}

            def request_ok(
                method: str,
                url: str,
                payload: dict | None,
                _timeout: float,
            ) -> None:
                calls.append((method, url, payload))

            manager = VllmPolicyManager(
                base_url="http://127.0.0.1:8000",
                base_model="Qwen/Qwen3-0.6B",
                request_json=request,
                request_ok=request_ok,
            )
            receipt = manager.reload(
                policy_version=1,
                adapter_path=adapter,
                config_sha256=config_hash,
                weights_sha256=weights_hash,
                timeout_seconds=5,
            )

            self.assertEqual(receipt["servedPolicyVersion"], 1)
            self.assertEqual(receipt["servedAlias"], "openpond-policy-v1")
            self.assertTrue(receipt["verified"])
            self.assertEqual(calls[0][2]["lora_path"], str(adapter.resolve()))
            self.assertTrue(calls[-1][2]["return_token_ids"])

    def test_rejects_adapter_hash_mismatch_before_vllm_request(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            adapter, config_hash, _weights_hash = adapter_fixture(Path(temporary))
            calls: list[str] = []
            manager = VllmPolicyManager(
                base_url="http://127.0.0.1:8000",
                base_model="Qwen/Qwen3-0.6B",
                request_json=lambda _method, url, _payload, _timeout: (
                    calls.append(url) or {}
                ),
                request_ok=lambda _method, url, _payload, _timeout: calls.append(url),
            )
            with self.assertRaisesRegex(
                VllmPolicyManagerError,
                "adapter_identity_mismatch",
            ):
                manager.reload(
                    policy_version=1,
                    adapter_path=adapter,
                    config_sha256=config_hash,
                    weights_sha256="0" * 64,
                    timeout_seconds=5,
                )
            self.assertEqual(calls, [])

    def test_rejects_missing_alias_after_load(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            adapter, config_hash, weights_hash = adapter_fixture(Path(temporary))
            manager = VllmPolicyManager(
                base_url="http://127.0.0.1:8000",
                base_model="Qwen/Qwen3-0.6B",
                request_json=lambda _method, url, _payload, _timeout: (
                    {"data": []} if url.endswith("/v1/models") else {"status": "ok"}
                ),
                request_ok=lambda _method, _url, _payload, _timeout: None,
            )
            with self.assertRaisesRegex(
                VllmPolicyManagerError,
                "reloaded_alias_missing",
            ):
                manager.reload(
                    policy_version=1,
                    adapter_path=adapter,
                    config_sha256=config_hash,
                    weights_sha256=weights_hash,
                    timeout_seconds=5,
                )

    def test_accepts_plain_text_adapter_mutation_response(self) -> None:
        response = MagicMock()
        response.status = 200
        response.read.return_value = (
            b"Success: LoRA adapter 'openpond-policy-v1' added successfully."
        )
        response.__enter__.return_value = response
        response.__exit__.return_value = False
        with patch(
            "openpond_training.vllm_policy_manager.urllib.request.urlopen",
            return_value=response,
        ):
            result = _request_ok(
                "POST",
                "http://127.0.0.1:8000/v1/load_lora_adapter",
                {
                    "lora_name": "openpond-policy-v1",
                    "lora_path": "/tmp/adapter",
                },
                5,
            )
        self.assertIsNone(result)

    def test_json_probe_rejects_plain_text_response(self) -> None:
        response = MagicMock()
        response.status = 200
        response.read.return_value = b"not-json"
        response.__enter__.return_value = response
        response.__exit__.return_value = False
        with (
            patch(
                "openpond_training.vllm_policy_manager.urllib.request.urlopen",
                return_value=response,
            ),
            self.assertRaisesRegex(
                VllmPolicyManagerError,
                "invalid_json",
            ),
        ):
            _request_json(
                "GET",
                "http://127.0.0.1:8000/v1/models",
                None,
                5,
            )


def adapter_fixture(root: Path) -> tuple[Path, str, str]:
    adapter = root / "adapter"
    adapter.mkdir()
    config = adapter / "adapter_config.json"
    weights = adapter / "adapter_model.safetensors"
    config.write_text(
        json.dumps({"r": 8, "target_modules": ["q_proj"]}),
        encoding="utf-8",
    )
    weights.write_bytes(b"canonical-safetensors")
    return (
        adapter,
        hashlib.sha256(config.read_bytes()).hexdigest(),
        hashlib.sha256(weights.read_bytes()).hexdigest(),
    )


if __name__ == "__main__":
    unittest.main()
