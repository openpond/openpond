from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tarfile
import tempfile
from threading import Lock, RLock
from typing import Any, Callable, Protocol
from urllib.parse import urlparse
from urllib.request import url2pathname, urlopen
import uuid

from .engine_adapters import (
    PRIME_RL_UPSTREAM_REVISION,
    validate_signal_lineage,
)
from .learning_signals import parse_signals


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
class BundleUploadState:
    id: str
    manifest: dict[str, Any]
    directory: Path
    existing: bool = False


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


@dataclass
class SubprocessTrainingExecutor:
    root: Path
    processes: dict[str, subprocess.Popen[bytes]] = field(
        default_factory=dict
    )
    launch_hashes: dict[str, str] = field(default_factory=dict)
    signal_sequences: dict[str, int] = field(default_factory=dict)
    process_lock: RLock = field(default_factory=RLock)
    signal_lock: Lock = field(default_factory=Lock)
    bundle_uploads: dict[str, BundleUploadState] = field(
        default_factory=dict
    )

    def begin_bundle_upload(
        self, *, manifest: dict[str, Any]
    ) -> dict[str, Any]:
        content_hash = _validate_resolved_bundle_manifest(manifest)
        stable = (self.root / "_staged-bundles" / content_hash).resolve()
        with self.process_lock:
            if stable.is_dir():
                if _verify_resolved_bundle_directory(stable) != content_hash:
                    raise ValueError(
                        "connected_worker_staged_bundle_corrupt"
                    )
                upload_id = f"bundle_upload_{uuid.uuid4().hex}"
                self.bundle_uploads[upload_id] = BundleUploadState(
                    id=upload_id,
                    manifest=manifest,
                    directory=stable,
                    existing=True,
                )
                return {"uploadId": upload_id, "missingPaths": []}
            upload_id = f"bundle_upload_{uuid.uuid4().hex}"
            directory = (
                self.root / "_bundle-uploads" / upload_id
            ).resolve()
            shutil.rmtree(directory, ignore_errors=True)
            directory.mkdir(parents=True, mode=0o700)
            self.bundle_uploads[upload_id] = BundleUploadState(
                id=upload_id,
                manifest=manifest,
                directory=directory,
            )
            return {
                "uploadId": upload_id,
                "missingPaths": [
                    str(file["path"]) for file in manifest["files"]
                ],
            }

    def upload_bundle_chunk(
        self,
        *,
        upload_id: str,
        asset_path: str,
        offset: int,
        content: bytes,
        chunk_hash: str,
        final: bool,
    ) -> dict[str, Any]:
        if (
            offset < 0
            or len(content) > 1024 * 1024
            or hashlib.sha256(content).hexdigest() != chunk_hash
        ):
            raise ValueError("connected_worker_bundle_chunk_invalid")
        with self.process_lock:
            upload = self.bundle_uploads.get(upload_id)
            if upload is None or upload.existing:
                raise ValueError(
                    "connected_worker_bundle_upload_unavailable"
                )
            expected = next(
                (
                    file
                    for file in upload.manifest["files"]
                    if file["path"] == asset_path
                ),
                None,
            )
            if expected is None:
                raise ValueError(
                    "connected_worker_bundle_asset_unauthorized"
                )
            target = _bundle_asset_path(upload.directory, asset_path)
            target.parent.mkdir(parents=True, exist_ok=True)
            partial = target.with_name(f"{target.name}.part")
            current_size = (
                partial.stat().st_size if partial.is_file() else 0
            )
            if current_size != offset:
                raise ValueError(
                    "connected_worker_bundle_chunk_offset_invalid"
                )
            with partial.open("ab") as file:
                file.write(content)
                file.flush()
                os.fsync(file.fileno())
            next_offset = offset + len(content)
            if next_offset > expected["sizeBytes"]:
                raise ValueError(
                    "connected_worker_bundle_asset_size_mismatch"
                )
            if final:
                if (
                    next_offset != expected["sizeBytes"]
                    or hashlib.sha256(partial.read_bytes()).hexdigest()
                    != expected["sha256"]
                ):
                    raise ValueError(
                        "connected_worker_bundle_asset_hash_mismatch"
                    )
                partial.replace(target)
            return {
                "uploadId": upload_id,
                "path": asset_path,
                "nextOffset": next_offset,
                "complete": final,
            }

    def complete_bundle_upload(
        self, *, upload_id: str
    ) -> dict[str, Any]:
        with self.process_lock:
            upload = self.bundle_uploads.get(upload_id)
            if upload is None:
                raise ValueError(
                    "connected_worker_bundle_upload_unavailable"
                )
            content_hash = str(upload.manifest["contentHash"])
            if not upload.existing:
                (upload.directory / "bundle-manifest.json").write_text(
                    json.dumps(
                        upload.manifest,
                        sort_keys=True,
                        ensure_ascii=False,
                        indent=2,
                    )
                    + "\n",
                    encoding="utf-8",
                )
                if (
                    _verify_resolved_bundle_directory(upload.directory)
                    != content_hash
                ):
                    raise ValueError(
                        "connected_worker_bundle_hash_mismatch"
                    )
                stable = (
                    self.root / "_staged-bundles" / content_hash
                ).resolve()
                stable.parent.mkdir(parents=True, exist_ok=True)
                try:
                    upload.directory.replace(stable)
                except OSError:
                    if (
                        not stable.is_dir()
                        or stable.is_symlink()
                        or
                        _verify_resolved_bundle_directory(stable)
                        != content_hash
                    ):
                        raise
                    shutil.rmtree(upload.directory, ignore_errors=True)
                upload.directory = stable
            self.bundle_uploads.pop(upload_id, None)
            return {
                "objectRef": upload.directory.as_uri(),
                "bundleContentHash": content_hash,
                "sha256": content_hash,
                "sizeBytes": sum(
                    int(file["sizeBytes"])
                    for file in upload.manifest["files"]
                ),
                "format": "directory",
            }

    def launch(
        self,
        *,
        run_id: str,
        plan: dict[str, Any],
        resolved_bundle: dict[str, Any],
    ) -> dict[str, Any]:
        engine = plan.get("engine")
        if (
            not isinstance(engine, dict)
            or engine.get("adapterId") != "connected-prime-rl"
        ):
            raise ValueError("connected_worker_engine_adapter_unsupported")
        manifest = plan.get("manifest")
        if (
            not isinstance(manifest, dict)
            or resolved_bundle.get("bundleContentHash")
            != manifest.get("resolvedBundleHash")
        ):
            raise ValueError("connected_worker_bundle_lineage_mismatch")
        launch_hash = _content_hash(
            {"plan": plan, "resolvedBundle": resolved_bundle}
        )
        with self.process_lock:
            directory = (self.root / run_id).resolve()
            existing = self.processes.get(run_id)
            if existing:
                if self.launch_hashes.get(run_id) != launch_hash:
                    raise ValueError(
                        "connected_worker_launch_idempotency_mismatch"
                    )
                return {
                    "providerJobId": f"prime-rl-process-{existing.pid}"
                }
            persisted_launch_hash = directory / "launch-hash"
            if persisted_launch_hash.is_file():
                if (
                    persisted_launch_hash.read_text(encoding="utf-8").strip()
                    != launch_hash
                ):
                    raise ValueError(
                        "connected_worker_launch_idempotency_mismatch"
                    )
                terminal = _persisted_worker_terminal_state(directory)
                if terminal is None:
                    try:
                        process = self._recover_process(run_id, directory)
                    except ValueError as error:
                        _mark_recovery_failed(directory, error)
                        return {
                            "providerJobId":
                                f"prime-rl-recovery-failed-{run_id}"
                        }
                    return {
                        "providerJobId": f"prime-rl-process-{process.pid}"
                    }
                return {
                    "providerJobId": f"prime-rl-recovered-{run_id}"
                }
            self._recover_other_active_runs(run_id)
            if any(
                process.poll() is None
                for other_run_id, process in self.processes.items()
                if other_run_id != run_id
            ):
                raise ValueError("connected_worker_capacity_exhausted")
            directory.mkdir(parents=True, exist_ok=True)
            bundle = materialize_resolved_bundle(
                descriptor=resolved_bundle,
                directory=directory / "bundle",
            )
            plan_path = directory / "resolved-plan.json"
            plan_path.write_text(
                json.dumps(plan, sort_keys=True), encoding="utf-8"
            )
            worker_bundle_descriptor = {
                **resolved_bundle,
                "objectRef": bundle.as_uri(),
                "bundleContentHash": manifest["resolvedBundleHash"],
                "sha256": manifest["resolvedBundleHash"],
                "format": "directory",
            }
            (directory / "resolved-bundle-descriptor.json").write_text(
                json.dumps(worker_bundle_descriptor, sort_keys=True),
                encoding="utf-8",
            )
            persisted_launch_hash.write_text(
                f"{launch_hash}\n", encoding="utf-8"
            )
            signals_path = directory / "signals.jsonl"
            signals_path.touch(exist_ok=True)
            self.signal_sequences[run_id] = _next_journal_sequence(
                signals_path
            )
            output = directory / "output"
            output.mkdir(exist_ok=True)
            log = (directory / "worker.log").open("ab")
            try:
                process = subprocess.Popen(
                    [
                        "openpond-prime-rl-worker",
                        "--bundle",
                        str(bundle),
                        "--plan",
                        str(plan_path),
                        "--output",
                        str(output),
                        "--signals",
                        str(signals_path),
                        "--job-id",
                        run_id,
                        "--cancel-file",
                        str(directory / "cancel"),
                    ],
                    stdout=log,
                    stderr=subprocess.STDOUT,
                )
            finally:
                log.close()
            self.processes[run_id] = process
            self.launch_hashes[run_id] = launch_hash
            return {
                "providerJobId": f"prime-rl-process-{process.pid}"
            }

    def _recover_other_active_runs(self, requested_run_id: str) -> None:
        if not self.root.is_dir():
            return
        for directory in sorted(self.root.iterdir()):
            if (
                not directory.is_dir()
                or directory.name.startswith("_")
                or directory.name == requested_run_id
                or not (directory / "launch-hash").is_file()
                or _persisted_worker_terminal_state(directory) is not None
            ):
                continue
            try:
                self._recover_process(directory.name, directory)
                return
            except ValueError as error:
                _mark_recovery_failed(directory, error)

    def _recover_process(
        self, run_id: str, directory: Path
    ) -> subprocess.Popen[bytes]:
        recovery_path = directory / "recovery-count"
        try:
            recovery_count = int(
                recovery_path.read_text(encoding="utf-8").strip()
            )
        except (OSError, ValueError):
            recovery_count = 0
        if recovery_count >= 3:
            error = ValueError(
                "connected_worker_recovery_limit_exceeded"
            )
            _mark_recovery_failed(directory, error)
            raise error
        try:
            descriptor = json.loads(
                (
                    directory / "resolved-bundle-descriptor.json"
                ).read_text(encoding="utf-8")
            )
            plan = json.loads(
                (directory / "resolved-plan.json").read_text(
                    encoding="utf-8"
                )
            )
        except (OSError, TypeError, json.JSONDecodeError):
            raise ValueError(
                "connected_worker_recovery_state_invalid"
            )
        manifest = plan.get("manifest")
        if (
            not isinstance(descriptor, dict)
            or not isinstance(manifest, dict)
            or descriptor.get("bundleContentHash")
            != manifest.get("resolvedBundleHash")
        ):
            raise ValueError(
                "connected_worker_recovery_state_invalid"
            )
        bundle = materialize_resolved_bundle(
            descriptor=descriptor,
            directory=directory / "bundle",
        )
        signals_path = directory / "signals.jsonl"
        self.signal_sequences[run_id] = _next_journal_sequence(
            signals_path
        )
        recovery_path.write_text(
            f"{recovery_count + 1}\n", encoding="utf-8"
        )
        log = (directory / "worker.log").open("ab")
        try:
            process = subprocess.Popen(
                [
                    "openpond-prime-rl-worker",
                    "--bundle",
                    str(bundle),
                    "--plan",
                    str(directory / "resolved-plan.json"),
                    "--output",
                    str(directory / "output"),
                    "--signals",
                    str(signals_path),
                    "--job-id",
                    run_id,
                    "--cancel-file",
                    str(directory / "cancel"),
                ],
                stdout=log,
                stderr=subprocess.STDOUT,
            )
        finally:
            log.close()
        self.processes[run_id] = process
        self.launch_hashes[run_id] = (
            directory / "launch-hash"
        ).read_text(encoding="utf-8").strip()
        return process

    def consume_signals(
        self, *, run_id: str, batch: dict[str, Any]
    ) -> None:
        directory = self.root / run_id
        if not directory.is_dir():
            raise ValueError("connected_worker_run_unavailable")
        with self.process_lock:
            process = self.processes.get(run_id)
            if process is None or process.poll() is not None:
                raise ValueError("connected_worker_run_not_active")
        try:
            plan = json.loads(
                (directory / "resolved-plan.json").read_text(encoding="utf-8")
            )
        except (OSError, TypeError, json.JSONDecodeError):
            raise ValueError("connected_worker_resolved_plan_invalid")
        manifest = plan.get("manifest")
        if (
            not isinstance(manifest, dict)
            or batch.get("manifestId") != run_id
            or batch.get("manifestHash") != manifest.get("contentHash")
        ):
            raise ValueError("connected_worker_signal_manifest_mismatch")
        supplied_hash = batch.get("contentHash")
        content = {
            key: value
            for key, value in batch.items()
            if key != "contentHash"
        }
        if supplied_hash != _content_hash(content):
            raise ValueError("connected_worker_signal_batch_hash_mismatch")
        values = batch.get("signals")
        if not isinstance(values, list) or not values:
            raise ValueError("connected_worker_signal_batch_invalid")
        signals = parse_signals(values)
        validate_signal_lineage(signals, manifest)
        sequence = batch.get("sequence")
        if (
            not isinstance(sequence, int)
            or isinstance(sequence, bool)
            or sequence < 0
        ):
            raise ValueError("connected_worker_signal_sequence_invalid")
        with self.signal_lock:
            expected = self.signal_sequences.get(run_id, 0)
            if sequence != expected:
                if sequence < expected and _journal_contains(
                    directory / "signals.jsonl",
                    sequence=sequence,
                    content_hash=str(supplied_hash),
                ):
                    return
                raise ValueError("connected_worker_signal_sequence_invalid")
            with (directory / "signals.jsonl").open(
                "a", encoding="utf-8"
            ) as file:
                file.write(json.dumps(batch, sort_keys=True) + "\n")
                file.flush()
                os.fsync(file.fileno())
            self.signal_sequences[run_id] = expected + 1

    def status(self, *, run_id: str) -> dict[str, Any]:
        process = self.processes.get(run_id)
        if not process:
            directory = self.root / run_id
            terminal = _persisted_worker_terminal_state(directory)
            if terminal is None:
                with self.process_lock:
                    process = self.processes.get(run_id)
                    if process is None:
                        try:
                            process = self._recover_process(
                                run_id, directory
                            )
                        except ValueError as error:
                            _mark_recovery_failed(directory, error)
                            process = None
                code = process.poll() if process is not None else 1
            else:
                code = terminal
        else:
            code = process.poll()
        cancelled = (self.root / run_id / "cancel").exists()
        completed_steps, maximum_steps = _prime_rl_progress(
            self.root / run_id
        )
        state = (
            "running"
            if code is None
            else "succeeded"
            if code == 0
            else "cancelled"
            if cancelled
            else "failed"
        )
        return {
            "runId": run_id,
            "state": state,
            "phase": (
                "training"
                if code is None
                else "cancelled"
                if state == "cancelled"
                else "complete"
            ),
            "progress": (
                min(1.0, completed_steps / maximum_steps)
                if maximum_steps > 0
                else None
            ),
            "updatedAt": timestamp(),
            "errorCode": (
                None
                if code in (None, 0) or state == "cancelled"
                else "worker_process_failed"
            ),
        }

    def logs(
        self, *, run_id: str, cursor: str | None
    ) -> dict[str, Any]:
        path = self.root / run_id / "worker.log"
        offset = int(cursor or "0")
        if not path.is_file() or offset < 0:
            return {"cursor": str(offset), "entries": []}
        with path.open("rb") as file:
            file.seek(offset)
            lines = file.read(256 * 1024).decode(
                "utf-8", errors="replace"
            ).splitlines()
            next_offset = file.tell()
        return {
            "cursor": str(next_offset),
            "entries": [
                {
                    "timestamp": timestamp(),
                    "level": "info",
                    "message": line[:10_000],
                }
                for line in lines
            ],
        }

    def cancel(self, *, run_id: str) -> None:
        directory = self.root / run_id
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "cancel").touch()
        process = self.processes.get(run_id)
        if process and process.poll() is None:
            process.terminate()

    def artifacts(self, *, run_id: str) -> dict[str, Any]:
        output = self.root / run_id / "output"
        artifacts = []
        if output.is_dir():
            for path in sorted(output.rglob("*")):
                if path.is_symlink() or not path.is_file():
                    continue
                if ".prime-rl" in path.relative_to(output).parts:
                    continue
                content = _read_regular_file(path)
                artifacts.append(
                    {
                        "kind": _artifact_kind(path.name),
                        "objectRef": path.resolve().as_uri(),
                        "sha256": hashlib.sha256(content).hexdigest(),
                        "sizeBytes": len(content),
                    }
                )
        content = {
            "runId": run_id,
            "manifestHash": _manifest_hash(self.root / run_id),
            "artifacts": artifacts,
        }
        return {
            **content,
            "contentHash": _content_hash(content),
        }


