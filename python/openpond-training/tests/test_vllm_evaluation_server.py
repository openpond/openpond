from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from openpond_training.vllm_evaluation_server import (
    claim_runner,
    release_runner,
    verify_adapter_alias,
)


class VllmEvaluationServerTest(unittest.TestCase):
    def test_accepts_the_policy_reload_receipt_alias(self) -> None:
        verify_adapter_alias(
            {
                "schemaVersion":
                    "openpond.policyReloadVerification.v1",
                "servedAlias": "openpond-policy-v1",
            },
            "openpond-policy-v1",
        )

    def test_rejects_a_missing_or_misaligned_alias(self) -> None:
        with self.assertRaisesRegex(
            RuntimeError,
            "vllm_evaluation_adapter_alias_mismatch",
        ):
            verify_adapter_alias(
                {"servedModelId": "openpond-policy-v1"},
                "openpond-policy-v1",
            )

    def test_pid_lock_rejects_a_live_evaluation_server(self) -> None:
        with TemporaryDirectory() as directory:
            pid_path = claim_runner(Path(directory))
            try:
                with self.assertRaisesRegex(
                    RuntimeError,
                    "vllm_evaluation_runner_already_active",
                ):
                    claim_runner(Path(directory))
            finally:
                release_runner(pid_path)
            self.assertFalse(pid_path.exists())


if __name__ == "__main__":
    unittest.main()
