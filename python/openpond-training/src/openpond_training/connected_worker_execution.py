from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
from threading import Lock, RLock
from typing import Any
import uuid

from .connected_worker_bundles import (
    BundleUploadState,
    _bundle_asset_path,
    _validate_resolved_bundle_manifest,
    _verify_resolved_bundle_directory,
    materialize_resolved_bundle,
)
from .connected_worker_files import (
    content_hash as _content_hash,
    read_regular_file as _read_regular_file,
)
from .connected_worker_protocol import timestamp
from .connected_worker_recovery import (
    _artifact_kind,
    _journal_contains,
    _manifest_hash,
    _mark_recovery_failed,
    _next_journal_sequence,
    _persisted_worker_terminal_state,
    _prime_rl_progress,
)
from .engine_adapters import validate_signal_lineage
from .learning_signals import parse_signals


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
