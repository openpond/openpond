"""python3 submit.py SOURCE_ID example.json (Python standard library only)."""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    if len(sys.argv) != 3:
        raise ValueError("Usage: submit.py SOURCE_ID example.json")
    source_id, filename = sys.argv[1:]
    endpoint = os.environ["OPENPOND_API_URL"].rstrip("/")
    parsed = urllib.parse.urlparse(endpoint)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Use an HTTP(S) API URL without credentials, query or fragment.")
    scope = os.environ["OPENPOND_LEARNING_SCOPE"]
    token = os.environ["OPENPOND_API_KEY"]
    opener = urllib.request.build_opener(NoRedirect())

    def post(route, payload):
        body = json.dumps(payload, allow_nan=False).encode("utf-8")
        if len(body) > 16_777_216:
            raise ValueError("Request exceeds 16 MiB.")
        request = urllib.request.Request(endpoint + "/v1/learning/" + route, data=body, headers={"Authorization": "Bearer " + token, "Content-Type": "application/json", "Accept": "application/json", "X-OpenPond-Team-Id": scope}, method="POST")
        try:
            with opener.open(request, timeout=60) as response:
                result = response.read(16_777_217)
                if len(result) > 16_777_216:
                    raise ValueError("Response exceeds 16 MiB.")
                return json.loads(result)
        except urllib.error.HTTPError as error:
            # Do not print request headers or echoed evidence from error bodies.
            raise RuntimeError("Learning API rejected the request (HTTP %s)." % error.code) from None

    source = post("read", {"action": "get", "scope": scope, "kind": "source", "id": source_id})
    with open(filename, encoding="utf-8") as handle:
        example = json.load(handle)
    example.update(schemaVersion="openpond.taskExample.v1", sourceId=source_id, taskDefinition=source["taskDefinition"])
    operation_id = example["idempotencyKey"]
    result = post("commands", {"scope": scope, "command": {"action": "submit_example", "operationId": operation_id, "example": example}})
    if result["operationId"] != operation_id:
        raise RuntimeError("Operation identity mismatch.")
    evidence = result["resources"][0]
    if evidence["schemaVersion"] != "openpond.taskEvidence.v1":
        raise RuntimeError("Unexpected resource type.")
    print(json.dumps({"operationId": operation_id, "evidenceId": evidence["id"], "revision": evidence["revision"], "contentHash": evidence["contentHash"]}))


if __name__ == "__main__":
    main()
