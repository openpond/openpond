"""Publish an APT snapshot to R2, committing InRelease only after its dependencies."""

import argparse
import json
from pathlib import Path
import re
import subprocess
import tempfile

from repository import run, sha256, stable_version, verified_release
from verify import verify_repository


class R2:
    def __init__(self, bucket, endpoint):
        if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket):
            raise ValueError("Invalid R2 bucket name")
        if not re.fullmatch(r"https://[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com", endpoint):
            raise ValueError("Expected the account's HTTPS R2 S3 endpoint")
        self.prefix = ["aws", "--endpoint-url", endpoint, "--region", "auto", "s3api"]
        self.bucket = bucket

    def exists(self, key):
        # Listing distinguishes a missing object from auth/network failures.
        result = json.loads(run(*self.prefix, "list-objects-v2", "--bucket", self.bucket,
                                "--prefix", key, "--max-keys", "1"))
        return any(item["Key"] == key for item in result.get("Contents", []))

    def get(self, key, output):
        if not self.exists(key):
            return False
        run(*self.prefix, "get-object", "--bucket", self.bucket, "--key", key, str(output))
        return True

    def put(self, key, source, immutable):
        digest = sha256(source)
        if immutable and self.exists(key):
            result = json.loads(run(*self.prefix, "head-object", "--bucket", self.bucket, "--key", key))
            if result.get("Metadata", {}).get("sha256") != digest:
                raise ValueError(f"Refusing to overwrite immutable object {key}")
            return
        cache = "public,max-age=31536000,immutable" if immutable else "no-cache,max-age=0,must-revalidate"
        content_type = "application/vnd.debian.binary-package" if key.endswith(".deb") else (
            "application/gzip" if key.endswith(".gz") else "text/plain")
        args = [*self.prefix, "put-object", "--bucket", self.bucket, "--key", key,
                "--body", str(source), "--metadata", json.dumps({"sha256": digest}),
                "--cache-control", cache, "--content-type", content_type]
        if immutable:
            args.extend(["--if-none-match", "*"])
        run(*args)


def publish_repository(root, store):
    version = verify_repository(root)
    with tempfile.TemporaryDirectory(prefix="openpond-apt-publish-") as scratch:
        scratch = Path(scratch)
        old_signed = scratch / "previous-InRelease"
        if store.get("dists/stable/InRelease", old_signed):
            old_dir = scratch / "old"
            old_dir.mkdir()
            previous = verified_release(old_signed, root / "openpond.asc", old_dir)
            old_version = stable_version(previous["X-OpenPond-Version"])
            if subprocess.run(["dpkg", "--compare-versions", version, "lt", old_version]).returncode == 0:
                raise ValueError(f"Refusing to downgrade APT from {old_version} to {version}")
        # No deletions: keep previous .debs and by-hash indexes. Publish only the
        # signed InRelease as the final commit point for modern APT clients.
        files = sorted(path for path in root.rglob("*") if path.is_file())
        mutable = {"dists/stable/InRelease", "dists/stable/Release", "dists/stable/Release.gpg"}
        for source in files:
            key = source.relative_to(root).as_posix()
            if key in mutable:
                continue
            store.put(key, source, immutable=key.startswith("pool/") or "/by-hash/" in key or key == "openpond.asc")
        # Preserve a complete copy of each signed manifest for diagnosis/recovery.
        for name in ("Release", "Release.gpg", "InRelease"):
            source = root / "dists/stable" / name
            store.put(f"snapshots/{version}/{sha256(root / 'dists/stable/InRelease')}/{name}", source, immutable=True)
        for name in ("Release", "Release.gpg", "InRelease"):
            store.put(f"dists/stable/{name}", root / "dists/stable" / name, immutable=False)
    print(f"Published OpenPond {version} to APT")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--endpoint", required=True)
    args = parser.parse_args()
    publish_repository(args.repository.resolve(), R2(args.bucket, args.endpoint))
