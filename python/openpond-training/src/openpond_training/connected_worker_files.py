"""Content hashing and safe local file access for connected workers."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import stat
from typing import Any
from urllib.parse import urlparse
from urllib.request import url2pathname


def content_hash(value: Any) -> str:
    canonical = json.dumps(
        value, sort_keys=True, ensure_ascii=False, indent=2
    ) + "\n"
    return hashlib.sha256(canonical.encode()).hexdigest()


def path_from_file_ref(object_ref: str) -> Path:
    parsed = urlparse(object_ref)
    if (
        parsed.scheme != "file"
        or parsed.netloc not in {"", "localhost"}
        or not parsed.path
    ):
        raise ValueError("connected_worker_file_ref_invalid")
    return Path(url2pathname(parsed.path))


def read_regular_file(path: Path) -> bytes:
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