def materialize_resolved_bundle(
    *, descriptor: dict[str, Any], directory: Path
) -> Path:
    object_ref = str(descriptor.get("objectRef") or "")
    expected_hash = str(descriptor.get("sha256") or "")
    expected_content_hash = str(
        descriptor.get("bundleContentHash") or ""
    )
    expected_size = descriptor.get("sizeBytes")
    bundle_format = descriptor.get("format")
    if (
        len(expected_hash) != 64
        or any(character not in "0123456789abcdef" for character in expected_hash)
        or len(expected_content_hash) != 64
        or any(
            character not in "0123456789abcdef"
            for character in expected_content_hash
        )
        or not isinstance(expected_size, int)
        or expected_size < 0
    ):
        raise ValueError("connected_worker_bundle_descriptor_invalid")
    if bundle_format == "directory":
        if not object_ref.startswith("file://"):
            raise ValueError("connected_worker_directory_bundle_must_be_local")
        source = _path_from_file_ref(object_ref).resolve()
        if not source.is_dir():
            raise ValueError("connected_worker_bundle_unavailable")
        content_hash = _verify_resolved_bundle_directory(source)
        if (
            content_hash != expected_content_hash
            or expected_hash != expected_content_hash
        ):
            raise ValueError("connected_worker_bundle_hash_mismatch")
        return source
    if bundle_format != "tar":
        raise ValueError("connected_worker_bundle_format_unsupported")
    directory.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        prefix="openpond-bundle-", suffix=".tar", delete=False
    ) as temporary:
        archive = Path(temporary.name)
        digest = hashlib.sha256()
        size = 0
        try:
            if object_ref.startswith("file://"):
                source = _path_from_file_ref(object_ref).resolve()
                stream = source.open("rb")
            elif object_ref.startswith("https://"):
                stream = urlopen(object_ref, timeout=60)  # noqa: S310
            else:
                raise ValueError("connected_worker_bundle_ref_unsupported")
            with stream:
                while True:
                    chunk = stream.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > expected_size:
                        raise ValueError("connected_worker_bundle_size_mismatch")
                    digest.update(chunk)
                    temporary.write(chunk)
            temporary.flush()
            if size != expected_size:
                raise ValueError("connected_worker_bundle_size_mismatch")
            if digest.hexdigest() != expected_hash:
                raise ValueError("connected_worker_bundle_hash_mismatch")
        except Exception:
            archive.unlink(missing_ok=True)
            raise
    try:
        if directory.exists():
            shutil.rmtree(directory)
        directory.mkdir(parents=True)
        with tarfile.open(archive, "r:*") as tar:
            root = directory.resolve()
            for member in tar.getmembers():
                target = (directory / member.name).resolve()
                if (
                    root not in target.parents
                    and target != root
                    or member.issym()
                    or member.islnk()
                    or member.isdev()
                ):
                    raise ValueError("connected_worker_bundle_archive_unsafe")
            tar.extractall(
                directory,
                filter="data",
            )  # noqa: S202 - members are validated and filtered
        content_hash = _verify_resolved_bundle_directory(directory)
        if content_hash != expected_content_hash:
            raise ValueError("connected_worker_bundle_hash_mismatch")
        return directory
    finally:
        archive.unlink(missing_ok=True)


