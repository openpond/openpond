"""Exercise real APT signature verification, candidate selection and downloads in isolation."""

import argparse
from pathlib import Path
import tempfile
import urllib.request

from repository import ARCHITECTURES, fields, run, stable_version


def check_client(url, key, version):
    stable_version(version)
    if not url.startswith(("https://", "http://127.0.0.1:")) or any(c.isspace() for c in url):
        raise ValueError("Expected HTTPS repository URL (or loopback HTTP for tests)")
    with urllib.request.urlopen(url.rstrip("/") + "/openpond.asc", timeout=30) as response:
        if response.read() != key.read_bytes():
            raise ValueError("Public signing key differs from the expected key")
    with tempfile.TemporaryDirectory(prefix="openpond-apt-client-") as temporary:
        root = Path(temporary)
        for arch in ARCHITECTURES:
            client = root / arch
            (client / "lists/partial").mkdir(parents=True)
            (client / "cache/archives/partial").mkdir(parents=True)
            (client / "status").touch()
            (client / "source.sources").write_text(
                f"Types: deb\nURIs: {url}\nSuites: stable\nComponents: main\n"
                f"Architectures: {arch}\nSigned-By: {key.resolve()}\n")
            options = ["-o", f"Dir::Etc::sourcelist={client / 'source.sources'}",
                       "-o", "Dir::Etc::sourceparts=-", "-o", f"Dir::State={client}",
                       "-o", f"Dir::State::status={client / 'status'}",
                       "-o", f"Dir::Cache={client / 'cache'}", "-o", f"APT::Architecture={arch}",
                       "-o", f"APT::Architectures::={arch}", "-o", "Acquire::Languages=none",
                       "-o", "APT::Get::List-Cleanup=0", "-o", "APT::Update::Error-Mode=any",
                       "-o", "Acquire::AllowInsecureRepositories=false"]
            run("apt-get", *options, "update", cwd=client)
            run("apt-get", *options, "download", f"openpond:{arch}={version}", cwd=client)
            downloaded = list(client.glob("*.deb"))
            if len(downloaded) != 1:
                raise ValueError("APT did not download exactly one package")
            metadata = fields(run("dpkg-deb", "--field", str(downloaded[0])).decode())
            if metadata["Version"] != version or metadata["Architecture"] != arch or metadata["Package"] != "openpond":
                raise ValueError("APT downloaded an unexpected package")
            print(f"Verified APT download: openpond {version} {arch}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--key", type=Path, required=True)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    check_client(args.url, args.key, args.version)
