from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
import hashlib
import os
from pathlib import Path
import stat
from threading import RLock
from typing import Any, Callable, Protocol
import uuid

from .connected_worker_files import (
    content_hash as _content_hash,
    path_from_file_ref as _path_from_file_ref,
)


PROTOCOL_VERSION = "openpond.connectedWorker.v1"


def timestamp() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


class ConnectedWorkerExecutor(Protocol):
    def begin_bundle_upload(
        self, *, manifest: dict[str, Any]
    ) -> dict[str, Any]: ...

    def upload_bundle_chunk(
        self,
        *,
        upload_id: str,
        asset_path: str,
        offset: int,
        content: bytes,
        chunk_hash: str,
        final: bool,
    ) -> dict[str, Any]: ...

    def complete_bundle_upload(
        self, *, upload_id: str
    ) -> dict[str, Any]: ...

    def launch(
        self,
        *,
        run_id: str,
        plan: dict[str, Any],
        resolved_bundle: dict[str, Any],
    ) -> dict[str, Any]: ...

    def consume_signals(
        self, *, run_id: str, batch: dict[str, Any]
    ) -> None: ...

    def status(self, *, run_id: str) -> dict[str, Any]: ...

    def logs(
        self, *, run_id: str, cursor: str | None
    ) -> dict[str, Any]: ...

    def cancel(self, *, run_id: str) -> None: ...

    def artifacts(self, *, run_id: str) -> dict[str, Any]: ...


@dataclass
class WorkerLeaseState:
    id: str
    run_id: str
    acquired_at: datetime
    expires_at: datetime
    capability_receipt: str
    released: bool = False


