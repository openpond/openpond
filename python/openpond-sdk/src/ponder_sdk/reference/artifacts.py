"""Bounded canonical metadata and safetensors reads for downloaded modifications."""
from __future__ import annotations

import hashlib
import asyncio
import json
import math
from pathlib import Path
import struct
import threading
from typing import Any, Callable

from ..errors import ProtocolError
from ..wire import canonical_json, canonical_sha256

Check = Callable[[], None]


def execution_owner():
    """A thread alone cannot distinguish asyncio tasks on that thread."""
    try:
        task = asyncio.current_task()
    except RuntimeError:
        task = None
    return threading.get_ident(), task


def require(condition: Any, reason: str) -> None:
    if not condition:
        raise ProtocolError('portable_' + reason)


def unique_json(raw: bytes) -> Any:
    def pairs(rows):
        result = {}
        for name, value in rows:
            require(name not in result, 'duplicate_json_key')
            result[name] = value
        return result
    def invalid(_):
        raise ProtocolError('portable_nonfinite_json')
    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid)
    except (ValueError, UnicodeError, RecursionError) as error:
        raise ProtocolError('portable_invalid_json') from error


def file_hash(path: Path, check: Check = lambda: None) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        while chunk := handle.read(8 * 1024 * 1024):
            check()
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path, maximum: int = 262_144) -> Any:
    require(path.is_file() and not path.is_symlink() and 0 < path.stat().st_size <= maximum, 'metadata_file')
    return unique_json(path.read_bytes())


def artifact_root(directory, filenames: set[str], maximum_bytes: int) -> Path:
    root = Path(directory)
    require(root.is_dir() and not root.is_symlink() and {p.name for p in root.iterdir()} == filenames, 'artifact_files')
    require(type(maximum_bytes) is int and maximum_bytes > 0, 'artifact_budget')
    require(all((root / name).is_file() and not (root / name).is_symlink() for name in filenames), 'artifact_file_type')
    require(sum((root / name).stat().st_size for name in filenames) <= maximum_bytes, 'artifact_budget')
    return root


def sealed_manifest(root: Path, expected_content_hash: str) -> dict[str, Any]:
    path = root / 'manifest.json'
    value = read_json(path)
    require(type(value) is dict and value.get('contentHash') == expected_content_hash
            == canonical_sha256({k: v for k, v in value.items() if k != 'contentHash'}), 'artifact_identity')
    require(path.read_bytes() == canonical_json(value).encode(), 'manifest_not_canonical')
    return value


def tensors(path: Path, descriptor: dict[str, Any], *, check: Check = lambda: None,
            metadata: dict[str, str] | None = None, maximum_header: int = 262_144,
            retain: bool = True) -> dict[str, Any]:
    """Validate the entire file before exposing tensors; never load torch pickle.

    Large continuation-state tensors can be checked in bounded CPU slices without
    retaining them. Their bytes are verified even when inference needs only patch.
    """
    require(path.name == descriptor['path'] and path.is_file() and not path.is_symlink()
            and path.stat().st_size == descriptor['sizeBytes'] and path.stat().st_size > 8, 'payload_file')
    require(file_hash(path, check) == descriptor['sha256'], 'payload_hash')
    with path.open('rb') as handle:
        length = struct.unpack('<Q', handle.read(8))[0]
        require(0 < length <= maximum_header and length + 8 < path.stat().st_size, 'tensor_header_size')
        header = unique_json(handle.read(length))
    require(type(header) is dict, 'tensor_header')
    observed_metadata = header.pop('__metadata__', None)
    if metadata is not None:
        require(observed_metadata == metadata, 'tensor_metadata')
    else:
        require(observed_metadata is None or type(observed_metadata) is dict
                and all(type(k) is str and type(v) is str for k, v in observed_metadata.items()), 'tensor_metadata')
    inventory = descriptor['tensors']
    require(len({row['name'] for row in inventory}) == len(inventory)
            and set(header) == {row['name'] for row in inventory}, 'tensor_inventory')
    sizes = {'F32': 4, 'BF16': 2, 'I64': 8, 'BOOL': 1}
    intervals = []
    for row in inventory:
        check()
        actual = header[row['name']]
        require(row['dtype'] in sizes and type(actual) is dict and set(actual) == {'dtype', 'shape', 'data_offsets'}
                and actual['dtype'] == row['dtype'] and actual['shape'] == row['shape'], 'tensor_geometry')
        offsets = actual['data_offsets']
        require(type(offsets) is list and len(offsets) == 2 and all(type(v) is int for v in offsets)
                and offsets[0] >= 0 and offsets[1] - offsets[0] == math.prod(row['shape']) * sizes[row['dtype']], 'tensor_offsets')
        intervals.append(offsets)
    end = 0
    for start, stop in sorted(intervals):
        require(start == end, 'tensor_offsets_overlap')
        end = stop
    require(8 + length + end == path.stat().st_size, 'tensor_extra_bytes')
    import torch
    from safetensors import safe_open
    result = {}
    dtypes = {'F32': torch.float32, 'BF16': torch.bfloat16, 'I64': torch.int64, 'BOOL': torch.bool}
    with safe_open(str(path), framework='pt', device='cpu') as handle:
        for row in inventory:
            check()
            if retain:
                tensor = handle.get_tensor(row['name'])
                require(tensor.dtype == dtypes[row['dtype']] and list(tensor.shape) == row['shape'], 'tensor_geometry')
                if tensor.is_floating_point():
                    for chunk in tensor.split(256):
                        check(); require(bool(torch.isfinite(chunk).all()), 'tensor_nonfinite')
                result[row['name']] = tensor.clone()
            elif row['dtype'] in ('F32', 'BF16'):
                view = handle.get_slice(row['name'])
                for start in range(0, row['shape'][0], 256):
                    check(); require(bool(torch.isfinite(view[start:start + 256]).all()), 'tensor_nonfinite')
    require(file_hash(path, check) == descriptor['sha256'], 'payload_changed')
    return result
