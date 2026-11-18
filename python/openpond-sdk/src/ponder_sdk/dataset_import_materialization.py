"""Receipts and bounded shard index pages for prepared dataset imports."""
from __future__ import annotations

import re
from typing import Literal, TypedDict, cast

from .dataset_transfer_parts import byte_count, payload
from .errors import ProtocolError

Split = Literal["train", "validation", "test", "frozen_eval"]
SPLITS = {"train", "validation", "test", "frozen_eval"}


class MaterializationReceipt(TypedDict):
    importId: str
    materializationId: str
    mappingRevision: int
    mappingHash: str
    state: Literal["queued", "processing", "paused", "ready", "failed"]
    acceptedRows: int
    rejectedRows: int
    shardCount: int
    splitCounts: dict[Split, int] | None
    indexHash: str | None
    failureCode: str | None


class MaterializedShard(TypedDict):
    objectId: str
    fileId: str
    ordinal: int
    split: Split
    sha256: str
    sizeBytes: int
    rowCount: int
    rowGroupCount: int


class MaterializationPage(MaterializationReceipt):
    shards: list[MaterializedShard]
    nextCursor: str | None


class DatasetImportDraftReceipt(TypedDict):
    importId: str
    datasetId: str
    revision: int
    workspaceHash: str
    materializationId: str
    mappingRevision: int
    mappingHash: str
    indexHash: str
    acceptedRows: int
    rejectedRows: int
    shardCount: int


def is_digest(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def preparation_input(operation_id: str, revision: int, mapping_hash: str, allow_rejected: bool) -> dict:
    if not 1 <= byte_count(revision) <= 128 or not is_digest(mapping_hash) or type(allow_rejected) is not bool:
        raise ProtocolError("dataset_materialization_request_invalid")
    return {"operationId": operation_id, "mappingRevision": revision,
            "mappingHash": mapping_hash, "allowRejectedRows": allow_rejected}


def finish_input(operation_id: str, name: str, materialization_id: str, revision: int,
                 mapping_hash: str, index_hash: str, owner_scope: str) -> dict:
    if (not isinstance(name, str) or re.search(r"[\x00\ud800-\udfff]", name) is not None
        or not 1 <= len(name.strip().encode("utf-16-le")) // 2 <= 500
        or not 1 <= byte_count(revision) <= 128 or not is_digest(mapping_hash)
        or not is_digest(index_hash) or owner_scope not in ("personal", "workspace")):
        raise ProtocolError("dataset_finish_request_invalid")
    return {"operationId": operation_id, "name": name.strip(), "materializationId": materialization_id,
            "mappingRevision": revision, "mappingHash": mapping_hash, "indexHash": index_hash,
            "ownerScope": owner_scope}


def finished_draft(value: object, import_id: str, request: dict) -> DatasetImportDraftReceipt:
    receipt = payload(value)
    if (receipt.get("importId") != import_id or not is_digest(receipt.get("workspaceHash")) or
        byte_count(receipt.get("revision")) == 0 or
        not isinstance(receipt.get("datasetId"), str) or
        not re.fullmatch(r"[a-zA-Z0-9._:-]{1,240}", receipt["datasetId"]) or
        not 1 <= byte_count(receipt.get("mappingRevision")) <= 128 or
        any(receipt.get(field) != request[field]
            for field in ("materializationId", "mappingRevision", "mappingHash", "indexHash"))):
        raise ProtocolError("dataset_finish_response_invalid")
    for field in ("acceptedRows", "rejectedRows", "shardCount"):
        byte_count(receipt.get(field))
    return cast(DatasetImportDraftReceipt, receipt)


def materialization_receipt(value: object, import_id: str) -> MaterializationReceipt:
    receipt = payload(value)
    revision = byte_count(receipt.get("mappingRevision"))
    state = receipt.get("state")
    count = byte_count(receipt.get("acceptedRows"))
    byte_count(receipt.get("rejectedRows"))
    byte_count(receipt.get("shardCount"))
    if (receipt.get("importId") != import_id or not 1 <= revision <= 128 or
        not is_digest(receipt.get("mappingHash")) or
        state not in ("queued", "processing", "paused", "ready", "failed")):
        raise ProtocolError("dataset_materialization_response_invalid")
    splits = receipt.get("splitCounts")
    seal = receipt.get("indexHash")
    if state == "ready":
        if (not is_digest(seal) or not isinstance(splits, dict) or set(splits) != SPLITS or
            sum(byte_count(value) for value in splits.values()) != count):
            raise ProtocolError("dataset_materialization_response_invalid")
    elif splits is not None or seal is not None:
        raise ProtocolError("dataset_materialization_response_invalid")
    return cast(MaterializationReceipt, receipt)


def page_query(after: str | None, limit: int) -> dict[str, str | int]:
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ProtocolError("dataset_materialization_page_invalid")
    query: dict[str, str | int] = {"limit": limit}
    if after is not None:
        if not isinstance(after, str) or not re.fullmatch(r"[1-9][0-9]{0,15}", after):
            raise ProtocolError("dataset_materialization_page_invalid")
        byte_count(int(after))
        query["after"] = after
    return query


def materialization_page(value: object, import_id: str, materialization_id: str, after: str | None, limit: int) -> MaterializationPage:
    status = materialization_receipt(value, import_id)
    page = payload(value)
    shards = page.get("shards")
    cursor = page.get("nextCursor")
    if (status["materializationId"] != materialization_id or not isinstance(shards, list)
        or len(shards) > limit or (status["state"] != "ready" and (shards or cursor is not None))):
        raise ProtocolError("dataset_materialization_page_invalid")
    last = int(after) if after else 0
    for entry in shards:
        shard = payload(entry)
        last += 1
        split = shard.get("split")
        if (shard.get("ordinal") != last or last > status["shardCount"]
            or not isinstance(split, str) or split not in SPLITS
            or not is_digest(shard.get("sha256")) or not byte_count(shard.get("sizeBytes"))
            or not byte_count(shard.get("rowCount")) or not byte_count(shard.get("rowGroupCount"))):
            raise ProtocolError("dataset_materialization_page_invalid")
    if cursor is not None and (not shards or cursor != str(last)):
        raise ProtocolError("dataset_materialization_page_invalid")
    return cast(MaterializationPage, page)