def _content_hash(value: Any) -> str:
    canonical = json.dumps(
        value, sort_keys=True, ensure_ascii=False, indent=2
    ) + "\n"
    return hashlib.sha256(canonical.encode()).hexdigest()


def _path_from_file_ref(object_ref: str) -> Path:
    parsed = urlparse(object_ref)
    if (
        parsed.scheme != "file"
        or parsed.netloc not in {"", "localhost"}
        or not parsed.path
    ):
        raise ValueError("connected_worker_file_ref_invalid")
    return Path(url2pathname(parsed.path))


def _verify_resolved_bundle_directory(directory: Path) -> str:
    manifest_path = directory / "bundle-manifest.json"
    if not manifest_path.is_file() or manifest_path.is_symlink():
        raise ValueError("connected_worker_bundle_manifest_missing")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, TypeError, json.JSONDecodeError):
        raise ValueError("connected_worker_bundle_manifest_invalid")
    content_hash = _validate_resolved_bundle_manifest(manifest)
    files = manifest["files"]
    root = directory.resolve()
    expected_paths = {"bundle-manifest.json"}
    for item in files:
        if not isinstance(item, dict):
            raise ValueError("connected_worker_bundle_manifest_invalid")
        relative = item.get("path")
        expected_hash = item.get("sha256")
        expected_size = item.get("sizeBytes")
        target = _bundle_asset_path(directory, str(relative))
        if (
            target == root
            or root not in target.parents
            or not target.is_file()
            or target.is_symlink()
        ):
            raise ValueError("connected_worker_bundle_asset_invalid")
        data = target.read_bytes()
        if (
            len(data) != expected_size
            or hashlib.sha256(data).hexdigest() != expected_hash
        ):
            raise ValueError("connected_worker_bundle_asset_hash_mismatch")
        normalized = target.relative_to(root).as_posix()
        if normalized in expected_paths:
            raise ValueError("connected_worker_bundle_asset_duplicate")
        expected_paths.add(normalized)
    actual_paths: set[str] = set()
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError("connected_worker_bundle_symlink_unsupported")
        if path.is_file():
            actual_paths.add(path.relative_to(root).as_posix())
        elif not path.is_dir():
            raise ValueError("connected_worker_bundle_entry_invalid")
    if actual_paths != expected_paths:
        raise ValueError("connected_worker_bundle_inventory_mismatch")
    return str(content_hash)


