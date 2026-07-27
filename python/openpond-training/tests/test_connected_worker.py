from __future__ import annotations

from datetime import UTC, datetime, timedelta
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile

import pytest

from openpond_training.connected_worker import (
    ConnectedWorkerService,
    SubprocessTrainingExecutor,
    materialize_resolved_bundle,
)


def resolved_bundle_manifest() -> dict:
    base = {
        "schemaVersion": "openpond.resolvedTrainingBundle.v1",
        "projection": "trainer",
        "harnessRelease": {
            "id": "harness-release",
            "contentHash": "a" * 64,
        },
        "datasetRelease": {
            "id": "dataset-release",
            "contentHash": "b" * 64,
        },
        "evidenceSetRelease": None,
        "files": [],
    }
    canonical = json.dumps(
        base, sort_keys=True, ensure_ascii=False, indent=2
    ) + "\n"
    return {
        **base,
        "contentHash": hashlib.sha256(canonical.encode()).hexdigest(),
    }


class Executor:
    def __init__(self) -> None:
        self.cancelled = False

    def launch(self, *, run_id, plan, resolved_bundle):
        assert resolved_bundle["objectRef"] == "file:///bundle"
        return {"providerJobId": f"local-{run_id}"}

    def consume_signals(self, *, run_id, batch):
        assert batch["manifestId"] == run_id

    def status(self, *, run_id):
        return {
            "runId": run_id,
            "state": "running",
            "phase": "training",
            "progress": 0.5,
            "updatedAt": "2026-07-23T12:00:00Z",
            "errorCode": None,
        }

    def logs(self, *, run_id, cursor):
        return {"cursor": "1", "entries": []}

    def cancel(self, *, run_id):
        self.cancelled = True

    def artifacts(self, *, run_id):
        return {"runId": run_id, "artifacts": []}


def service(clock) -> ConnectedWorkerService:
    return ConnectedWorkerService(
        worker_id="worker-1",
        worker_release="0.0.38",
        worker_image_digest=f"sha256:{'a' * 64}",
        capability_receipt="b" * 64,
        executor=Executor(),
        verify_secret_lease=lambda value: value == "opaque-lease-ref",
        sign_nonce=lambda value: f"signed:{value}",
        now=lambda: clock[0],
    )


def test_module_entrypoint_runs_the_release_self_test(tmp_path: Path) -> None:
    identity_key = tmp_path / "identity-key"
    authentication_lease = tmp_path / "authentication-lease"
    identity_key.write_text("identity-key-material", encoding="utf-8")
    authentication_lease.write_text("opaque-lease-ref", encoding="utf-8")
    environment = {
        **os.environ,
        "OPENPOND_WORKER_ID": "worker-1",
        "OPENPOND_WORKER_RELEASE": "0.0.38",
        "OPENPOND_WORKER_IMAGE_DIGEST": f"sha256:{'a' * 64}",
        "OPENPOND_WORKER_CAPABILITY_RECEIPT": "b" * 64,
        "OPENPOND_WORKER_IDENTITY_KEY_FILE": str(identity_key),
        "OPENPOND_WORKER_AUTHENTICATION_LEASE_FILE": str(
            authentication_lease
        ),
    }
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "openpond_training.connected_worker",
            "--self-test",
        ],
        check=True,
        capture_output=True,
        text=True,
        env=environment,
    )

    assert json.loads(completed.stdout) == {
        "engineAdapterId": "connected-prime-rl",
        "protocolVersion": "openpond.connectedWorker.v1",
        "ready": True,
        "workerId": "worker-1",
        "workerImageDigest": f"sha256:{'a' * 64}",
        "workerRelease": "0.0.38",
    }