@dataclass
class ConnectedWorkerService:
    worker_id: str
    worker_release: str
    worker_image_digest: str
    capability_receipt: str
    executor: ConnectedWorkerExecutor
    verify_secret_lease: Callable[[str], bool]
    sign_nonce: Callable[[str], str]
    now: Callable[[], datetime] = lambda: datetime.now(UTC)
    leases: dict[str, WorkerLeaseState] = field(default_factory=dict)
    run_leases: dict[str, str] = field(default_factory=dict)
    run_events: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    engine_adapter_id: str = "connected-prime-rl"
    state_lock: RLock = field(default_factory=RLock)

    def handshake(
        self, request: dict[str, Any], secret_lease_ref: str
    ) -> dict[str, Any]:
        if request.get("protocolVersion") != PROTOCOL_VERSION:
            raise ValueError("connected_worker_protocol_mismatch")
        if (
            request.get("expectedWorkerImageDigest")
            != self.worker_image_digest
        ):
            raise ValueError("connected_worker_image_mismatch")
        if not self.verify_secret_lease(secret_lease_ref):
            raise PermissionError("connected_worker_secret_lease_invalid")
        nonce = str(request.get("nonce") or "")
        if len(nonce) < 16:
            raise ValueError("connected_worker_nonce_invalid")
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "workerId": self.worker_id,
            "workerRelease": self.worker_release,
            "workerImageDigest": self.worker_image_digest,
            "nonceSignature": self.sign_nonce(nonce),
            "capabilityReceipt": self.capability_receipt,
            "serverTime": self._now().isoformat(),
        }

    def acquire_lease(
        self, *, run_id: str, duration_seconds: int
    ) -> dict[str, Any]:
        if not 1 <= duration_seconds <= 86_400:
            raise ValueError("connected_worker_lease_duration_invalid")
        with self.state_lock:
            existing_id = self.run_leases.get(run_id)
            if existing_id:
                existing = self.leases[existing_id]
                if not existing.released and existing.expires_at > self._now():
                    return self._lease(existing)
            acquired_at = self._now()
            lease = WorkerLeaseState(
                id=f"worker_lease_{uuid.uuid4().hex}",
                run_id=run_id,
                acquired_at=acquired_at,
                expires_at=acquired_at + timedelta(seconds=duration_seconds),
                capability_receipt=self.capability_receipt,
            )
            self.leases[lease.id] = lease
            self.run_leases[run_id] = lease.id
            resolved = self._lease(lease)
            self._emit(
                run_id,
                "lease",
                {
                    "leaseId": lease.id,
                    "expiresAt": resolved["expiresAt"],
                    "capabilityReceipt": lease.capability_receipt,
                },
            )
            return resolved

    def heartbeat(self, lease_id: str) -> dict[str, Any]:
        with self.state_lock:
            lease = self._require_lease(lease_id)
            remaining = max(
                1,
                int((lease.expires_at - lease.acquired_at).total_seconds()),
            )
            lease.expires_at = self._now() + timedelta(seconds=remaining)
            resolved = self._lease(lease)
            self._emit(
                lease.run_id,
                "lease",
                {
                    "leaseId": lease.id,
                    "heartbeat": True,
                    "expiresAt": resolved["expiresAt"],
                },
            )
            return resolved

    def begin_bundle_upload(
        self, *, lease_id: str, manifest: dict[str, Any]
    ) -> dict[str, Any]:
        self._require_lease(lease_id)
        return self.executor.begin_bundle_upload(manifest=manifest)

    def upload_bundle_chunk(
        self,
        *,
        lease_id: str,
        upload_id: str,
        asset_path: str,
        offset: int,
        content: bytes,
        chunk_hash: str,
        final: bool,
    ) -> dict[str, Any]:
        self._require_lease(lease_id)
        return self.executor.upload_bundle_chunk(
            upload_id=upload_id,
            asset_path=asset_path,
            offset=offset,
            content=content,
            chunk_hash=chunk_hash,
            final=final,
        )

    def complete_bundle_upload(
        self, *, lease_id: str, upload_id: str
    ) -> dict[str, Any]:
        self._require_lease(lease_id)
        return self.executor.complete_bundle_upload(upload_id=upload_id)

    def launch(
        self,
        *,
        lease_id: str,
        plan: dict[str, Any],
        resolved_bundle: dict[str, Any],
    ) -> dict[str, Any]:
        lease = self._require_lease(lease_id)
        manifest = plan.get("manifest")
        if not isinstance(manifest, dict) or manifest.get("id") != lease.run_id:
            raise ValueError("connected_worker_run_lease_mismatch")
        engine = plan.get("engine")
        if (
            not isinstance(engine, dict)
            or engine.get("adapterId") != self.engine_adapter_id
        ):
            raise ValueError("connected_worker_engine_adapter_mismatch")
        self._emit(
            lease.run_id,
            "preparation",
            {
                "leaseId": lease.id,
                "manifestHash": manifest.get("contentHash"),
                "bundleHash": resolved_bundle.get("sha256"),
            },
        )
        result = self.executor.launch(
            run_id=lease.run_id,
            plan=plan,
            resolved_bundle=resolved_bundle,
        )
        self._emit(
            lease.run_id,
            "progress",
            {
                "phase": "launched",
                "providerJobId": result.get("providerJobId"),
            },
        )
        return {
            "runId": lease.run_id,
            "adapterId": str(plan.get("engine", {}).get("adapterId", "")),
            "providerJobId": result.get("providerJobId"),
            "leaseId": lease.id,
            "createdAt": self._now().isoformat(),
        }

    def consume_signals(
        self, *, run_id: str, batch: dict[str, Any]
    ) -> None:
        self._require_run(run_id)
        self.executor.consume_signals(run_id=run_id, batch=batch)
        self._emit(
            run_id,
            "progress",
            {
                "phase": "signals_consumed",
                "batchSequence": batch.get("sequence"),
                "batchHash": batch.get("contentHash"),
            },
        )

    def status(self, *, run_id: str) -> dict[str, Any]:
        self._require_run(run_id)
        status = self.executor.status(run_id=run_id)
        state = status.get("state")
        event_type = (
            "complete"
            if state == "succeeded"
            else "failure"
            if state == "failed"
            else None
        )
        if event_type and not any(
            event["type"] == event_type
            for event in self.run_events.get(run_id, [])
        ):
            self._emit(
                run_id,
                event_type,
                {
                    "state": state,
                    "phase": status.get("phase"),
                    "errorCode": status.get("errorCode"),
                },
            )
        return status

    def logs(
        self, *, run_id: str, cursor: str | None = None
    ) -> dict[str, Any]:
        self._require_run(run_id)
        return self.executor.logs(run_id=run_id, cursor=cursor)

    def cancel(self, *, run_id: str) -> None:
        self._require_run(run_id)
        self.executor.cancel(run_id=run_id)
        self._emit(run_id, "cancellation", {"requested": True})

    def artifacts(self, *, run_id: str) -> dict[str, Any]:
        self._require_run(run_id)
        return self.executor.artifacts(run_id=run_id)

    def events(
        self, *, run_id: str, after_sequence: int
    ) -> list[dict[str, Any]]:
        self._require_run(run_id)
        with self.state_lock:
            return [
                event
                for event in self.run_events.get(run_id, [])
                if event["sequence"] > after_sequence
            ]

    def read_artifact_chunk(
        self,
        *,
        run_id: str,
        object_ref: str,
        offset: int,
        maximum_bytes: int = 1024 * 1024,
    ) -> dict[str, Any]:
        self._require_run(run_id)
        if not object_ref.startswith("file://"):
            raise ValueError("connected_worker_artifact_ref_unsupported")
        inventory = self.executor.artifacts(run_id=run_id)
        allowed = {
            str(item.get("objectRef"))
            for item in inventory.get("artifacts", [])
            if isinstance(item, dict)
        }
        if object_ref not in allowed:
            raise ValueError("connected_worker_artifact_ref_unauthorized")
        path = _path_from_file_ref(object_ref)
        if not path.is_absolute() or offset < 0:
            raise ValueError("connected_worker_artifact_unavailable")
        try:
            descriptor = os.open(
                path,
                os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
            )
        except OSError as error:
            raise ValueError(
                "connected_worker_artifact_unavailable"
            ) from error
        with os.fdopen(descriptor, "rb") as handle:
            file_status = os.fstat(handle.fileno())
            if not stat.S_ISREG(file_status.st_mode):
                raise ValueError(
                    "connected_worker_artifact_unavailable"
                )
            handle.seek(offset)
            content = handle.read(maximum_bytes)
            next_offset = handle.tell()
            complete = next_offset == file_status.st_size
        return {
            "runId": run_id,
            "objectRef": object_ref,
            "offset": offset,
            "content": content,
            "chunkHash": hashlib.sha256(content).hexdigest(),
            "nextOffset": next_offset,
            "complete": complete,
        }

    def release_lease(self, lease_id: str) -> None:
        with self.state_lock:
            lease = self._require_lease(lease_id)
            lease.released = True

    def _emit(
        self, run_id: str, event_type: str, payload: dict[str, Any]
    ) -> None:
        with self.state_lock:
            events = self.run_events.setdefault(run_id, [])
            events.append(
                {
                    "sequence": len(events),
                    "runId": run_id,
                    "type": event_type,
                    "timestamp": self._now().isoformat(),
                    "payload": payload,
                    "payloadHash": _content_hash(payload),
                }
            )

    def _require_run(self, run_id: str) -> WorkerLeaseState:
        lease_id = self.run_leases.get(run_id)
        if not lease_id:
            raise ValueError("connected_worker_run_not_leased")
        return self._require_lease(lease_id)

    def _require_lease(self, lease_id: str) -> WorkerLeaseState:
        lease = self.leases.get(lease_id)
        if (
            not lease
            or lease.released
            or lease.expires_at <= self._now()
        ):
            raise ValueError("connected_worker_lease_inactive")
        return lease

    def _now(self) -> datetime:
        value = self.now()
        if value.tzinfo is None:
            raise ValueError("connected_worker_clock_must_be_timezone_aware")
        return value.astimezone(UTC)

    @staticmethod
    def _lease_with_worker(
        lease: WorkerLeaseState, worker_id: str
    ) -> dict[str, Any]:
        return {
            "schemaVersion": "openpond.workerLease.v1",
            "id": lease.id,
            "workerId": worker_id,
            "acquiredAt": lease.acquired_at.isoformat(),
            "expiresAt": lease.expires_at.isoformat(),
            "heartbeatAfterSeconds": max(
                1,
                min(
                    3600,
                    int(
                        (
                            lease.expires_at - lease.acquired_at
                        ).total_seconds()
                        / 3
                    ),
                ),
            ),
            "capabilityReceipt": lease.capability_receipt,
        }

    def _lease(self, lease: WorkerLeaseState) -> dict[str, Any]:
        return self._lease_with_worker(lease, self.worker_id)
