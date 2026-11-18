"""Bounded policy-visible reads of saved dataset imports."""
from __future__ import annotations

from collections.abc import Sequence
import re
from typing import Literal, TypedDict, cast
from urllib.parse import quote, urlencode

from .dataset_import_materialization import SPLITS, Split, is_digest
from .dataset_imports import identifier
from .dataset_transfer_parts import byte_count, payload
from .errors import ProtocolError
from .transport import AsyncTransport, Transport
from .wire import JsonValue


class DatasetRowSource(TypedDict):
    fileId: str
    ordinal: int


class DatasetWorkspaceRow(TypedDict):
    id: str
    split: Split
    input: dict[str, JsonValue]
    policyVisibleContext: dict[str, JsonValue]
    source: DatasetRowSource


class DatasetWorkspaceRowPage(TypedDict):
    teamId: str
    datasetId: str
    revision: int
    indexHash: str
    total: int
    rows: list[DatasetWorkspaceRow]
    nextCursor: str | None


class DatasetWorkspaceSourceFile(TypedDict):
    fileId: str
    relativePath: str
    sizeBytes: int
    sha256: str
    use: Literal["tasks", "sources"]


class DatasetWorkspaceSources(TypedDict):
    teamId: str
    datasetId: str
    revision: int
    indexHash: str
    files: list[DatasetWorkspaceSourceFile]


def _sources_path(dataset_id: str, revision: int | None, *, version: bool = False) -> str:
    workspace = f"/v1/dataset-workspaces/{quote(identifier(dataset_id), safe='')}"
    if (revision is not None and byte_count(revision) == 0) or (version and revision is None):
        raise ProtocolError("dataset_sources_query_invalid")
    if version:
        return f"{workspace}/versions/{revision}/sources"
    query = f"?{urlencode({'revision': revision})}" if revision is not None else ""
    return f"{workspace}/sources{query}"


def _sources(value: object, team_id: str, dataset_id: str, revision: int | None) -> DatasetWorkspaceSources:
    receipt = payload(value)
    files = receipt.get("files")
    if (set(receipt) != {"teamId", "datasetId", "revision", "indexHash", "files"}
        or receipt.get("teamId") != team_id or receipt.get("datasetId") != dataset_id
        or not byte_count(receipt.get("revision")) or (revision is not None and receipt.get("revision") != revision)
        or not is_digest(receipt.get("indexHash")) or not isinstance(files, list) or not 1 <= len(files) <= 100):
        raise ProtocolError("dataset_sources_response_invalid")
    identities = set()
    for value in files:
        file = payload(value)
        file_id = identifier(file.get("fileId"))
        path = file.get("relativePath")
        if (set(file) != {"fileId", "relativePath", "sizeBytes", "sha256", "use"}
            or file_id in identities or not isinstance(path, str) or not 1 <= len(path) <= 500
            or not byte_count(file.get("sizeBytes")) or not is_digest(file.get("sha256"))
            or file.get("use") not in ("tasks", "sources")):
            raise ProtocolError("dataset_sources_response_invalid")
        identities.add(file_id)
    return cast(DatasetWorkspaceSources, receipt)


def _cursor(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,240}", value) is not None


def _path(dataset_id: str, limit: int, revision: int | None, cursor: str | None, splits: Sequence[Split],
          file_id: str | None, *, version: bool = False) -> str:
    if (not 1 <= byte_count(limit) <= 100 or (revision is not None and not byte_count(revision))
        or (cursor is not None and not _cursor(cursor)) or len(splits) > 4
        or any(not isinstance(split, str) or split not in SPLITS for split in splits)):
        raise ProtocolError("dataset_rows_query_invalid")
    query: dict[str, str | int] = {"limit": limit}
    if revision is not None:
        query["revision"] = revision
    if cursor is not None:
        query["cursor"] = cursor
    if splits:
        query["split"] = ",".join(splits)
    if file_id is not None:
        query["fileId"] = identifier(file_id)
    workspace = f"/v1/dataset-workspaces/{quote(identifier(dataset_id), safe='')}"
    route = f"{workspace}/versions/{revision}/rows" if version else f"{workspace}/rows"
    return f"{route}?{urlencode(query)}"


