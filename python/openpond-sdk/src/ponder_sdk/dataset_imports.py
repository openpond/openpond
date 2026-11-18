"""Resumable uploads and bounded source previews for hosted dataset imports."""
from __future__ import annotations

from collections.abc import Callable, Sequence
from pathlib import Path
import re
from typing import Literal, TypedDict, cast
from urllib.parse import quote, urlencode

import httpx
from typing_extensions import NotRequired

from .dataset_import_mapping import (
    DatasetImportMappingReceipt, MappingGroup, MappingProjection, mapping_receipt,
)
from .dataset_import_materialization import (
    MaterializationPage, MaterializationReceipt, materialization_page,
    materialization_receipt, page_query, preparation_input,
)
from .dataset_transfer_parts import (
    FileSource, UploadedParts, byte_count, payload, signed_part, transfer_etag,
)
from .errors import PonderError, ProtocolError
from .transport import AsyncTransport, Transport
from .wire import JsonValue

IMPORTS = "/v1/dataset-imports"
MEDIA = "application/json"
RESPONSE_BYTES = 512 * 1024
Progress = Callable[[int, int], None]


class DatasetSourceDeclaration(TypedDict):
    relativePath: str
    sizeBytes: int


class DatasetSourceReference(TypedDict):
    objectId: str
    sha256: str
    sizeBytes: int
    mediaType: str
    visibility: Literal["private_source"]


class DatasetImportFile(DatasetSourceDeclaration):
    fileId: str
    partSize: int
    state: Literal["pending", "uploading", "queued", "verified", "failed", "deleted"]
    failureCode: str | None
    object: DatasetSourceReference | None


class DatasetImportReceipt(TypedDict):
    importId: str
    state: Literal["uploading", "uploaded", "cancelling", "cancelled"]
    reservedBytes: int
    expiresAt: str
    files: list[DatasetImportFile]


class DatasetImportPreviewRow(TypedDict):
    id: str
    ordinal: int
    values: dict[str, JsonValue]
    projection: NotRequired[MappingProjection]


class DatasetImportPreview(TypedDict):
    importId: str
    fileId: str
    relativePath: str
    sizeBytes: int
    uploadState: Literal["pending", "uploading", "queued", "verified", "failed", "deleted"]
    revision: int | None
    state: Literal["waiting_for_upload", "queued", "inspecting", "ready", "failed", "unsupported"]
    format: Literal["csv", "json", "jsonl"] | None
    scannedBytes: int
    acceptedRows: int
    rejectedRows: int
    totalRows: int | None
    provisional: bool
    previewedRows: int
    failureCode: str | None
    rows: list[DatasetImportPreviewRow]
    nextCursor: str | None
    mappingRevision: NotRequired[int]
    mappingHash: NotRequired[str]


class DatasetHigherLimits(TypedDict):
    action: Literal["request", "add_credits", "contact_billing_admin"]
    additionalPaidCreditUsd: NotRequired[str]


class DatasetStorageUsage(TypedDict):
    allowanceBytes: int
    retainedBytes: int
    reservedBytes: int
    availableBytes: int
    higherLimits: NotRequired[DatasetHigherLimits]


def identifier(value: object) -> str:
    if not isinstance(value, str) or value in (".", "..") or not re.fullmatch(r"[a-zA-Z0-9._:-]{1,240}", value):
        raise ProtocolError("dataset_import_identifier_invalid")
    return value


def import_path(import_id: str) -> str:
    return f"{IMPORTS}/{quote(identifier(import_id), safe='')}"


def file_path(import_id: str, file_id: str) -> str:
    return f"{import_path(import_id)}/files/{quote(identifier(file_id), safe='')}"


def begin_request(operation_id: str, files: Sequence[DatasetSourceDeclaration]) -> dict:
    if not 1 <= len(files) <= 100:
        raise ProtocolError("dataset_import_declarations_invalid")
    paths = set()
    for item in files:
        path = item["relativePath"]
        if (not isinstance(path, str) or not 1 <= len(path) <= 500 or path in paths
            or re.search(r"[\\:\x00-\x1f\x7f]", path)
            or any(segment in ("", ".", "..") for segment in path.split("/"))
            or not byte_count(item["sizeBytes"])):
            raise ProtocolError("dataset_import_declarations_invalid")
        paths.add(path)
    return {"operationId": identifier(operation_id), "files": list(files)}


