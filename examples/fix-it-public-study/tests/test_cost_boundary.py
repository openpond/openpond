"""A dropped output cap or hidden provider retry can exceed approved spending.

Exercise the real pinned LiteLLM/OpenAI serialization and HTTP error path, then
reopen the actual SQLite ledger. No provider or model is contacted.
"""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from tau2.utils import llm_utils

from fixit_study.budget import BudgetStop, CallBudget, meter_tau2


class SpendingBoundary(unittest.TestCase):
    def test_request_cap_no_hidden_retry_and_durable_uncertainty(self):
        requests = []
        fail = False

        def provider(request):
            requests.append(json.loads(request.content))
            self.assertEqual(request.url.path, "/v1/responses")
            self.assertEqual(requests[-1]["max_output_tokens"], 4096)
            if fail:
                return httpx.Response(503, json={"error": {"message": "qualification transport failure", "type": "server_error"}})
            return httpx.Response(200, json={
                "id": "resp_qualification", "object": "response", "created_at": 1,
                "status": "completed", "model": "gpt-5.5-2026-04-23",
                "output": [{"id": "msg_qualification", "type": "message", "status": "completed", "role": "assistant",
                            "content": [{"type": "output_text", "text": "READY", "annotations": []}]}],
                "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15,
                          "input_tokens_details": {"cached_tokens": 0}, "output_tokens_details": {"reasoning_tokens": 0}}})

        def send(_client, request, *args, **kwargs):
            response = provider(request)
            response.request = request
            return response

        arguments = {"model": "openai/gpt-5.5", "messages": [{"role": "user", "content": "qualification"}],
                     "api_key": "qualification-not-a-real-key"}
        with tempfile.TemporaryDirectory() as directory, patch.object(httpx.Client, "send", send):
            path = Path(directory) / "costs.sqlite3"
            budget = CallBudget(path, "20")
            try:
                with meter_tau2(budget, 4096):
                    try:
                        llm_utils.completion(**arguments)
                    except BudgetStop:
                        self.fail(f"Serialization failed before the successful fixture: {[{'keys': sorted(r), 'outputCap': r.get('max_output_tokens')} for r in requests]}")
                    self.assertEqual(budget.summary()["actualUsd"], "0.0002")
                    fail = True
                    with self.assertRaises(BudgetStop):
                        llm_utils.completion(**arguments)
                    self.assertEqual(len(requests), 2, "Provider retries must not create unreserved paid calls")
                    with self.assertRaises(BudgetStop):
                        llm_utils.completion(**arguments)
                    self.assertEqual(len(requests), 2)
            finally:
                budget.close()
            reopened = CallBudget(path, "20")
            try:
                self.assertEqual(reopened.summary()["calls"][-1]["state"], "unknown")
                with meter_tau2(reopened, 4096):
                    with self.assertRaises(BudgetStop):
                        llm_utils.completion(**arguments)
                self.assertEqual(len(requests), 2)
            finally:
                reopened.close()
            small = CallBudget(Path(directory) / "small.sqlite3", "0.01")
            try:
                with meter_tau2(small, 4096):
                    with self.assertRaises(BudgetStop):
                        llm_utils.completion(**arguments)
                self.assertEqual(len(requests), 2)
            finally:
                small.close()


if __name__ == "__main__":
    unittest.main()
