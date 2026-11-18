"""Immutable dataset versions backed by a retained shard index."""
from __future__ import annotations

from typing import TypedDict, cast
from urllib.parse import quote

from . import models
from .dataset_import_materialization import SPLITS, Split, is_digest
from .dataset_imports import identifier
from .dataset_transfer_parts import byte_count, payload
from .errors import ProtocolError
from .transport import AsyncTransport, Transport
from .wire import canonical_sha256, validate

_MEDIA = "application/json"


class DatasetVersionRelease(TypedDict):
    id: str
    revision: int
    contentHash: str


class DatasetVersionValidation(TypedDict):
    teamId: str
    datasetId: str
    revision: int
    workspaceHash: str
    indexHash: str
    packageHash: str
    release: DatasetVersionRelease


class DatasetVersionManifest(DatasetVersionValidation):
    draftRevision: int
    acceptedRows: int
    rejectedRows: int
    shardCount: int
    splitCounts: dict[Split, int]
    publishedAt: str


def _revision(revision: int) -> int:
    if not byte_count(revision):
        raise ProtocolError("dataset_version_revision_invalid")
    return revision


def _versions(dataset_id: str) -> str:
    return f"/v1/dataset-workspaces/{quote(identifier(dataset_id), safe='')}/versions"


def _publish_request(operation_id: str, expected_revision: int, workspace_hash: str,
                     index_hash: str, package_hash: str) -> dict:
    if not all(is_digest(value) for value in (workspace_hash, index_hash, package_hash)):
        raise ProtocolError("dataset_version_pins_invalid")
    return {"operationId": identifier(operation_id), "expectedRevision": _revision(expected_revision),
            "workspaceHash": workspace_hash, "indexHash": index_hash, "packageHash": package_hash}


def _version(value: object, team_id: str, dataset_id: str, revision: int,
             published: bool) -> DatasetVersionValidation | DatasetVersionManifest:
    receipt = payload(value)
    release = payload(receipt.get("release"))
    expected_release_revision = revision if published else revision + 1
    if (receipt.get("teamId") != team_id or receipt.get("datasetId") != dataset_id
        or byte_count(receipt.get("revision")) != revision or release.get("id") != dataset_id
        or byte_count(release.get("revision")) != expected_release_revision
        or release.get("contentHash") != receipt.get("packageHash")
        or not all(is_digest(receipt.get(field)) for field in ("workspaceHash", "indexHash", "packageHash"))):
        raise ProtocolError("dataset_version_response_invalid")
    if not published:
        return cast(DatasetVersionValidation, receipt)
    counts = payload(receipt.get("splitCounts"))
    if (byte_count(receipt.get("draftRevision")) != revision - 1 or set(counts) != SPLITS
        or sum(byte_count(count) for count in counts.values()) != byte_count(receipt.get("acceptedRows"))
        or not isinstance(receipt.get("publishedAt"), str)):
        raise ProtocolError("dataset_version_response_invalid")
    byte_count(receipt.get("rejectedRows"))
    byte_count(receipt.get("shardCount"))
    return cast(DatasetVersionManifest, receipt)


def _published(value: object, team_id: str, dataset_id: str, request: dict) -> models.DatasetWorkspaceReceipt:
    receipt = validate("DatasetWorkspaceReceiptSchema", value)
    workspace = receipt["workspace"]
    draft = workspace["draft"]
    publication = payload(receipt["publication"])
    release = payload(publication["release"])
    manifest = payload(draft["metadata"].get("hostedImport"))
    revision = request["expectedRevision"] + 1
    if (receipt["teamId"] != team_id or receipt["datasetId"] != dataset_id or receipt["revision"] != revision
        or draft["profileId"] != team_id or draft["id"] != dataset_id or draft["revision"] != revision
        or draft["modelScope"] is not None or draft["status"] != "published" or draft["publishedTasksetRef"] != release
        or publication["packageHash"] != request["packageHash"] or release["contentHash"] != request["packageHash"]
        or release["id"] != dataset_id or release["revision"] != revision or manifest.get("indexHash") != request["indexHash"]
        or canonical_sha256({key: field for key, field in workspace.items() if key != "contentHash"}) != workspace["contentHash"]):
        raise ProtocolError("dataset_version_response_invalid")
    return cast(models.DatasetWorkspaceReceipt, receipt)


class DatasetVersions:
    _transport: Transport
    team_id: str

    def validate_version(self, dataset_id: str, *, expected_revision: int) -> DatasetVersionValidation:
        request = {"expectedRevision": _revision(expected_revision)}
        result = self._transport.request("POST", _versions(dataset_id) + "/validate", request, media=_MEDIA, response_limit=16 * 1024)
        return cast(DatasetVersionValidation, _version(result, self.team_id, dataset_id, expected_revision, False))

    def create_version(self, dataset_id: str, *, operation_id: str, expected_revision: int,
                       workspace_hash: str, index_hash: str, package_hash: str) -> models.DatasetWorkspaceReceipt:
        request = _publish_request(operation_id, expected_revision, workspace_hash, index_hash, package_hash)
        result = self._transport.request("POST", _versions(dataset_id), request, media=_MEDIA, response_limit=64 * 1024)
        return _published(result, self.team_id, dataset_id, request)

    def version_manifest(self, dataset_id: str, revision: int) -> DatasetVersionManifest:
        result = self._transport.request("GET", f"{_versions(dataset_id)}/{_revision(revision)}/manifest", media=_MEDIA, response_limit=16 * 1024)
        return cast(DatasetVersionManifest, _version(result, self.team_id, dataset_id, revision, True))


class AsyncDatasetVersions:
    _transport: AsyncTransport
    team_id: str

    async def validate_version(self, dataset_id: str, *, expected_revision: int) -> DatasetVersionValidation:
        request = {"expectedRevision": _revision(expected_revision)}
        result = await self._transport.request("POST", _versions(dataset_id) + "/validate", request, media=_MEDIA, response_limit=16 * 1024)
        return cast(DatasetVersionValidation, _version(result, self.team_id, dataset_id, expected_revision, False))

    async def create_version(self, dataset_id: str, *, operation_id: str, expected_revision: int,
                             workspace_hash: str, index_hash: str, package_hash: str) -> models.DatasetWorkspaceReceipt:
        request = _publish_request(operation_id, expected_revision, workspace_hash, index_hash, package_hash)
        result = await self._transport.request("POST", _versions(dataset_id), request, media=_MEDIA, response_limit=64 * 1024)
        return _published(result, self.team_id, dataset_id, request)

    async def version_manifest(self, dataset_id: str, revision: int) -> DatasetVersionManifest:
        result = await self._transport.request("GET", f"{_versions(dataset_id)}/{_revision(revision)}/manifest", media=_MEDIA, response_limit=16 * 1024)
        return cast(DatasetVersionManifest, _version(result, self.team_id, dataset_id, revision, True))
