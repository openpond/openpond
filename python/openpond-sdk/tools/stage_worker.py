"""Stage a verified local release candidate for native worker image builds.

This only copies local artifacts and writes their checksum receipt. It does not
publish a package, build an image, qualify a runtime or change worker versions.
"""
from __future__ import annotations

import argparse
import base64
import csv
from email.parser import BytesParser
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import tempfile
import zipfile


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def verified_wheel(candidate, expected_version, expected_manifest_sha256):
    manifest_bytes = (candidate / 'manifest.json').read_bytes()
    if sha256(manifest_bytes) != expected_manifest_sha256:
        raise ValueError('The release candidate differs from its reviewed manifest hash.')
    manifest = json.loads(manifest_bytes)
    if (manifest.get('schemaVersion') != 'openpond.pythonSdkReleaseCandidate.v1'
            or manifest.get('distribution') != 'ponder-sdk' or manifest.get('version') != expected_version
            or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', expected_version)):
        raise ValueError('The candidate differs from the reviewed package/version.')
    filename = f'ponder_sdk-{expected_version}-py3-none-any.whl'
    wheel = candidate / 'distributions' / filename
    if wheel.is_symlink() or not wheel.is_file():
        raise ValueError('The candidate wheel is unavailable.')
    content = wheel.read_bytes()
    if len(content) > 16_777_216 or manifest.get('artifacts', {}).get(filename) != sha256(content):
        raise ValueError('The candidate wheel differs from its exact release manifest.')
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        inventory = archive.infolist()
        names = [row.filename for row in inventory]
        if len(names) != len(set(names)) or len(names) > 2000 or sum(row.file_size for row in inventory) > 67_108_864:
            raise ValueError('The wheel inventory exceeds the native runtime boundary.')
        for name in names:
            path = PurePosixPath(name)
            if path.is_absolute() or '..' in path.parts or str(path) != name or '\\' in name:
                raise ValueError('The wheel contains an unsafe path.')
        if any((row.external_attr >> 16) & 0o170000 == 0o120000 for row in inventory):
            raise ValueError('The wheel contains a symbolic link.')
        info = f'ponder_sdk-{expected_version}.dist-info/'
        if any(not name.startswith(('ponder_sdk/', info)) for name in names):
            raise ValueError('The wheel contains files outside the SDK package.')
        metadata = BytesParser().parsebytes(archive.read(info + 'METADATA'))
        if metadata['Name'] != 'ponder-sdk' or metadata['Version'] != expected_version:
            raise ValueError('The wheel metadata differs from the reviewed candidate.')
        records = list(csv.reader(io.StringIO(archive.read(info + 'RECORD').decode('utf-8'))))
        if any(len(row) != 3 for row in records) or len(records) != len(names) or {row[0] for row in records} != set(names):
            raise ValueError('The wheel RECORD does not cover its complete inventory.')
        for row in records:
            if len(row) != 3:
                raise ValueError('The wheel RECORD is invalid.')
            name, digest, size = row
            if name == info + 'RECORD':
                if digest or size:
                    raise ValueError('The wheel RECORD cannot hash itself.')
                continue
            data = archive.read(name)
            expected = 'sha256=' + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip('=')
            if digest != expected or size != str(len(data)):
                raise ValueError('A packaged file differs from the wheel RECORD.')
            if name.startswith('ponder_sdk/') and manifest.get('sourceFiles', {}).get('src/' + name) != sha256(data):
                raise ValueError('A packaged file differs from the reviewed source inventory.')
        required = {'ponder_sdk/wire.py', 'ponder_sdk/schemas.json', 'ponder_sdk/reference/qwen3.py',
            'ponder_sdk/reference/generation.py', 'ponder_sdk/weight_space_programming.py',
            *[f'ponder_sdk/reference/weight_space_{name}.py' for name in ('session', 'tensors', 'code', 'patch')]}
        if not required <= set(names):
            raise ValueError('The wheel lacks the native weight-space numerical runtime.')
        receipt = {'schemaVersion': 'openpond.localPythonSdkArtifact.v1', 'package': 'ponder-sdk',
            'version': expected_version, 'artifact': filename, 'sha256': sha256(content),
            'source': 'python/openpond-sdk', 'wireSchemasSha256': sha256(archive.read('ponder_sdk/schemas.json'))}
    return content, receipt


def atomic_write(path, content):
    if path.is_symlink():
        raise ValueError('A native package destination cannot be a symbolic link.')
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
        pending = Path(temporary.name)
        try:
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
            os.replace(pending, path)
        finally:
            pending.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--expected-version', required=True)
    parser.add_argument('--expected-manifest-sha256', required=True)
    parser.add_argument('--destination', type=Path, action='append', required=True)
    args = parser.parse_args()
    content, receipt = verified_wheel(args.candidate.resolve(), args.expected_version, args.expected_manifest_sha256)
    for destination in args.destination:
        destination = destination.resolve()
        destination.mkdir(parents=True, exist_ok=True)
        # Receipt last: interrupted staging cannot authenticate different bytes.
        atomic_write(destination / receipt['artifact'], content)
        atomic_write(destination / 'python-sdk-receipt.json', (json.dumps(receipt, indent=2) + '\n').encode())
    print(json.dumps({'artifact': receipt['artifact'], 'sha256': receipt['sha256'],
        'wireSchemasSha256': receipt['wireSchemasSha256'], 'destinations': len(args.destination),
        'publication': 'NOT_ATTEMPTED', 'runtimeQualification': 'NOT_INFERRED'}))


if __name__ == '__main__':
    main()
