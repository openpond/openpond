"""Portable mapping definitions for verified dataset sources."""
from __future__ import annotations

from collections.abc import Sequence
import re
from typing import Literal, TypedDict, cast

from typing_extensions import NotRequired

from .dataset_transfer_parts import byte_count, payload
from .errors import ProtocolError
from .wire import JsonValue


class MappedColumn(TypedDict):
    name: str
    path: list[str]


class FixedSplit(TypedDict):
    kind: Literal["fixed"]
    value: Literal["train", "validation", "test", "frozen_eval"]


class ColumnSplit(TypedDict):
    kind: Literal["column"]
    path: list[str]


class TaskMappingGroup(TypedDict):
    kind: Literal["tasks"]
    fileIds: list[str]
    input: list[MappedColumn]
    reference: NotRequired[list[str]]
    context: NotRequired[list[MappedColumn]]
    family: NotRequired[list[str]]
    split: FixedSplit | ColumnSplit


class SourceMappingGroup(TypedDict):
    kind: Literal["sources"]
    fileIds: list[str]


MappingGroup = TaskMappingGroup | SourceMappingGroup


class DatasetImportMappingReceipt(TypedDict):
    importId: str
    revision: int
    mappingHash: str
    groups: list[MappingGroup]


class MappedTask(TypedDict):
    state: Literal["mapped"]
    task: dict[str, JsonValue]


class RejectedTask(TypedDict):
    state: Literal["rejected"]
    code: str


class SourceProjection(TypedDict):
    state: Literal["source", "excluded"]


MappingProjection = MappedTask | RejectedTask | SourceProjection


def mapping_receipt(
    value: object,
    import_id: str,
    *,
    expected_revision: int | None = None,
    groups: Sequence[MappingGroup] | None = None,
) -> DatasetImportMappingReceipt:
    receipt = payload(value)
    revision = byte_count(receipt.get("revision"))
    digest = receipt.get("mappingHash")
    received_groups = receipt.get("groups")
    if (receipt.get("importId") != import_id or not 1 <= revision <= 128
        or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)
        or not isinstance(received_groups, list) or not 1 <= len(received_groups) <= 100
        or (expected_revision is not None and revision != expected_revision + 1)
        or (groups is not None and received_groups != list(groups))):
        raise ProtocolError("dataset_mapping_response_invalid")
    return cast(DatasetImportMappingReceipt, receipt)
