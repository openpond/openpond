"""Build a signed, stateless APT snapshot from one complete stable release."""

import argparse
import gzip
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess

ARCHITECTURES = ("amd64", "arm64")


def run(*args, **kwargs):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, **kwargs).stdout


def sha256(path):
    with path.open("rb") as stream:
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
        return digest.hexdigest()


def stable_version(version):
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version):
        raise ValueError(f"Expected a stable version, received {version!r}")
    return version


def fingerprint(value):
    if not re.fullmatch(r"[A-F0-9]{40}|[A-F0-9]{64}", value):
        raise ValueError("APT_SIGNING_FINGERPRINT must be a full uppercase fingerprint")
    return value


def fields(document):
    return dict(line.split(": ", 1) for line in document.splitlines()
                if line and not line[0].isspace() and ": " in line)


def verified_release(signed, public_key, directory):
    keyring = directory / "keyring.gpg"
    # gpgv must trust only our supplied key, never a machine-wide keyring.
    keyring.write_bytes(run("gpg", "--batch", "--yes", "--output", "-", "--dearmor", str(public_key)))
    cleartext = directory / "verified-release"
    run("gpgv", "--homedir", str(directory), "--keyring", str(keyring),
        "--output", str(cleartext), str(signed))
    return fields(cleartext.read_text())


def build_repository(assets, output, version, signing_fingerprint):
    stable_version(version)
    fingerprint(signing_fingerprint)
    packages = {}
    for source in sorted(assets.glob("*.deb")):
        metadata = fields(run("dpkg-deb", "--field", str(source)).decode())
        arch = metadata.get("Architecture")
        if (metadata.get("Package") != "openpond" or metadata.get("Version") != version
                or arch not in ARCHITECTURES or arch in packages):
            raise ValueError(f"Unexpected or duplicate release package: {source.name}")
        packages[arch] = source
    if set(packages) != set(ARCHITECTURES):
        raise ValueError("A stable APT release requires exactly one amd64 and one arm64 package")
    # Never mix a new release with files left by an earlier invocation.
    output.mkdir(parents=True, exist_ok=False)
    pool = output / "pool/main/o/openpond"
    pool.mkdir(parents=True)
    for arch, source in packages.items():
        shutil.copyfile(source, pool / f"openpond_{version}_{arch}.deb")
    release_dir = output / "dists/stable"
    for arch in ARCHITECTURES:
        index_dir = release_dir / f"main/binary-{arch}"
        index_dir.mkdir(parents=True)
        # Generate from each .deb separately: apt-ftparchive's architecture filter
        # is not intended to filter arbitrary package-directory scans.
        package = pool / f"openpond_{version}_{arch}.deb"
        index = run("apt-ftparchive", "packages", str(package.relative_to(output)), cwd=output)
        (index_dir / "Packages").write_bytes(index)
        (index_dir / "Packages.gz").write_bytes(gzip.compress(index, mtime=0))
    options = {
        "Origin": "OpenPond", "Label": "OpenPond", "Suite": "stable", "Codename": "stable",
        "Architectures": " ".join(ARCHITECTURES), "Components": "main", "Acquire-By-Hash": "yes",
        "Description": "OpenPond stable desktop releases",
    }
    args = ["apt-ftparchive"]
    for name, value in options.items():
        args.extend(["-o", f"APT::FTPArchive::Release::{name}={value}"])
    release = run(*args, "release", ".", cwd=release_dir)
    release += f"X-OpenPond-Version: {version}\n".encode()
    # APT can prefer any advertised digest. Preserve all index digest paths so
    # clients using the previous InRelease can finish while a release is uploaded.
    for index in release_dir.glob("main/binary-*/Packages*"):
        for algorithm in ("MD5Sum", "SHA1", "SHA256", "SHA512"):
            hash_name = "md5" if algorithm == "MD5Sum" else algorithm.lower()
            digest = hashlib.new(hash_name, index.read_bytes()).hexdigest()
            destination = index.parent / "by-hash" / algorithm / digest
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(index, destination)
    (release_dir / "Release").write_bytes(release)
    passphrase = os.environ.get("APT_SIGNING_PASSPHRASE", "").encode() + b"\n"
    for name, operation in (("InRelease", "--clearsign"), ("Release.gpg", "--detach-sign")):
        run("gpg", "--batch", "--yes", "--pinentry-mode", "loopback", "--passphrase-fd", "0",
            "--local-user", signing_fingerprint, "--digest-algo", "SHA256", "--output",
            str(release_dir / name), operation, str(release_dir / "Release"), input=passphrase)
    public_key = run("gpg", "--batch", "--export-options", "export-minimal", "--armor",
                     "--export", signing_fingerprint)
    if not public_key:
        raise ValueError("The signing key did not export a public key")
    (output / "openpond.asc").write_bytes(public_key)
    print(f"Built signed OpenPond {version} repository: {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--fingerprint", required=True)
    args = parser.parse_args()
    build_repository(args.assets.resolve(), args.output.resolve(), args.version, args.fingerprint)
