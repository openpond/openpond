from __future__ import annotations

import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import json
import ssl
from typing import Any

from .connected_worker_protocol import ConnectedWorkerService
from .engine_adapters import (
    PRIME_RL_UPSTREAM_REVISION,
)
from .prime_rl_execution import (
    PrimeRlExecutionError,
    resolve_prime_rl_settings,
)


class ConnectedWorkerHttpServer(ThreadingHTTPServer):
    service: ConnectedWorkerService
    authentication_lease_ref: str


class ConnectedWorkerRequestHandler(BaseHTTPRequestHandler):
    server: ConnectedWorkerHttpServer

    def do_GET(self) -> None:  # noqa: N802
        try:
            self._authenticate()
            if self.path == "/v1/capabilities":
                self._send(200, self._capabilities())
                return
            self._send(404, {"error": "connected_worker_route_not_found"})
        except Exception as error:  # fail closed at the transport boundary
            self._error(error)

    def do_POST(self) -> None:  # noqa: N802
        try:
            body = self._body()
            if self.path == "/v1/handshake":
                lease_ref = self.headers.get(
                    "x-openpond-secret-lease-ref", ""
                )
                self._send(
                    200, self.server.service.handshake(body, lease_ref)
                )
                return
            self._authenticate()
            self._post(body)
        except Exception as error:  # fail closed at the transport boundary
            self._error(error)

    def _post(self, body: dict[str, Any]) -> None:
        service = self.server.service
        if self.path == "/v1/leases":
            self._send(
                200,
                service.acquire_lease(
                    run_id=str(body["runId"]),
                    duration_seconds=int(body["durationSeconds"]),
                ),
            )
            return
        if self.path.endswith("/heartbeat") and self.path.startswith(
            "/v1/leases/"
        ):
            self._send(
                200,
                service.heartbeat(
                    self.path.removeprefix("/v1/leases/").removesuffix(
                        "/heartbeat"
                    )
                ),
            )
            return
        if self.path.endswith("/release") and self.path.startswith(
            "/v1/leases/"
        ):
            service.release_lease(
                self.path.removeprefix("/v1/leases/").removesuffix(
                    "/release"
                )
            )
            self._send(200, {"released": True})
            return
        if self.path == "/v1/validate":
            self._send(200, self._validate(body))
            return
        if self.path == "/v1/bundles/begin":
            self._send(
                200,
                service.begin_bundle_upload(
                    lease_id=str(body["leaseId"]),
                    manifest=_object(body["manifest"])
                ),
            )
            return
        if self.path == "/v1/bundles/chunk":
            final = body.get("final")
            offset = body.get("offset")
            if (
                not isinstance(final, bool)
                or not isinstance(offset, int)
                or isinstance(offset, bool)
            ):
                raise ValueError(
                    "connected_worker_bundle_chunk_shape_invalid"
                )
            try:
                content = base64.b64decode(
                    str(body["bytesBase64"]), validate=True
                )
            except (ValueError, TypeError) as error:
                raise ValueError(
                    "connected_worker_bundle_chunk_encoding_invalid"
                ) from error
            self._send(
                200,
                service.upload_bundle_chunk(
                    lease_id=str(body["leaseId"]),
                    upload_id=str(body["uploadId"]),
                    asset_path=str(body["path"]),
                    offset=offset,
                    content=content,
                    chunk_hash=str(body["chunkHash"]),
                    final=final,
                ),
            )
            return
        if self.path == "/v1/bundles/complete":
            self._send(
                200,
                service.complete_bundle_upload(
                    lease_id=str(body["leaseId"]),
                    upload_id=str(body["uploadId"])
                ),
            )
            return
        if self.path == "/v1/launch":
            self._send(
                200,
                service.launch(
                    lease_id=str(body["leaseId"]),
                    plan=_object(body["plan"]),
                    resolved_bundle=_object(body["resolvedBundle"]),
                ),
            )
            return
        if self.path == "/v1/signals":
            reference = _object(body["ref"])
            service.consume_signals(
                run_id=str(reference["runId"]),
                batch=_object(body["batch"]),
            )
            self._send(200, {"accepted": True})
            return
        if self.path == "/v1/status":
            reference = _object(body["ref"])
            self._send(
                200, service.status(run_id=str(reference["runId"]))
            )
            return
        if self.path == "/v1/logs":
            reference = _object(body["ref"])
            self._send(
                200,
                service.logs(
                    run_id=str(reference["runId"]),
                    cursor=(
                        str(body["cursor"])
                        if body.get("cursor") is not None
                        else None
                    ),
                ),
            )
            return
        if self.path == "/v1/events":
            reference = _object(body["ref"])
            self._send(
                200,
                {
                    "events": service.events(
                        run_id=str(reference["runId"]),
                        after_sequence=int(body.get("afterSequence", -1)),
                    )
                },
            )
            return
        if self.path == "/v1/cancel":
            reference = _object(body["ref"])
            service.cancel(run_id=str(reference["runId"]))
            self._send(200, {"cancelled": True})
            return
        if self.path == "/v1/artifacts":
            reference = _object(body["ref"])
            self._send(
                200, service.artifacts(run_id=str(reference["runId"]))
            )
            return
        if self.path == "/v1/artifacts/chunk":
            reference = _object(body["ref"])
            chunk = service.read_artifact_chunk(
                run_id=str(reference["runId"]),
                object_ref=str(body["objectRef"]),
                offset=int(body["offset"]),
            )
            self._send(
                200,
                {
                    "runId": chunk["runId"],
                    "objectRef": chunk["objectRef"],
                    "offset": chunk["offset"],
                    "bytesBase64": base64.b64encode(
                        chunk["content"]
                    ).decode("ascii"),
                    "chunkHash": chunk["chunkHash"],
                    "final": chunk["complete"],
                },
            )
            return
        self._send(404, {"error": "connected_worker_route_not_found"})

    def _capabilities(self) -> dict[str, Any]:
        service = self.server.service
        return {
            "schemaVersion": "openpond.trainingEngineCapabilities.v1",
            "adapterId": service.engine_adapter_id,
            "available": True,
            "methods": ["grpo"],
            "signalKinds": [
                "trajectory",
                "reward",
                "grader_evidence",
                "infrastructure_failure",
            ],
            "modelFamilies": ["transformers"],
            "precisions": ["fp16", "bf16", "tf32"],
            "topologies": ["single_worker", "single_gpu_phased"],
            "workerProtocolVersion": "openpond.connectedWorker.v1",
            "upstreamRevision": (
                PRIME_RL_UPSTREAM_REVISION
                if service.engine_adapter_id == "connected-prime-rl"
                else service.worker_release
            ),
            "capabilityReceipt": service.capability_receipt,
            "checkedAt": service._now().isoformat(),
            "unavailableReason": None,
        }

    def _validate(self, body: dict[str, Any]) -> dict[str, Any]:
        plan = _object(body)
        service = self.server.service
        issues = []
        engine = _object(plan.get("engine", {}))
        if engine.get("workerImageDigest") != service.worker_image_digest:
            issues.append(
                {
                    "code": "worker_image_mismatch",
                    "path": "engine.workerImageDigest",
                    "message": "Resolved Plan does not bind this worker image.",
                }
            )
        if engine.get("adapterId") != service.engine_adapter_id:
            issues.append(
                {
                    "code": "engine_adapter_mismatch",
                    "path": "engine.adapterId",
                    "message": "Resolved Plan targets another engine adapter.",
                }
            )
        if service.engine_adapter_id == "connected-prime-rl":
            try:
                resolve_prime_rl_settings(plan)
            except PrimeRlExecutionError as error:
                issues.append(
                    {
                        "code": "prime_rl_plan_invalid",
                        "path": None,
                        "message": str(error),
                    }
                )
            if engine.get("upstreamRevision") != PRIME_RL_UPSTREAM_REVISION:
                issues.append(
                    {
                        "code": "upstream_revision_mismatch",
                        "path": "engine.upstreamRevision",
                        "message": "Resolved Plan does not pin this PRIME-RL revision.",
                    }
                )
            manifest = _object(plan.get("manifest", {}))
            recipe = _object(plan.get("recipe", {}))
            manifest_recipe = _object(manifest.get("recipe", {}))
            if (
                recipe.get("method") != "grpo"
                or manifest_recipe.get("method") != "grpo"
                or manifest_recipe.get("configHash")
                != _content_hash(recipe)
            ):
                issues.append(
                    {
                        "code": "recipe_lineage_mismatch",
                        "path": "recipe",
                        "message": "Resolved GRPO Recipe does not match the Run Manifest.",
                    }
                )
        content = {
            "schemaVersion": "openpond.adapterValidationReceipt.v1",
            "adapterId": str(
                engine.get("adapterId") or service.engine_adapter_id
            ),
            "valid": not issues,
            "issues": issues,
            "capabilityReceipt": service.capability_receipt,
            "planHash": str(plan.get("contentHash") or "0" * 64),
            "createdAt": service._now().isoformat(),
        }
        return {**content, "contentHash": _content_hash(content)}

    def _authenticate(self) -> None:
        supplied = self.headers.get("x-openpond-secret-lease-ref", "")
        if not hmac.compare_digest(
            supplied, self.server.authentication_lease_ref
        ):
            raise PermissionError("connected_worker_authentication_failed")

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0"))
        if not 0 < length <= 16 * 1024 * 1024:
            raise ValueError("connected_worker_request_size_invalid")
        return _object(json.loads(self.rfile.read(length)))

    def _send(self, status: int, value: dict[str, Any]) -> None:
        body = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, error: Exception) -> None:
        status = 403 if isinstance(error, PermissionError) else 400
        self._send(status, {"error": str(error)[:240]})

    def log_message(self, format: str, *args: object) -> None:
        del format, args