def import_receipt(
    value: object,
    import_id: str | None = None,
    declarations: Sequence[DatasetSourceDeclaration] | None = None,
) -> DatasetImportReceipt:
    receipt = payload(value)
    returned_id = identifier(receipt.get("importId"))
    if import_id is not None and returned_id != import_id:
        raise ProtocolError("dataset_import_response_identity_mismatch")
    files = receipt.get("files")
    if not isinstance(files, list) or not 1 <= len(files) <= 100:
        raise ProtocolError("dataset_import_response_invalid")
    if declarations is not None:
        expected = {file["relativePath"]: file["sizeBytes"] for file in declarations}
        for entry in files:
            file = payload(entry)
            path = file.get("relativePath")
            if not isinstance(path, str) or expected.pop(path, None) != byte_count(file.get("sizeBytes")):
                raise ProtocolError("dataset_import_response_identity_mismatch")
        if expected:
            raise ProtocolError("dataset_import_response_identity_mismatch")
    return cast(DatasetImportReceipt, receipt)


def completion_receipt(value: object, parts: UploadedParts) -> DatasetImportFile:
    file = payload(value)
    if file.get("fileId") != parts.file_id or file.get("sizeBytes") != parts.source.size:
        raise ProtocolError("dataset_import_response_identity_mismatch")
    if file.get("state") == "verified" and payload(file.get("object")).get("sha256") != parts.source.digest:
        raise ProtocolError("dataset_object_hash_mismatch")
    return cast(DatasetImportFile, file)


def preview_path(import_id: str, file_id: str, revision: int | None, after: str | None, limit: int, mapping_revision: int | None) -> str:
    query: dict[str, str | int] = {"fileId": identifier(file_id), "limit": limit}
    if type(limit) is not int or not 1 <= limit <= 64:
        raise ProtocolError("dataset_preview_limit_invalid")
    if revision is not None:
        if not byte_count(revision):
            raise ProtocolError("dataset_preview_revision_invalid")
        query["revision"] = revision
    if mapping_revision is not None:
        if not byte_count(mapping_revision):
            raise ProtocolError("dataset_mapping_revision_invalid")
        query["mappingRevision"] = mapping_revision
    if after is not None:
        if revision is None or not isinstance(after, str) or not re.fullmatch(r"[1-9][0-9]{0,15}", after):
            raise ProtocolError("dataset_preview_cursor_invalid")
        byte_count(int(after))
        query["after"] = after
    return f"{import_path(import_id)}/preview?{urlencode(query)}"


