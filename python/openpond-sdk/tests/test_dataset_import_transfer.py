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


def json_response(handler, data):
    body = json.dumps(data).encode()
    handler.send_response(200)
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
            elif url.path.endswith("/preview"):
                query = parse_qs(url.query)
                assert query["fileId"] == ["file-1"]
                assert query["revision"] == ["1"]
                assert query["after"] == ["1"]
                json_response(handler, {
                    "importId": "import-1", "fileId": "file-1", "relativePath": source.name,
                    "sizeBytes": 9, "uploadState": "verified", "revision": 1,
                    "state": "ready", "format": "jsonl", "scannedBytes": 9,
                    "acceptedRows": 2, "rejectedRows": 1, "totalRows": 3,
                    "provisional": False, "previewedRows": 2, "failureCode": None,
                    "rows": [{"id": "a" * 64, "ordinal": 3, "values": {"input": {"text": "kept"}}}],
                    "nextCursor": None,
                })
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
                    preview = await client.dataset_imports.preview(*preview_args, revision=1, after="1")
                    return submitted, preview

            if asynchronous:
                queued, page = asyncio.run(run_async())
            else:
                with Client(**configured) as client:
                    with pytest.raises(PonderError) as failure:
                        client.dataset_imports.upload_file(*args, operation_id="finish")
                    assert failure.value.outcome_unknown
                    queued = client.dataset_imports.upload_file(*args, operation_id="finish")
                    page = client.dataset_imports.preview(*preview_args, revision=1, after="1")

    assert queued["state"] == "queued"
    assert page["totalRows"] == 3
    assert page["rows"][0]["values"] == {"input": {"text": "kept"}}
    assert sent == [2, 3]
    assert completions == [{"operationId": "finish", "sha256": sha256(source.read_bytes()).hexdigest(),
                            "parts": [{"partNumber": n, "etag": tag} for n, tag in uploaded.items()]}]