def _validate_resolved_bundle_manifest(
    manifest: dict[str, Any],
) -> str:
    if (
        not isinstance(manifest, dict)
        or manifest.get("schemaVersion")
        != "openpond.resolvedTrainingBundle.v1"
        or manifest.get("projection") != "trainer"
    ):
        raise ValueError("connected_worker_bundle_manifest_invalid")
    supplied_hash = manifest.get("contentHash")
    content = {
        key: value
        for key, value in manifest.items()
        if key != "contentHash"
    }
    if (
        not isinstance(supplied_hash, str)
        or supplied_hash != _content_hash(content)
    ):
        raise ValueError("connected_worker_bundle_manifest_hash_mismatch")
    files = manifest.get("files")
    if not isinstance(files, list) or len(files) > 100_000:
        raise ValueError("connected_worker_bundle_manifest_invalid")
    paths: set[str] = set()
    total_size = 0
    for file in files:
        if not isinstance(file, dict):
            raise ValueError("connected_worker_bundle_manifest_invalid")
        asset_path = file.get("path")
        size = file.get("sizeBytes")
        digest = file.get("sha256")
        if (
            not isinstance(asset_path, str)
            or asset_path in paths
            or not isinstance(size, int)
            or isinstance(size, bool)
            or size < 0
            or not isinstance(digest, str)
            or len(digest) != 64
            or any(
                character not in "0123456789abcdef"
                for character in digest
            )
        ):
            raise ValueError("connected_worker_bundle_manifest_invalid")
        _bundle_asset_path(
            Path("/__openpond_bundle_root__"), asset_path
        )
        paths.add(asset_path)
        total_size += size
        if total_size > 20 * 1024 * 1024 * 1024:
            raise ValueError("connected_worker_bundle_manifest_invalid")
    return supplied_hash