def _page(value: object, team_id: str, dataset_id: str, limit: int, revision: int | None,
          cursor: str | None, splits: Sequence[Split], file_id: str | None) -> DatasetWorkspaceRowPage:
    page = payload(value)
    page_revision, total = byte_count(page.get("revision")), byte_count(page.get("total"))
    rows, next_cursor = page.get("rows"), page.get("nextCursor")
    if (set(page) != {"teamId", "datasetId", "revision", "indexHash", "total", "rows", "nextCursor"}
        or page.get("teamId") != team_id or page.get("datasetId") != dataset_id or page_revision == 0
        or (revision is not None and page_revision != revision) or not is_digest(page.get("indexHash"))
        or not isinstance(rows, list) or len(rows) > min(limit, total) or bool(rows) != bool(total)
        or (next_cursor is not None and (not _cursor(next_cursor) or next_cursor == cursor or len(rows) == total))):
        raise ProtocolError("dataset_rows_response_invalid")
    identities = set()
    for value in rows:
        row = payload(value)
        source = payload(row.get("source"))
        task_id, split = row.get("id"), row.get("split")
        if (set(row) != {"id", "split", "input", "policyVisibleContext", "source"}
            or not isinstance(task_id, str) or not is_digest(task_id) or task_id in identities
            or not isinstance(split, str) or split not in SPLITS or (splits and split not in splits)
            or not isinstance(row.get("input"), dict) or not isinstance(row.get("policyVisibleContext"), dict)
            or set(source) != {"fileId", "ordinal"} or not byte_count(source.get("ordinal"))
            or (file_id is not None and source.get("fileId") != file_id)):
            raise ProtocolError("dataset_rows_response_invalid")
        identifier(source.get("fileId"))
        identities.add(task_id)
    return cast(DatasetWorkspaceRowPage, page)


class DatasetRows:
    _transport: Transport
    team_id: str

    def sources(self, dataset_id: str, *, revision: int | None = None) -> DatasetWorkspaceSources:
        """List the verified originals retained by a saved dataset."""
        value = self._transport.request("GET", _sources_path(dataset_id, revision),
                                        media="application/json", response_limit=512 * 1024)
        return _sources(value, self.team_id, dataset_id, revision)

    def version_sources(self, dataset_id: str, revision: int) -> DatasetWorkspaceSources:
        """List the verified originals retained by one immutable version."""
        value = self._transport.request("GET", _sources_path(dataset_id, revision, version=True),
                                        media="application/json", response_limit=512 * 1024)
        return _sources(value, self.team_id, dataset_id, revision)

    def rows(self, dataset_id: str, *, revision: int | None = None, cursor: str | None = None,
             limit: int = 20, splits: Sequence[Split] = (), file_id: str | None = None) -> DatasetWorkspaceRowPage:
        """Read a saved import page with optional split and source-file filters."""
        path = _path(dataset_id, limit, revision, cursor, splits, file_id)
        value = self._transport.request("GET", path, media="application/json", response_limit=512 * 1024)
        return _page(value, self.team_id, dataset_id, limit, revision, cursor, splits, file_id)

    def version_rows(self, dataset_id: str, revision: int, *, cursor: str | None = None,
                     limit: int = 20, splits: Sequence[Split] = (), file_id: str | None = None) -> DatasetWorkspaceRowPage:
        """Read policy-visible rows from an immutable published revision."""
        if not byte_count(revision):
            raise ProtocolError("dataset_rows_query_invalid")
        path = _path(dataset_id, limit, revision, cursor, splits, file_id, version=True)
        value = self._transport.request("GET", path, media="application/json", response_limit=512 * 1024)
        return _page(value, self.team_id, dataset_id, limit, revision, cursor, splits, file_id)


class AsyncDatasetRows:
    _transport: AsyncTransport
    team_id: str

    async def sources(self, dataset_id: str, *, revision: int | None = None) -> DatasetWorkspaceSources:
        """List the verified originals retained by a saved dataset."""
        value = await self._transport.request("GET", _sources_path(dataset_id, revision),
                                              media="application/json", response_limit=512 * 1024)
        return _sources(value, self.team_id, dataset_id, revision)

    async def version_sources(self, dataset_id: str, revision: int) -> DatasetWorkspaceSources:
        """List the verified originals retained by one immutable version."""
        value = await self._transport.request("GET", _sources_path(dataset_id, revision, version=True),
                                              media="application/json", response_limit=512 * 1024)
        return _sources(value, self.team_id, dataset_id, revision)

    async def rows(self, dataset_id: str, *, revision: int | None = None, cursor: str | None = None,
                   limit: int = 20, splits: Sequence[Split] = (), file_id: str | None = None) -> DatasetWorkspaceRowPage:
        """Read a saved import page with optional split and source-file filters."""
        path = _path(dataset_id, limit, revision, cursor, splits, file_id)
        value = await self._transport.request("GET", path, media="application/json", response_limit=512 * 1024)
        return _page(value, self.team_id, dataset_id, limit, revision, cursor, splits, file_id)

    async def version_rows(self, dataset_id: str, revision: int, *, cursor: str | None = None,
                           limit: int = 20, splits: Sequence[Split] = (), file_id: str | None = None) -> DatasetWorkspaceRowPage:
        """Read policy-visible rows from an immutable published revision."""
        if not byte_count(revision):
            raise ProtocolError("dataset_rows_query_invalid")
        path = _path(dataset_id, limit, revision, cursor, splits, file_id, version=True)
        value = await self._transport.request("GET", path, media="application/json", response_limit=512 * 1024)
        return _page(value, self.team_id, dataset_id, limit, revision, cursor, splits, file_id)