def preview_receipt(value: object, import_id: str, file_id: str, revision: int | None, after: str | None, limit: int, mapping_revision: int | None) -> DatasetImportPreview:
    page = payload(value)
    if page.get("importId") != import_id or page.get("fileId") != file_id or (
        revision is not None and page.get("revision") != revision
    ):
        raise ProtocolError("dataset_import_response_identity_mismatch")
    mapping_hash = page.get("mappingHash")
    if (page.get("mappingRevision") != mapping_revision
        or (mapping_revision is None and mapping_hash is not None)
        or (mapping_revision is not None and
            (not isinstance(mapping_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", mapping_hash)))):
        raise ProtocolError("dataset_mapping_response_invalid")
    accepted = byte_count(page.get("acceptedRows"))
    rejected = byte_count(page.get("rejectedRows"))
    rows = page.get("rows")
    sample = byte_count(page.get("previewedRows"))
    provisional = page.get("state") != "ready"
    if (not isinstance(rows, list) or not len(rows) <= min(limit, sample) or not sample <= min(accepted, 64)
        or byte_count(page.get("scannedBytes")) > byte_count(page.get("sizeBytes"))
        or page.get("provisional") is not provisional
        or page.get("totalRows") != (None if provisional else accepted + rejected)):
        raise ProtocolError("dataset_preview_response_invalid")
    last = int(after) if after else 0
    for entry in rows:
        row = payload(entry)
        ordinal = byte_count(row.get("ordinal"))
        if not last < ordinal <= accepted + rejected or not isinstance(row.get("values"), dict):
            raise ProtocolError("dataset_preview_response_invalid")
        if mapping_revision is not None:
            projection = payload(row.get("projection"))
            state = projection.get("state")
            if (state not in ("mapped", "rejected", "source", "excluded")
                or (state == "mapped" and payload(projection.get("task")).get("id") != row.get("id"))):
                raise ProtocolError("dataset_mapping_response_invalid")
        last = ordinal
    cursor = page.get("nextCursor")
    if cursor is not None and (not rows or cursor != str(last)):
        raise ProtocolError("dataset_preview_response_invalid")
    return cast(DatasetImportPreview, page)


def mapping_request(operation_id: str, expected_revision: int, groups: Sequence[MappingGroup]) -> dict:
    if byte_count(expected_revision) > 128 or not 1 <= len(groups) <= 100:
        raise ProtocolError("dataset_mapping_request_invalid")
    return {"operationId": identifier(operation_id), "expectedRevision": expected_revision, "groups": list(groups)}


class DatasetImports:
    def __init__(self, transport: Transport):
        self._transport = transport

    def _request(self, method: str, path: str, body: object = None):
        return self._transport.request(method, path, body, media=MEDIA, response_limit=RESPONSE_BYTES, request_limit=2 * 1024 * 1024)

    def begin(self, *, operation_id: str, files: Sequence[DatasetSourceDeclaration]) -> DatasetImportReceipt:
        return import_receipt(self._request("POST", IMPORTS, begin_request(operation_id, files)), declarations=files)

    def get(self, import_id: str) -> DatasetImportReceipt:
        return import_receipt(self._request("GET", import_path(import_id)), import_id)

    def cancel(self, import_id: str, *, operation_id: str) -> DatasetImportReceipt:
        return import_receipt(self._request("POST", import_path(import_id) + "/cancel", {"operationId": identifier(operation_id)}), import_id)

    def storage(self) -> DatasetStorageUsage:
        return cast(DatasetStorageUsage, payload(self._request("GET", "/v1/dataset-storage")))

    def mapping(self, import_id: str) -> DatasetImportMappingReceipt | None:
        result = self._request("GET", import_path(import_id) + "/mapping")
        return None if result is None else mapping_receipt(result, import_id)

    def save_mapping(self, import_id: str, *, operation_id: str, expected_revision: int, groups: Sequence[MappingGroup]) -> DatasetImportMappingReceipt:
        body = mapping_request(operation_id, expected_revision, groups)
        result = self._request("PUT", import_path(import_id) + "/mapping", body)
        return mapping_receipt(result, import_id, expected_revision=expected_revision, groups=groups)

    def materialize(self, import_id: str, *, operation_id: str, mapping_revision: int, mapping_hash: str, allow_rejected_rows: bool = False) -> MaterializationReceipt:
        body = preparation_input(identifier(operation_id), mapping_revision, mapping_hash, allow_rejected_rows)
        receipt = materialization_receipt(self._request("POST", import_path(import_id) + "/materializations", body), import_id)
        identifier(receipt["materializationId"])
        if receipt["mappingRevision"] != mapping_revision or receipt["mappingHash"] != mapping_hash:
            raise ProtocolError("dataset_materialization_response_invalid")
        return receipt

    def materialization(self, import_id: str, materialization_id: str, *, after: str | None = None, limit: int = 20) -> MaterializationPage:
        identity = quote(identifier(materialization_id), safe="")
        path = f"{import_path(import_id)}/materializations/{identity}?{urlencode(page_query(after, limit))}"
        return materialization_page(self._request("GET", path), import_id, materialization_id, after, limit)

    def preview(self, import_id: str, file_id: str, *, revision: int | None = None, after: str | None = None, limit: int = 20, mapping_revision: int | None = None) -> DatasetImportPreview:
        path = preview_path(import_id, file_id, revision, after, limit, mapping_revision)
        return preview_receipt(self._request("GET", path), import_id, file_id, revision, after, limit, mapping_revision)

    def upload_file(self, import_id: str, file_id: str, path: str | Path, *, operation_id: str, on_progress: Progress | None = None) -> DatasetImportFile:
        """Submit verification. Reuse the same file and operation ID after interruption."""
        route = file_path(import_id, file_id)
        identifier(operation_id)
        source = FileSource.inspect(path)
        page = payload(self._request("GET", route))
        parts = UploadedParts(file_id, source, page)
        if parts.state in ("queued", "verified"):
            if on_progress is not None:
                on_progress(source.size, source.size)
            return completion_receipt(page, parts)
        while cursor := parts.observe(page):
            page = payload(self._request("GET", route + "?" + urlencode({"after": cursor})))
        if on_progress is not None:
            on_progress(parts.uploaded_bytes, source.size)
        with httpx.Client(timeout=self._transport.timeout, follow_redirects=False, trust_env=False) as storage:
            for number in parts.missing():
                start, length = parts.geometry(number)
                grant = self._request("POST", route + "/parts", {"partNumbers": [number]})
                url = signed_part(grant, file_id, number, length)
                storage.cookies.clear()
                try:
                    with storage.stream("PUT", url, headers={"Content-Length": str(length)}, content=source.chunks(start, length)) as response:
                        parts.add(number, length, transfer_etag(response))
                except (httpx.HTTPError, httpx.InvalidURL):
                    raise PonderError("dataset_storage_transfer_failed", outcome_unknown=True) from None
                if on_progress is not None:
                    on_progress(parts.uploaded_bytes, source.size)
        return completion_receipt(self._request("POST", route + "/complete", parts.completion(operation_id)), parts)


class AsyncDatasetImports:
    def __init__(self, transport: AsyncTransport):
        self._transport = transport

    async def _request(self, method: str, path: str, body: object = None):
        return await self._transport.request(method, path, body, media=MEDIA, response_limit=RESPONSE_BYTES, request_limit=2 * 1024 * 1024)

    async def begin(self, *, operation_id: str, files: Sequence[DatasetSourceDeclaration]) -> DatasetImportReceipt:
        return import_receipt(await self._request("POST", IMPORTS, begin_request(operation_id, files)), declarations=files)

    async def get(self, import_id: str) -> DatasetImportReceipt:
        return import_receipt(await self._request("GET", import_path(import_id)), import_id)

    async def cancel(self, import_id: str, *, operation_id: str) -> DatasetImportReceipt:
        return import_receipt(await self._request("POST", import_path(import_id) + "/cancel", {"operationId": identifier(operation_id)}), import_id)

    async def storage(self) -> DatasetStorageUsage:
        return cast(DatasetStorageUsage, payload(await self._request("GET", "/v1/dataset-storage")))

    async def mapping(self, import_id: str) -> DatasetImportMappingReceipt | None:
        result = await self._request("GET", import_path(import_id) + "/mapping")
        return None if result is None else mapping_receipt(result, import_id)

    async def save_mapping(self, import_id: str, *, operation_id: str, expected_revision: int, groups: Sequence[MappingGroup]) -> DatasetImportMappingReceipt:
        body = mapping_request(operation_id, expected_revision, groups)
        result = await self._request("PUT", import_path(import_id) + "/mapping", body)
        return mapping_receipt(result, import_id, expected_revision=expected_revision, groups=groups)

    async def materialize(self, import_id: str, *, operation_id: str, mapping_revision: int, mapping_hash: str, allow_rejected_rows: bool = False) -> MaterializationReceipt:
        body = preparation_input(identifier(operation_id), mapping_revision, mapping_hash, allow_rejected_rows)
        receipt = materialization_receipt(await self._request("POST", import_path(import_id) + "/materializations", body), import_id)
        identifier(receipt["materializationId"])
        if receipt["mappingRevision"] != mapping_revision or receipt["mappingHash"] != mapping_hash:
            raise ProtocolError("dataset_materialization_response_invalid")
        return receipt

    async def materialization(self, import_id: str, materialization_id: str, *, after: str | None = None, limit: int = 20) -> MaterializationPage:
        identity = quote(identifier(materialization_id), safe="")
        path = f"{import_path(import_id)}/materializations/{identity}?{urlencode(page_query(after, limit))}"
        return materialization_page(await self._request("GET", path), import_id, materialization_id, after, limit)

    async def preview(self, import_id: str, file_id: str, *, revision: int | None = None, after: str | None = None, limit: int = 20, mapping_revision: int | None = None) -> DatasetImportPreview:
        path = preview_path(import_id, file_id, revision, after, limit, mapping_revision)
        return preview_receipt(await self._request("GET", path), import_id, file_id, revision, after, limit, mapping_revision)

    async def upload_file(self, import_id: str, file_id: str, path: str | Path, *, operation_id: str, on_progress: Progress | None = None) -> DatasetImportFile:
        """Submit verification without blocking the event loop on file reads."""
        route = file_path(import_id, file_id)
        identifier(operation_id)
        source = await FileSource.inspect_async(path)
        page = payload(await self._request("GET", route))
        parts = UploadedParts(file_id, source, page)
        if parts.state in ("queued", "verified"):
            if on_progress is not None:
                on_progress(source.size, source.size)
            return completion_receipt(page, parts)
        while cursor := parts.observe(page):
            page = payload(await self._request("GET", route + "?" + urlencode({"after": cursor})))
        if on_progress is not None:
            on_progress(parts.uploaded_bytes, source.size)
        async with httpx.AsyncClient(timeout=self._transport.timeout, follow_redirects=False, trust_env=False) as storage:
            for number in parts.missing():
                start, length = parts.geometry(number)
                grant = await self._request("POST", route + "/parts", {"partNumbers": [number]})
                url = signed_part(grant, file_id, number, length)
                storage.cookies.clear()
                try:
                    async with storage.stream("PUT", url, headers={"Content-Length": str(length)}, content=source.async_chunks(start, length)) as response:
                        parts.add(number, length, transfer_etag(response))
                except (httpx.HTTPError, httpx.InvalidURL):
                    raise PonderError("dataset_storage_transfer_failed", outcome_unknown=True) from None
                if on_progress is not None:
                    on_progress(parts.uploaded_bytes, source.size)
        return completion_receipt(await self._request("POST", route + "/complete", parts.completion(operation_id)), parts)