def _bundle_asset_path(root: Path, asset_path: str) -> Path:
    if (
        not asset_path
        or "\\" in asset_path
        or "\x00" in asset_path
        or asset_path.startswith("/")
        or any(
            part in {"", ".", ".."}
            for part in asset_path.split("/")
        )
    ):
        raise ValueError("connected_worker_bundle_asset_path_invalid")
    target = (root / asset_path).resolve()
    resolved_root = root.resolve()
    if resolved_root not in target.parents:
        raise ValueError("connected_worker_bundle_asset_path_invalid")
    return target


def _manifest_hash(directory: Path) -> str:
    try:
        plan = json.loads((directory / "resolved-plan.json").read_text())
        return str(plan["manifest"]["contentHash"])
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        return "0" * 64


def _persisted_worker_terminal_state(directory: Path) -> int | None:
    if (directory / "recovery-failed").is_file():
        return 1
    if (directory / "cancel").exists():
        return 130
    receipt_path = directory / "output" / "prime-rl-execution-receipt.json"
    if receipt_path.is_file():
        try:
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            supplied_hash = receipt.get("contentHash")
            content = {
                key: value
                for key, value in receipt.items()
                if key != "contentHash"
            }
            if (
                isinstance(receipt, dict)
                and supplied_hash == _content_hash(content)
                and receipt.get("manifestHash")
                == _manifest_hash(directory)
            ):
                return 0
        except (OSError, TypeError, json.JSONDecodeError):
            return 1
        return 1
    log_path = directory / "worker.log"
    if log_path.is_file():
        for line in log_path.read_text(
            encoding="utf-8", errors="replace"
        ).splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if (
                isinstance(event, dict)
                and event.get("event") == "failure"
            ):
                return 1
    return None


