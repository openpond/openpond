"""Download only checksummed Debian assets from a published stable GitHub release."""

import argparse
import json
from pathlib import Path
import re

from repository import ARCHITECTURES, fields, run, sha256, stable_version


def download(tag, destination):
    version = stable_version(tag.removeprefix("v"))
    if tag != f"v{version}":
        raise ValueError("Expected a v-prefixed stable release tag")
    release = json.loads(run("gh", "api", f"repos/openpond/openpond/releases/tags/{tag}"))
    if release["draft"] or release["prerelease"] or release["tag_name"] != tag:
        raise ValueError("APT requires a published stable release")
    destination.mkdir(parents=True, exist_ok=False)
    assets = release["assets"]
    selected = [asset for asset in assets if asset["name"].endswith(".deb") or asset["name"] == "SHA256SUMS.txt"]
    if len(selected) != 3 or sum(asset["name"].endswith(".deb") for asset in selected) != 2:
        raise ValueError("Release must contain two Debian packages and SHA256SUMS.txt")
    for asset in selected:
        name = asset["name"]
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", name):
            raise ValueError("Invalid release asset filename")
        with (destination / name).open("wb") as output:
            # Stream potentially large binaries rather than buffering them in memory.
            import subprocess
            subprocess.run(["gh", "api", "-H", "Accept: application/octet-stream",
                            f"repos/openpond/openpond/releases/assets/{int(asset['id'])}"], stdout=output, check=True)
    checksums = {}
    for line in (destination / "SHA256SUMS.txt").read_text().splitlines():
        digest, name = line.split(maxsplit=1)
        name = name.removeprefix("*")
        if name in checksums or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise ValueError("Invalid release checksums")
        checksums[name] = digest
    seen = set()
    for package in destination.glob("*.deb"):
        if checksums.get(package.name) != sha256(package):
            raise ValueError(f"Release checksum mismatch: {package.name}")
        metadata = fields(run("dpkg-deb", "--field", str(package)).decode())
        arch = metadata.get("Architecture")
        if (metadata.get("Package") != "openpond" or metadata.get("Version") != version
                or arch not in ARCHITECTURES or arch in seen):
            raise ValueError("Unexpected Debian package identity")
        seen.add(arch)
    return version


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(f"Downloaded OpenPond {download(args.tag, args.output.resolve())}")
