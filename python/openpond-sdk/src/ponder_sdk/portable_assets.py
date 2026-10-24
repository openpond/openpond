"""Validate byte closure and visibility without inventing Harness locale hashes.

Outer Harness/Learning seals are retained declarations authenticated by the host;
this module deliberately does not call compact training canonical_sha256 on them.
"""
from __future__ import annotations
import base64
import binascii
import hashlib
from typing import Any
from .errors import ProtocolError


def harness_source(source: dict[str,Any], reference: dict[str,str], *, publishing: bool = False) -> dict[str,Any]:
    release=source['harnessRelease'];agent=source['agentSnapshot']
    if {'id':release['id'],'contentHash':release['contentHash']}!=reference or release['agentSnapshot']!={'id':agent['id'],'contentHash':agent['contentHash']}:
        raise ProtocolError('harness_reference_mismatch')
    assets={};identities=set()
    for asset in release['files']:
        path=asset['path']
        if path.startswith('/') or any(part in ('','.','..') for part in path.split('/')) or any(c in path for c in ('\\',':','\0')):raise ProtocolError('invalid_portable_path')
        if path in assets or asset['id'] in identities:raise ProtocolError('duplicate_harness_asset')
        assets[path]=asset;identities.add(asset['id'])
    dependencies=[release['program'],agent['dependencyLock'],*agent['instructions'],*agent['skills'],*agent['agents']]
    if any(assets.get(asset['path'])!=asset for asset in dependencies):raise ProtocolError('harness_dependency_mismatch')
    policy=source['schemaVersion']=='openpond.harnessPolicySourcePackage.v1'
    if policy and any(asset['visibility']!='policy' for asset in [release['program'],agent['dependencyLock'],*agent['instructions'],*agent['skills']]):raise ProtocolError('private_harness_dependency')
    if publishing:
        portability=agent['portability']
        if not portability['portable'] or portability['blockers'] or portability['localOnlyAssetRefs'] or portability['hostPrivateAssetRefs'] or not policy and any(asset['visibility']!='policy' for asset in release['files']):raise ProtocolError('harness_not_portable')
    expected={path for path,asset in assets.items() if not policy or asset['visibility']=='policy'}
    paths=set();total=0
    for item in source['files']:
        path=item['path']
        if path in paths or path not in expected:raise ProtocolError('harness_file_visibility_mismatch')
        paths.add(path)
        try:raw=base64.b64decode(item['base64'],validate=True)
        except (ValueError,binascii.Error):raise ProtocolError('invalid_harness_file_encoding') from None
        total+=len(raw);asset=assets[path]
        if total>67108864 or len(raw)!=asset['sizeBytes'] or hashlib.sha256(raw).hexdigest()!=asset['contentHash']:raise ProtocolError('harness_file_integrity_mismatch')
    if paths!=expected:raise ProtocolError('harness_file_closure_mismatch')
    return source
