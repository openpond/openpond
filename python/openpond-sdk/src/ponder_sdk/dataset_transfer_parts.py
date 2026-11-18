"""Bounded part transfer with a dedicated, credential-free HTTP transport."""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from hashlib import sha256
from os import fstat
from pathlib import Path
import re
from threading import Event
from urllib.parse import urlsplit

import httpx

from .errors import PonderError, ProtocolError

CHUNK_BYTES = 1024 * 1024
MAX_PARTS = 10_000


def payload(value: object) -> dict:
    if not isinstance(value, dict):
        raise ProtocolError("dataset_import_response_invalid")
    return value


def byte_count(value: object) -> int:
    if type(value) is not int or not 0 <= value <= 2**53 - 1:
        raise ProtocolError("dataset_import_response_invalid")
    return value


def etag(value: object) -> str:
    if not isinstance(value, str) or not re.fullmatch(r'"[^"\s\x00-\x1f\x7f]{1,128}"', value):
        raise ProtocolError("dataset_upload_part_invalid")
    return value


def file_fingerprint(file) -> tuple[int, ...]:
    info = fstat(file.fileno())
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


@dataclass(frozen=True)
class FileSource:
    path: Path
    size: int
    digest: str
    fingerprint: tuple[int, ...]

    @classmethod
    def inspect(cls, path: str | Path, stop: Event | None = None) -> FileSource:
        source = Path(path)
        digest = sha256()
        try:
            if not source.is_file():
                raise ProtocolError("dataset_source_unreadable")
            with source.open("rb") as file:
                fingerprint = file_fingerprint(file)
                size = fingerprint[2]
                byte_count(size)
                if not size:
                    raise ProtocolError("dataset_source_empty")
                remaining = size
                while remaining > 0:
                    if stop is not None and stop.is_set():
                        raise ProtocolError("dataset_source_cancelled")
                    chunk = file.read(min(remaining, CHUNK_BYTES))
                    if not chunk:
                        raise ProtocolError("dataset_source_changed")
                    digest.update(chunk)
                    remaining -= len(chunk)
                if file_fingerprint(file) != fingerprint:
                    raise ProtocolError("dataset_source_changed")
        except OSError:
            raise ProtocolError("dataset_source_unreadable") from None
        return cls(source, size, digest.hexdigest(), fingerprint)

    @classmethod
    async def inspect_async(cls, path: str | Path) -> FileSource:
        stop = Event()
        try:
            return await asyncio.to_thread(cls.inspect, path, stop)
        finally:
            stop.set()

    def read(self, offset: int, length: int) -> bytes:
        try:
            with self.path.open("rb") as file:
                if file_fingerprint(file) != self.fingerprint:
                    raise ProtocolError("dataset_source_changed")
                file.seek(offset)
                data = file.read(length)
                if len(data) != length or file_fingerprint(file) != self.fingerprint:
                    raise ProtocolError("dataset_source_changed")
                return data
        except OSError:
            raise ProtocolError("dataset_source_unreadable") from None

    def chunks(self, offset: int, length: int) -> Iterator[bytes]:
        for start in range(offset, offset + length, CHUNK_BYTES):
            yield self.read(start, min(CHUNK_BYTES, offset + length - start))

    async def async_chunks(self, offset: int, length: int) -> AsyncIterator[bytes]:
        for start in range(offset, offset + length, CHUNK_BYTES):
            yield await asyncio.to_thread(self.read, start, min(CHUNK_BYTES, offset + length - start))


class UploadedParts:
    def __init__(self, file_id: str, source: FileSource, page: dict):
        self.file_id = file_id
        self.source = source
        self.part_size = byte_count(page.get("partSize"))
        self.state = page.get("state")
        self.received: dict[int, str] = {}
        self.uploaded_bytes = 0
        self.cursor = 0
        if not self.part_size or page.get("sizeBytes") != source.size:
            raise ProtocolError("dataset_source_size_mismatch")
        self.part_count = (source.size + self.part_size - 1) // self.part_size
        if self.part_count > MAX_PARTS:
            raise ProtocolError("dataset_upload_part_invalid")
        if self.state == "verified":
            if payload(page.get("object")).get("sha256") != source.digest:
                raise ProtocolError("dataset_object_hash_mismatch")
        elif self.state not in ("pending", "uploading", "queued"):
            raise ProtocolError("dataset_import_conflict")

    def geometry(self, number: int) -> tuple[int, int]:
        if not 1 <= number <= self.part_count:
            raise ProtocolError("dataset_upload_part_invalid")
        start = (number - 1) * self.part_size
        return start, min(self.part_size, self.source.size - start)

    def add(self, number: int, size: int, tag: object) -> None:
        if number in self.received or self.geometry(number)[1] != size:
            raise ProtocolError("dataset_upload_part_invalid")
        self.received[number] = etag(tag)
        self.uploaded_bytes += size

    def observe(self, page: dict) -> str | None:
        if (page.get("fileId"), page.get("sizeBytes"), page.get("partSize"), page.get("state")) != (
            self.file_id, self.source.size, self.part_size, self.state,
        ):
            raise ProtocolError("dataset_import_response_identity_mismatch")
        parts = page.get("parts")
        if not isinstance(parts, list) or len(parts) > 100 or "nextCursor" not in page:
            raise ProtocolError("dataset_import_response_invalid")
        for entry in parts:
            part = payload(entry)
            self.add(byte_count(part.get("partNumber")), byte_count(part.get("sizeBytes")), part.get("etag"))
        next_cursor = page["nextCursor"]
        if next_cursor is not None:
            if (not isinstance(next_cursor, str) or not re.fullmatch(r"[1-9][0-9]{0,4}", next_cursor)
                or not self.cursor < int(next_cursor) <= self.part_count):
                raise ProtocolError("dataset_upload_cursor_invalid")
            self.cursor = int(next_cursor)
        return next_cursor

    def missing(self) -> Iterator[int]:
        return (number for number in range(1, self.part_count + 1) if number not in self.received)

    def completion(self, operation_id: str) -> dict:
        return {
            "operationId": operation_id,
            "sha256": self.source.digest,
            "parts": [{"partNumber": i, "etag": self.received[i]} for i in range(1, self.part_count + 1)],
        }


def signed_part(grant: object, file_id: str, number: int, length: int) -> str:
    receipt = payload(grant)
    parts = receipt.get("parts")
    if receipt.get("fileId") != file_id or not isinstance(parts, list) or len(parts) != 1:
        raise ProtocolError("dataset_import_response_identity_mismatch")
    part = payload(parts[0])
    if (part.get("partNumber"), part.get("sizeBytes"), part.get("headers")) != (
        number, length, {"content-length": str(length)},
    ):
        raise ProtocolError("dataset_upload_part_invalid")
    url = part.get("url")
    if not isinstance(url, str) or len(url) > 8192:
        raise ProtocolError("dataset_upload_part_invalid")
    try:
        parsed = urlsplit(url)
        parsed.port
    except ValueError:
        raise ProtocolError("dataset_upload_part_invalid") from None
    if (not parsed.hostname or parsed.username or parsed.password or parsed.fragment or
        (parsed.scheme != "https" and (parsed.scheme != "http" or
         parsed.hostname not in ("localhost", "127.0.0.1", "::1")))):
        raise ProtocolError("dataset_upload_part_invalid")
    return url


def transfer_etag(response: httpx.Response) -> str:
    if not response.is_success or not response.headers.get("etag"):
        raise PonderError(
            "dataset_storage_transfer_failed",
            status=502 if response.is_success else response.status_code,
            outcome_unknown=True,
        )
    return etag(response.headers["etag"])
