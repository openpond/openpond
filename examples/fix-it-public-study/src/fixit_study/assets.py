"""Fetch immutable upstream text assets; never download published trajectories."""

from __future__ import annotations

import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from importlib.resources import files
from pathlib import Path, PurePosixPath
from urllib.request import urlopen

from .plan import SOURCE_COMMIT


def fetch_data(destination: Path) -> dict:
    manifest_bytes = files("fixit_study").joinpath("assets.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    if manifest.get("commit") != SOURCE_COMMIT:
        raise ValueError("The asset manifest belongs to a different upstream commit")
    if manifest["commit"] != SOURCE_COMMIT:
        raise ValueError("Asset manifest and dependency source do not match")
    destination.mkdir(parents=True, exist_ok=True)

    def fetch(asset: dict) -> dict:
        source = PurePosixPath(asset["path"])
        if ".." in source.parts or source.is_absolute() or source.parts[:2] != ("data", "tau2"):
            raise ValueError("Invalid upstream asset path")
        relative = source.relative_to("data")
        target = destination.joinpath(*relative.parts)
        if target.exists():
            data = target.read_bytes()
        else:
            with urlopen(f"https://raw.githubusercontent.com/sierra-research/tau2-bench/{SOURCE_COMMIT}/{source}", timeout=60) as response:
                data = response.read(asset["sizeBytes"] + 1)
        if len(data) != asset["sizeBytes"]:
            raise ValueError(f"Upstream asset size mismatch: {source}")
        blob = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
        if blob != asset["gitBlob"]:
            raise ValueError(f"Upstream asset content changed: {source}")
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            # Exclusive create preserves a different fetcher's or author's file.
            with target.open("xb") as output:
                output.write(data)
        return {"path": str(relative), "sha256": hashlib.sha256(data).hexdigest(), "sizeBytes": len(data)}

    with ThreadPoolExecutor(max_workers=4) as pool:
        assets = list(pool.map(fetch, manifest["assets"]))
    receipt = {"schemaVersion": "openpond.fixitPublicStudyAssets.v1", "sourceCommit": SOURCE_COMMIT, "assets": assets}
    receipt_bytes = (json.dumps(receipt, indent=2) + "\n").encode()
    (destination / "fixit-assets.json").write_bytes(receipt_bytes)
    return {"files": len(assets), "bytes": sum(asset["sizeBytes"] for asset in assets),
            "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
            "receiptSha256": hashlib.sha256(receipt_bytes).hexdigest(), "inferenceExecuted": False}
