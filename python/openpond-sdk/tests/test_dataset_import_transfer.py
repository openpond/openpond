"""Exercise native IPv4 HTTP API and storage boundaries for both clients."""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from threading import Thread
from urllib.parse import parse_qs, urlsplit

import pytest

from ponder_sdk import AsyncClient, Client
from ponder_sdk.errors import PonderError


@contextmanager
def local_server(handle):
    errors = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def dispatch(self):
            try:
                handle(self)
            except Exception as error:
                errors.append(error)
                self.send_error(500)

        do_GET = do_POST = do_PUT = dispatch

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    runner = Thread(target=server.serve_forever, daemon=True)
    runner.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        runner.join()
        assert not errors


def json_response(handler, data, status=200):
    body = json.dumps(data).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def request_body(handler):
    return handler.rfile.read(int(handler.headers["Content-Length"]))


@pytest.mark.parametrize("asynchronous", [False, True])
def test_native_resume_and_preview(tmp_path, asynchronous):
    source = tmp_path / "examples.jsonl"
    source.write_bytes(b"aaabbbccc")
    file = {"fileId": "file-1", "relativePath": source.name, "sizeBytes": 9,
            "partSize": 3, "state": "uploading", "object": None, "failureCode": None}
    uploaded = {1: '"one"'}
    sent = []
    completions = []
    groups = [{"kind": "sources", "fileIds": ["file-1"]}]
    staged = {"importId": "import-1", "materializationId": "prepare-1",
              "mappingRevision": 1, "mappingHash": "b" * 64, "state": "queued",
              "acceptedRows": 0, "rejectedRows": 0, "shardCount": 0,
              "splitCounts": None, "indexHash": None, "failureCode": None}
    finish = dict(operation_id="save-sample", name="Verified sample", materialization_id="prepare-1",
                  mapping_revision=1, mapping_hash="b" * 64, index_hash="c" * 64)
    pinned_version = {"teamId": "workspace-fixture", "datasetId": "draft-1", "revision": 1,
                      "workspaceHash": "d" * 64, "packageHash": "f" * 64, "indexHash": "c" * 64,
                      "release": {"id": "draft-1", "revision": 2, "contentHash": "f" * 64}}
    version_request = dict(operation_id="create-version", expected_revision=1, workspace_hash="d" * 64,
                           index_hash="c" * 64, package_hash="f" * 64)

    def put(handler):
        assert not handler.headers.get("Authorization")
        assert not handler.headers.get("X-OpenPond-Team-Id")
        assert not handler.headers.get("Cookie")
        number = int(handler.path.rsplit("/", 1)[1])
        assert handler.command == "PUT"
        assert handler.headers.get("Transfer-Encoding") is None
        assert handler.headers.get("Content-Length") == "3"
        assert request_body(handler) == (b"bbb" if number == 2 else b"ccc")
        sent.append(number)
        uploaded[number] = f'"part-{number}"'
        # The final part reached storage even though the acknowledgement failed.
        handler.send_response(503 if number == 3 else 200)
        handler.send_header("ETag", uploaded[number])
        handler.send_header("Set-Cookie", "fixture_cookie=do-not-send")
        handler.end_headers()

    with local_server(put) as storage_url:
        def api(handler):
            assert handler.headers["Authorization"] == "Bearer fixture"
            assert handler.headers["X-OpenPond-Team-Id"] == "workspace-fixture"
            url = urlsplit(handler.path)
            if url.path.endswith("/parts"):
                [number] = json.loads(request_body(handler))["partNumbers"]
                json_response(handler, {"fileId": "file-1", "parts": [{
                    "partNumber": number, "sizeBytes": 3, "url": f"{storage_url}/part/{number}",
                    "headers": {"content-length": "3"},
                }]})
            elif url.path.endswith("/complete"):
                completions.append(json.loads(request_body(handler)))
                json_response(handler, {**file, "state": "queued"})
            elif url.path.endswith("/mapping"):
                if handler.command == "PUT":
                    assert json.loads(request_body(handler)) == {
                        "operationId": "sample-mapping", "expectedRevision": 0, "groups": groups,
                    }
                else:
                    assert handler.command == "GET"
                json_response(handler, {"importId": "import-1", "revision": 1, "mappingHash": "b" * 64, "groups": groups})
            elif url.path.endswith("/preview"):
                query = parse_qs(url.query)
                assert query["fileId"] == ["file-1"]
                assert query["revision"] == ["1"]
                assert query["after"] == ["1"]
                assert query["mappingRevision"] == ["1"]
                json_response(handler, {
                    "importId": "import-1", "fileId": "file-1", "relativePath": source.name,
                    "sizeBytes": 9, "uploadState": "verified", "revision": 1,
                    "state": "ready", "format": "jsonl", "scannedBytes": 9,
                    "acceptedRows": 2, "rejectedRows": 1, "totalRows": 3,
                    "provisional": False, "previewedRows": 2, "failureCode": None,
                    "mappingRevision": 1, "mappingHash": "b" * 64,
                    "rows": [{"id": "a" * 64, "ordinal": 3, "values": {"input": {"text": "kept"}},
                              "projection": {"state": "source"}}],
                    "nextCursor": None,
                })
            elif url.path.endswith("/materializations"):
                assert handler.command == "POST"
                assert json.loads(request_body(handler)) == {
                    "operationId": "prepare-sample", "mappingRevision": 1,
                    "mappingHash": "b" * 64, "allowRejectedRows": False,
                }
                json_response(handler, staged)
            elif url.path.endswith("/materializations/prepare-1"):
                json_response(handler, {**staged, "state": "ready",
                    "splitCounts": {"train": 0, "validation": 0, "test": 0, "frozen_eval": 0},
                    "indexHash": "c" * 64, "shards": [], "nextCursor": None})
            elif url.path.endswith("/import-1/finish"):
                assert handler.command == "POST"
                expected = {"operationId": "save-sample", "name": "Verified sample", "ownerScope": "workspace",
                            "materializationId": "prepare-1", "mappingRevision": 1,
                            "mappingHash": "b" * 64, "indexHash": "c" * 64}
                assert json.loads(request_body(handler)) == expected
                json_response(handler, {"importId": "import-1", "datasetId": "draft-1", "revision": 1,
                    "workspaceHash": "d" * 64, "materializationId": "prepare-1", "mappingRevision": 1,
                    "mappingHash": "b" * 64, "indexHash": "c" * 64,
                    "acceptedRows": 0, "rejectedRows": 0, "shardCount": 0})
            elif url.path == "/v1/dataset-workspaces/draft-1/versions/validate":
                assert handler.command == "POST" and json.loads(request_body(handler)) == {"expectedRevision": 1}
                json_response(handler, pinned_version)
            elif url.path == "/v1/dataset-workspaces/draft-1/versions":
                assert handler.command == "POST"
                assert json.loads(request_body(handler)) == {"operationId": "create-version", "expectedRevision": 1,
                    "workspaceHash": "d" * 64, "indexHash": "c" * 64, "packageHash": "f" * 64}
                json_response(handler, {"code": "dataset_validation_changed"}, status=409)
            elif url.path == "/v1/dataset-workspaces/draft-1/versions/2/manifest":
                json_response(handler, {**pinned_version, "revision": 2, "draftRevision": 1, "acceptedRows": 1,
                    "rejectedRows": 0, "shardCount": 1, "splitCounts": {"train": 1, "validation": 0, "test": 0, "frozen_eval": 0},
                    "publishedAt": "2026-01-01T00:00:00.000Z"})
            elif url.path in ("/v1/dataset-workspaces/draft-1/rows", "/v1/dataset-workspaces/draft-1/versions/2/rows"):
                revision = 2 if "/versions/" in url.path else 1
                assert parse_qs(url.query) == {"revision": [str(revision)], "limit": ["1"], "split": ["train"]}
                json_response(handler, {"teamId": "workspace-fixture", "datasetId": "draft-1", "revision": revision,
                    "indexHash": "c" * 64, "total": 1, "nextCursor": None, "rows": [{"id": "e" * 64,
                        "split": "train", "input": {"prompt": "kept"}, "policyVisibleContext": {},
                        "source": {"fileId": "file-1", "ordinal": 1}}]})
            else:
                json_response(handler, {**file, "parts": [
                    {"partNumber": number, "sizeBytes": 3, "etag": tag}
                    for number, tag in uploaded.items()
                ], "nextCursor": None})

        with local_server(api) as api_url:
            configured = dict(base_url=api_url, api_key="fixture", team_id="workspace-fixture")
            args = ("import-1", "file-1", source)
            preview_args = ("import-1", "file-1")
            async def run_async():
                async with AsyncClient(**configured) as client:
                    with pytest.raises(PonderError) as failure:
                        await client.dataset_imports.upload_file(*args, operation_id="finish")
                    assert failure.value.outcome_unknown
                    submitted = await client.dataset_imports.upload_file(*args, operation_id="finish")
                    mapping = await client.dataset_imports.save_mapping(
                        "import-1", operation_id="sample-mapping", expected_revision=0, groups=groups,
                    )
                    assert await client.dataset_imports.mapping("import-1") == mapping
                    preview = await client.dataset_imports.preview(*preview_args, revision=1, after="1", mapping_revision=mapping["revision"])
                    job = await client.dataset_imports.materialize(
                        "import-1", operation_id="prepare-sample",
                        mapping_revision=mapping["revision"], mapping_hash=mapping["mappingHash"],
                    )
                    assert (await client.dataset_imports.materialization("import-1", job["materializationId"]))["state"] == "ready"
                    assert (await client.dataset_imports.finish("import-1", **finish))["datasetId"] == "draft-1"
                    rows = await client.datasets.rows("draft-1", revision=1, limit=1, splits=["train"])
                    assert rows["rows"][0]["input"] == {"prompt": "kept"}
                    assert await client.datasets.validate_version("draft-1", expected_revision=1) == pinned_version
                    with pytest.raises(PonderError) as failure:
                        await client.datasets.create_version("draft-1", **version_request)
                    assert failure.value.code == "dataset_validation_changed"
                    manifest = await client.datasets.version_manifest("draft-1", 2)
                    version_page = await client.datasets.version_rows("draft-1", 2, limit=1, splits=["train"])
                    assert version_page["indexHash"] == manifest["indexHash"] and version_page["revision"] == 2
                    return submitted, preview

            if asynchronous:
                queued, page = asyncio.run(run_async())
            else:
                with Client(**configured) as client:
                    with pytest.raises(PonderError) as failure:
                        client.dataset_imports.upload_file(*args, operation_id="finish")
                    assert failure.value.outcome_unknown
                    queued = client.dataset_imports.upload_file(*args, operation_id="finish")
                    mapping = client.dataset_imports.save_mapping(
                        "import-1", operation_id="sample-mapping", expected_revision=0, groups=groups,
                    )
                    assert client.dataset_imports.mapping("import-1") == mapping
                    page = client.dataset_imports.preview(*preview_args, revision=1, after="1", mapping_revision=mapping["revision"])
                    job = client.dataset_imports.materialize(
                        "import-1", operation_id="prepare-sample",
                        mapping_revision=mapping["revision"], mapping_hash=mapping["mappingHash"],
                    )
                    assert client.dataset_imports.materialization("import-1", job["materializationId"])["state"] == "ready"
                    assert client.dataset_imports.finish("import-1", **finish)["datasetId"] == "draft-1"
                    rows = client.datasets.rows("draft-1", revision=1, limit=1, splits=["train"])
                    assert rows["rows"][0]["input"] == {"prompt": "kept"}
                    assert client.datasets.validate_version("draft-1", expected_revision=1) == pinned_version
                    with pytest.raises(PonderError) as failure:
                        client.datasets.create_version("draft-1", **version_request)
                    assert failure.value.code == "dataset_validation_changed"
                    manifest = client.datasets.version_manifest("draft-1", 2)
                    version_page = client.datasets.version_rows("draft-1", 2, limit=1, splits=["train"])
                    assert version_page["indexHash"] == manifest["indexHash"] and version_page["revision"] == 2

    assert queued["state"] == "queued"
    assert page["totalRows"] == 3
    assert page["rows"][0]["values"] == {"input": {"text": "kept"}}
    assert page["rows"][0]["projection"] == {"state": "source"}
    assert sent == [2, 3]
    assert completions == [{"operationId": "finish", "sha256": sha256(source.read_bytes()).hexdigest(),
                            "parts": [{"partNumber": n, "etag": tag} for n, tag in uploaded.items()]}]