def test_authenticated_lease_heartbeat_launch_cancel_and_release() -> None:
    clock = [datetime(2026, 7, 23, 12, tzinfo=UTC)]
    worker = service(clock)
    handshake = worker.handshake(
        {
            "protocolVersion": "openpond.connectedWorker.v1",
            "clientRelease": "0.0.38",
            "nonce": "nonce-with-enough-entropy",
            "expectedWorkerImageDigest": f"sha256:{'a' * 64}",
        },
        "opaque-lease-ref",
    )
    assert handshake["nonceSignature"] == "signed:nonce-with-enough-entropy"

    lease = worker.acquire_lease(run_id="run-1", duration_seconds=60)
    clock[0] += timedelta(seconds=30)
    heartbeat = worker.heartbeat(lease["id"])
    assert heartbeat["expiresAt"] > lease["expiresAt"]
    execution = worker.launch(
        lease_id=lease["id"],
            plan={
                "manifest": {"id": "run-1"},
                "engine": {"adapterId": "connected-prime-rl"},
            },
        resolved_bundle={
            "objectRef": "file:///bundle",
            "sha256": "c" * 64,
            "sizeBytes": 0,
            "format": "directory",
        },
    )
    assert execution["providerJobId"] == "local-run-1"
    worker.consume_signals(
        run_id="run-1",
        batch={
            "manifestId": "run-1",
            "sequence": 0,
            "contentHash": "d" * 64,
        },
    )
    assert worker.status(run_id="run-1")["state"] == "running"
    worker.cancel(run_id="run-1")
    assert worker.executor.cancelled is True
    events = worker.events(run_id="run-1", after_sequence=-1)
    assert [event["type"] for event in events] == [
        "lease",
        "lease",
        "preparation",
        "progress",
        "progress",
        "cancellation",
    ]
    assert all(len(event["payloadHash"]) == 64 for event in events)
    assert worker.events(
        run_id="run-1", after_sequence=events[-2]["sequence"]
    ) == [events[-1]]
    worker.release_lease(lease["id"])
    with pytest.raises(ValueError, match="lease_inactive"):
        worker.status(run_id="run-1")


def test_rejects_wrong_image_or_secret_lease() -> None:
    worker = service([datetime(2026, 7, 23, 12, tzinfo=UTC)])
    request = {
        "protocolVersion": "openpond.connectedWorker.v1",
        "clientRelease": "0.0.38",
        "nonce": "nonce-with-enough-entropy",
        "expectedWorkerImageDigest": f"sha256:{'c' * 64}",
    }
    with pytest.raises(ValueError, match="image_mismatch"):
        worker.handshake(request, "opaque-lease-ref")
    request["expectedWorkerImageDigest"] = f"sha256:{'a' * 64}"
    with pytest.raises(PermissionError, match="secret_lease_invalid"):
        worker.handshake(request, "wrong")


def test_reads_hash_bound_artifact_chunks(tmp_path: Path) -> None:
    worker = service([datetime(2026, 7, 23, 12, tzinfo=UTC)])
    worker.acquire_lease(run_id="run-1", duration_seconds=60)
    artifact = tmp_path / "adapter.bin"
    artifact.write_bytes(b"adapter")
    worker.executor.artifacts = lambda *, run_id: {
        "runId": run_id,
        "artifacts": [{"objectRef": artifact.as_uri()}],
    }
    chunk = worker.read_artifact_chunk(
        run_id="run-1",
        object_ref=artifact.as_uri(),
        offset=0,
        maximum_bytes=4,
    )
    assert chunk["content"] == b"adap"
    assert chunk["complete"] is False
    assert len(chunk["chunkHash"]) == 64
    with pytest.raises(ValueError, match="unauthorized"):
        worker.read_artifact_chunk(
            run_id="run-1",
            object_ref=(tmp_path / "not-an-artifact").as_uri(),
            offset=0,
        )
    symlink = tmp_path / "adapter-link.bin"
    symlink.symlink_to(artifact)
    worker.executor.artifacts = lambda *, run_id: {
        "runId": run_id,
        "artifacts": [{"objectRef": symlink.as_uri()}],
    }
    with pytest.raises(ValueError, match="unavailable"):
        worker.read_artifact_chunk(
            run_id="run-1",
            object_ref=symlink.as_uri(),
            offset=0,
        )


def test_materializes_a_hash_bound_tar_without_path_escape(
    tmp_path: Path,
) -> None:
    archive = tmp_path / "bundle.tar"
    bundle_manifest = resolved_bundle_manifest()
    manifest = json.dumps(bundle_manifest).encode()
    with tarfile.open(archive, "w") as tar:
        info = tarfile.TarInfo("bundle-manifest.json")
        info.size = len(manifest)
        tar.addfile(info, io.BytesIO(manifest))
    content = archive.read_bytes()
    result = materialize_resolved_bundle(
        descriptor={
            "objectRef": archive.as_uri(),
            "bundleContentHash": bundle_manifest["contentHash"],
            "sha256": hashlib.sha256(content).hexdigest(),
            "sizeBytes": len(content),
            "format": "tar",
        },
        directory=tmp_path / "materialized",
    )
    assert (result / "bundle-manifest.json").is_file()

    unsafe = tmp_path / "unsafe.tar"
    with tarfile.open(unsafe, "w") as tar:
        info = tarfile.TarInfo("../escape")
        info.size = 1
        tar.addfile(info, io.BytesIO(b"x"))
    unsafe_content = unsafe.read_bytes()
    with pytest.raises(ValueError, match="archive_unsafe"):
        materialize_resolved_bundle(
            descriptor={
                "objectRef": unsafe.as_uri(),
                "bundleContentHash": "d" * 64,
                "sha256": hashlib.sha256(unsafe_content).hexdigest(),
                "sizeBytes": len(unsafe_content),
                "format": "tar",
            },
            directory=tmp_path / "unsafe-materialized",
        )