def _mark_recovery_failed(directory: Path, error: ValueError) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    marker = directory / "recovery-failed"
    with marker.open("w", encoding="utf-8") as file:
        file.write(f"{error}\n")
        file.flush()
        os.fsync(file.fileno())


def _read_regular_file(path: Path) -> bytes:
    try:
        descriptor = os.open(
            path,
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
        )
    except OSError as error:
        raise ValueError(
            "connected_worker_artifact_unavailable"
        ) from error
    with os.fdopen(descriptor, "rb") as file:
        if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
            raise ValueError(
                "connected_worker_artifact_unavailable"
            )
        return file.read()


def _journal_contains(
    path: Path, *, sequence: int, content_hash: str
) -> bool:
    if not path.is_file():
        return False
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            batch = json.loads(line)
        except json.JSONDecodeError:
            continue
        if (
            isinstance(batch, dict)
            and batch.get("sequence") == sequence
            and batch.get("contentHash") == content_hash
        ):
            return True
    return False


def _next_journal_sequence(path: Path) -> int:
    if not path.is_file():
        return 0
    sequences: list[int] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            raise ValueError("connected_worker_signal_journal_invalid")
        sequence = value.get("sequence") if isinstance(value, dict) else None
        if (
            not isinstance(sequence, int)
            or isinstance(sequence, bool)
            or sequence != len(sequences)
        ):
            raise ValueError("connected_worker_signal_journal_invalid")
        sequences.append(sequence)
    return len(sequences)


def _prime_rl_progress(directory: Path) -> tuple[int, int]:
    completed = 0
    receipts = directory / "output" / "prime-rl-step-receipts.jsonl"
    if receipts.is_file():
        completed = sum(
            1 for line in receipts.read_text(encoding="utf-8").splitlines()
            if line.strip()
        )
    try:
        plan = json.loads(
            (directory / "resolved-plan.json").read_text(encoding="utf-8")
        )
        maximum = int(plan["recipe"]["optimizer"]["maxSteps"])
    except (
        OSError,
        KeyError,
        TypeError,
        ValueError,
        json.JSONDecodeError,
    ):
        maximum = 0
    return completed, maximum


def _artifact_kind(name: str) -> str:
    if "adapter" in name:
        return "adapter"
    if "checkpoint" in name:
        return "checkpoint"
    if "eval" in name:
        return "evaluation"
    if "metric" in name:
        return "metrics"
    if "event" in name or "trace" in name:
        return "trace"
    return "receipt"


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
