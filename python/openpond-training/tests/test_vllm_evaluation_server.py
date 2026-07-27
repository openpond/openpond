from __future__ import annotations

import unittest

from openpond_training.vllm_evaluation_server import (
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


if __name__ == "__main__":
    unittest.main()
