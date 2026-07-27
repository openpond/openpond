from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
from typing import Any
from urllib.request import urlopen

from .connected_worker_files import (
    content_hash as _content_hash,
    path_from_file_ref as _path_from_file_ref,
)


@dataclass
class BundleUploadState:
    id: str
    manifest: dict[str, Any]
    directory: Path
    existing: bool = False


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