def serve_connected_worker(
    *,
    service: ConnectedWorkerService,
    authentication_lease_ref: str,
    host: str,
    port: int,
    tls_certificate: str | None,
    tls_private_key: str | None,
    client_ca: str | None,
    allow_insecure_loopback: bool = False,
) -> None:
    if (
        not tls_certificate
        or not tls_private_key
        or not client_ca
    ) and not (
        allow_insecure_loopback and host in {"127.0.0.1", "::1", "localhost"}
    ):
        raise ValueError("connected_worker_mtls_required")
    server = ConnectedWorkerHttpServer((host, port), ConnectedWorkerRequestHandler)
    server.service = service
    server.authentication_lease_ref = authentication_lease_ref
    if tls_certificate and tls_private_key and client_ca:
        context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        context.verify_mode = ssl.CERT_REQUIRED
        context.load_cert_chain(tls_certificate, tls_private_key)
        context.load_verify_locations(client_ca)
        server.socket = context.wrap_socket(server.socket, server_side=True)
    server.serve_forever()


def _object(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("connected_worker_object_required")
    return value


def _content_hash(value: Any) -> str:
    import hashlib

    canonical = json.dumps(
        value, sort_keys=True, ensure_ascii=False, indent=2
    ) + "\n"
    return hashlib.sha256(canonical.encode()).hexdigest()
