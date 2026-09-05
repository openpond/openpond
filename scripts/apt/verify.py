"""Verify signed indexes and package bytes before publication or acceptance."""

import argparse
import hashlib
from pathlib import Path
import tempfile

from repository import ARCHITECTURES, fields, sha256, stable_version, verified_release


def verify_repository(root):
    with tempfile.TemporaryDirectory(prefix="openpond-apt-verify-") as scratch:
        metadata = verified_release(root / "dists/stable/InRelease", root / "openpond.asc", Path(scratch))
        cleartext = (Path(scratch) / "verified-release").read_text()
        if (root / "dists/stable/Release").read_text() != cleartext:
            raise ValueError("Release differs from its signed InRelease")
    version = stable_version(metadata["X-OpenPond-Version"])
    sha_section = cleartext.split("\nSHA256:\n", 1)[1]
    # Read the indented checksum table, stopping at the next control field.
    lines = sha_section.splitlines()
    expected = {f"main/binary-{arch}/{name}" for arch in ARCHITECTURES for name in ("Packages", "Packages.gz")}
    seen = set()
    for line in lines:
        if not line.startswith(" "):
            break
        digest, size, name = line.split()
        if name not in expected:
            raise ValueError(f"Unexpected index in Release: {name}")
        source = root / "dists/stable" / name
        if sha256(source) != digest or source.stat().st_size != int(size):
            raise ValueError(f"Index checksum mismatch: {name}")
        # Clients may choose any digest advertised by apt-ftparchive.
        for algorithm in ("MD5Sum", "SHA1", "SHA256", "SHA512"):
            hash_name = "md5" if algorithm == "MD5Sum" else algorithm.lower()
            by_hash = source.parent / "by-hash" / algorithm / hashlib.new(hash_name, source.read_bytes()).hexdigest()
            if not by_hash.is_file() or sha256(by_hash) != digest:
                raise ValueError(f"Missing or corrupt by-hash index: {name}")
        seen.add(name)
    if seen != expected:
        raise ValueError("Release must index both supported architectures")
    for arch in ARCHITECTURES:
        text = (root / f"dists/stable/main/binary-{arch}/Packages").read_text()
        if len(text.strip().split("\n\n")) != 1:
            raise ValueError("Each architecture must contain exactly one package")
        package = fields(text)
        filename = f"pool/main/o/openpond/openpond_{version}_{arch}.deb"
        if (package.get("Package") != "openpond" or package.get("Version") != version
                or package.get("Architecture") != arch or package.get("Filename") != filename):
            raise ValueError("Unexpected package metadata")
        source = root / filename
        if sha256(source) != package["SHA256"] or source.stat().st_size != int(package["Size"]):
            raise ValueError(f"Package checksum mismatch: {filename}")
    return version


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repository", type=Path)
    args = parser.parse_args()
    print(f"Verified OpenPond {verify_repository(args.repository.resolve())} repository")
