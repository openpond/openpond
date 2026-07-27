"""Public connected-worker API and command-line entrypoint."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path

from .connected_worker_bundles import materialize_resolved_bundle
from .connected_worker_execution import SubprocessTrainingExecutor
from .connected_worker_protocol import (
    PROTOCOL_VERSION,
    ConnectedWorkerExecutor,
    ConnectedWorkerService,
    WorkerLeaseState,
    timestamp,
)

__all__ = [
    "ConnectedWorkerExecutor",
    "ConnectedWorkerService",
    "PROTOCOL_VERSION",
    "SubprocessTrainingExecutor",
    "WorkerLeaseState",
    "materialize_resolved_bundle",
    "timestamp",
]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="OpenPond authenticated connected training worker"
    )
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument(
        "--state-dir",
        default=os.environ.get(
            "OPENPOND_CONNECTED_WORKER_STATE_DIR", "/tmp/openpond-worker"
        ),
    )
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=7443)
    parser.add_argument("--tls-certificate")
    parser.add_argument("--tls-private-key")
    parser.add_argument("--client-ca")
    parser.add_argument("--allow-insecure-loopback", action="store_true")
    args = parser.parse_args()
    required = {
        "worker_id": os.environ.get("OPENPOND_WORKER_ID", ""),
        "worker_release": os.environ.get("OPENPOND_WORKER_RELEASE", ""),
        "image_digest": os.environ.get("OPENPOND_WORKER_IMAGE_DIGEST", ""),
        "capability": os.environ.get(
            "OPENPOND_WORKER_CAPABILITY_RECEIPT", ""
        ),
        "lease_ref": _authentication_lease_ref(),
        "identity_key": _identity_key(),
        "engine_adapter_id": os.environ.get(
            "OPENPOND_WORKER_ENGINE_ADAPTER_ID",
            "connected-prime-rl",
        ),
    }
    if args.self_test:
        if not all(required.values()):
            raise SystemExit("connected_worker_configuration_incomplete")
        print(
            json.dumps(
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "workerId": required["worker_id"],
                    "workerRelease": required["worker_release"],
                    "workerImageDigest": required["image_digest"],
                    "engineAdapterId": required["engine_adapter_id"],
                    "ready": True,
                },
                sort_keys=True,
            )
        )
        return
    if not all(required.values()):
        raise SystemExit("connected_worker_configuration_incomplete")
    identity_key = required["identity_key"].encode()
    service = ConnectedWorkerService(
        worker_id=required["worker_id"],
        worker_release=required["worker_release"],
        worker_image_digest=required["image_digest"],
        capability_receipt=required["capability"],
        executor=SubprocessTrainingExecutor(Path(args.state_dir).resolve()),
        verify_secret_lease=lambda value: hmac.compare_digest(
            value, required["lease_ref"]
        ),
        sign_nonce=lambda value: hmac.new(
            identity_key, value.encode(), hashlib.sha256
        ).hexdigest(),
        engine_adapter_id=required["engine_adapter_id"],
    )
    from .connected_worker_http import serve_connected_worker

    serve_connected_worker(
        service=service,
        authentication_lease_ref=required["lease_ref"],
        host=args.host,
        port=args.port,
        tls_certificate=args.tls_certificate,
        tls_private_key=args.tls_private_key,
        client_ca=args.client_ca,
        allow_insecure_loopback=args.allow_insecure_loopback,
    )


def _identity_key() -> str:
    path = os.environ.get("OPENPOND_WORKER_IDENTITY_KEY_FILE", "").strip()
    if path:
        value = Path(path).read_text(encoding="utf-8").strip()
        if value:
            return value
    return ""


def _authentication_lease_ref() -> str:
    path = os.environ.get(
        "OPENPOND_WORKER_AUTHENTICATION_LEASE_FILE", ""
    ).strip()
    if path:
        value = Path(path).read_text(encoding="utf-8").strip()
        if value:
            return value
    return ""


if __name__ == "__main__":
    main()