def test_stages_a_chunked_bundle_and_reuses_verified_content(
    tmp_path: Path,
) -> None:
    content = b"trainer projection"
    base = {
        "schemaVersion": "openpond.resolvedTrainingBundle.v1",
        "projection": "trainer",
        "harnessRelease": {
            "id": "harness-release",
            "contentHash": "a" * 64,
        },
        "datasetRelease": {
            "id": "dataset-release",
            "contentHash": "b" * 64,
        },
        "evidenceSetRelease": None,
        "files": [
            {
                "path": "dataset/train.json",
                "sha256": hashlib.sha256(content).hexdigest(),
                "sizeBytes": len(content),
            }
        ],
    }
    manifest = {
        **base,
        "contentHash": hashlib.sha256(
            (
                json.dumps(
                    base,
                    sort_keys=True,
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            ).encode()
        ).hexdigest(),
    }
    executor = SubprocessTrainingExecutor(tmp_path / "state")
    session = executor.begin_bundle_upload(manifest=manifest)
    assert session["missingPaths"] == ["dataset/train.json"]
    receipt = executor.upload_bundle_chunk(
        upload_id=session["uploadId"],
        asset_path="dataset/train.json",
        offset=0,
        content=content,
        chunk_hash=hashlib.sha256(content).hexdigest(),
        final=True,
    )
    assert receipt["complete"] is True
    descriptor = executor.complete_bundle_upload(
        upload_id=session["uploadId"]
    )
    assert descriptor["bundleContentHash"] == manifest["contentHash"]
    assert Path(
        descriptor["objectRef"].removeprefix("file://")
    ).is_dir()
    replay = executor.begin_bundle_upload(manifest=manifest)
    assert replay["missingPaths"] == []
    assert (
        executor.complete_bundle_upload(upload_id=replay["uploadId"])
        == descriptor
    )


def test_connected_prime_worker_dispatches_to_upstream_runner(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    bundle_manifest = resolved_bundle_manifest()
    (bundle / "bundle-manifest.json").write_text(
        json.dumps(bundle_manifest),
        encoding="utf-8",
    )
    launched: list[list[str]] = []

    class Process:
        pid = 42

        def poll(self):
            return None

    def popen(arguments, **_kwargs):
        launched.append(arguments)
        return Process()

    monkeypatch.setattr(
        "openpond_training.connected_worker_execution.subprocess.Popen",
        popen,
    )
    executor = SubprocessTrainingExecutor(tmp_path / "state")
    result = executor.launch(
        run_id="run-prime",
        plan={
            "manifest": {
                "id": "run-prime",
                "contentHash": "e" * 64,
                "resolvedBundleHash": bundle_manifest["contentHash"],
            },
            "engine": {"adapterId": "connected-prime-rl"},
        },
        resolved_bundle={
            "objectRef": bundle.as_uri(),
            "bundleContentHash": bundle_manifest["contentHash"],
            "sha256": bundle_manifest["contentHash"],
            "sizeBytes": 0,
            "format": "directory",
        },
    )
    assert launched[0][0] == "openpond-prime-rl-worker"
    assert "--plan" in launched[0]
    assert "--signals" in launched[0]
    assert result == {"providerJobId": "prime-rl-process-42"}


def test_connected_worker_launch_is_idempotent_and_single_gpu_bounded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    bundle_manifest = resolved_bundle_manifest()
    (bundle / "bundle-manifest.json").write_text(
        json.dumps(bundle_manifest),
        encoding="utf-8",
    )
    launched: list[list[str]] = []

    class Process:
        pid = 42

        def poll(self):
            return None

    def popen(arguments, **_kwargs):
        launched.append(arguments)
        return Process()

    monkeypatch.setattr(
        "openpond_training.connected_worker_execution.subprocess.Popen",
        popen,
    )
    executor = SubprocessTrainingExecutor(tmp_path / "state")
    plan = {
        "manifest": {
            "id": "run-prime",
            "contentHash": "e" * 64,
            "resolvedBundleHash": bundle_manifest["contentHash"],
        },
        "engine": {"adapterId": "connected-prime-rl"},
    }
    descriptor = {
        "objectRef": bundle.as_uri(),
        "bundleContentHash": bundle_manifest["contentHash"],
        "sha256": bundle_manifest["contentHash"],
        "sizeBytes": 0,
        "format": "directory",
    }
    first = executor.launch(
        run_id="run-prime",
        plan=plan,
        resolved_bundle=descriptor,
    )
    replay = executor.launch(
        run_id="run-prime",
        plan=plan,
        resolved_bundle=descriptor,
    )
    assert replay == first
    assert len(launched) == 1

    changed_plan = {
        **plan,
        "contentHash": "f" * 64,
    }
    with pytest.raises(ValueError, match="idempotency_mismatch"):
        executor.launch(
            run_id="run-prime",
            plan=changed_plan,
            resolved_bundle=descriptor,
        )

    with pytest.raises(ValueError, match="capacity_exhausted"):
        executor.launch(
            run_id="run-other",
            plan={
                **plan,
                "manifest": {
                    **plan["manifest"],
                    "id": "run-other",
                },
            },
            resolved_bundle=descriptor,
        )


def test_connected_worker_recovers_an_interrupted_persisted_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    bundle_manifest = resolved_bundle_manifest()
    (bundle / "bundle-manifest.json").write_text(
        json.dumps(bundle_manifest),
        encoding="utf-8",
    )
    launched: list[int] = []

    class Process:
        def __init__(self) -> None:
            self.pid = 100 + len(launched)

        def poll(self):
            return None

    def popen(_arguments, **_kwargs):
        process = Process()
        launched.append(process.pid)
        return process

    monkeypatch.setattr(
        "openpond_training.connected_worker_execution.subprocess.Popen",
        popen,
    )
    root = tmp_path / "state"
    exact_plan = {
        "manifest": {
            "id": "run-prime",
            "contentHash": "e" * 64,
            "resolvedBundleHash": bundle_manifest["contentHash"],
        },
        "engine": {"adapterId": "connected-prime-rl"},
    }
    descriptor = {
        "objectRef": bundle.as_uri(),
        "bundleContentHash": bundle_manifest["contentHash"],
        "sha256": bundle_manifest["contentHash"],
        "sizeBytes": 0,
        "format": "directory",
    }
    SubprocessTrainingExecutor(root).launch(
        run_id="run-prime",
        plan=exact_plan,
        resolved_bundle=descriptor,
    )
    recovered = SubprocessTrainingExecutor(root)
    assert recovered.status(run_id="run-prime")["state"] == "running"
    assert launched == [100, 101]
    assert (
        root / "run-prime" / "recovery-count"
    ).read_text().strip() == "1"


def test_connected_worker_bounds_recovery_and_persists_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    bundle_manifest = resolved_bundle_manifest()
    (bundle / "bundle-manifest.json").write_text(
        json.dumps(bundle_manifest),
        encoding="utf-8",
    )

    class Process:
        pid = 100

        def poll(self):
            return None

    monkeypatch.setattr(
        "openpond_training.connected_worker_execution.subprocess.Popen",
        lambda _arguments, **_kwargs: Process(),
    )
    root = tmp_path / "state"
    exact_plan = {
        "manifest": {
            "id": "run-prime",
            "contentHash": "e" * 64,
            "resolvedBundleHash": bundle_manifest["contentHash"],
        },
        "engine": {"adapterId": "connected-prime-rl"},
    }
    descriptor = {
        "objectRef": bundle.as_uri(),
        "bundleContentHash": bundle_manifest["contentHash"],
        "sha256": bundle_manifest["contentHash"],
        "sizeBytes": 0,
        "format": "directory",
    }
    SubprocessTrainingExecutor(root).launch(
        run_id="run-prime",
        plan=exact_plan,
        resolved_bundle=descriptor,
    )
    (root / "run-prime" / "recovery-count").write_text(
        "3\n", encoding="utf-8"
    )
    assert (
        SubprocessTrainingExecutor(root).status(run_id="run-prime")["state"]
        == "failed"
    )
    assert (
        root / "run-prime" / "recovery-failed"
    ).read_text().strip() == "connected_worker_recovery_limit_exceeded"
