"""Boundary proof: signed APT downloads plus failure-safe release publication."""

import functools
import http.server
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest

from publish import publish_repository
from repository import build_repository, run, sha256
from verify import verify_repository

spec = importlib.util.spec_from_file_location("check_client", Path(__file__).with_name("check-client.py"))
client_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client_module)


class FileStore:
    """Same immutable object contract as R2, with controllable upload failures."""
    def __init__(self, root):
        self.root = root
        self.fail_key = None
        self.writes = []

    def get(self, key, output):
        source = self.root / key
        if not source.exists():
            return False
        shutil.copyfile(source, output)
        return True

    def put(self, key, source, immutable):
        if key == self.fail_key:
            raise OSError("Injected upload failure")
        target = self.root / key
        if immutable and target.exists():
            if sha256(target) != sha256(source):
                raise ValueError("Refusing to overwrite immutable object")
            return
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        self.writes.append(key)


class RepositoryBoundaryTest(unittest.TestCase):
    def test_signed_client_and_publication_lifecycle(self):
        # Failure story: a partially uploaded, unsigned, overwritten, or older
        # release must never replace the last usable repository for APT users.
        with tempfile.TemporaryDirectory(prefix="openpond-apt-test-") as temporary:
            root = Path(temporary)
            home = root / "gnupg"
            home.mkdir(mode=0o700)
            previous_home = os.environ.get("GNUPGHOME")
            previous_passphrase = os.environ.get("APT_SIGNING_PASSPHRASE")
            os.environ["APT_SIGNING_PASSPHRASE"] = "test-only-passphrase"
            os.environ["GNUPGHOME"] = str(home)
            try:
                run("gpg", "--batch", "--pinentry-mode", "loopback", "--passphrase-fd", "0",
                    "--quick-generate-key", "APT test <apt@example.invalid>", "rsa2048", "cert", "1d",
                    input=b"test-only-passphrase\n")
                listing = run("gpg", "--batch", "--with-colons", "--list-secret-keys").decode()
                fingerprint = next(line.split(":")[9] for line in listing.splitlines() if line.startswith("fpr:"))
                run("gpg", "--batch", "--pinentry-mode", "loopback", "--passphrase-fd", "0",
                    "--quick-add-key", fingerprint, "rsa2048", "sign", "1d", input=b"test-only-passphrase\n")
                exported = run("gpg", "--batch", "--pinentry-mode", "loopback", "--passphrase-fd", "0",
                               "--armor", "--export-secret-subkeys", fingerprint, input=b"test-only-passphrase\n")
                run("gpgconf", "--kill", "all")
                signing_home = root / "ci-gnupg"
                signing_home.mkdir(mode=0o700)
                os.environ["GNUPGHOME"] = str(signing_home)
                run("gpg", "--batch", "--import", input=exported)
                first = self.build(root, "1.0.0", fingerprint)
                second = self.build(root, "1.0.1", fingerprint)
                self.assertEqual(verify_repository(first), "1.0.0")
                store = FileStore(root / "public")
                publish_repository(first, store)
                old_release = (store.root / "dists/stable/InRelease").read_bytes()
                store.fail_key = "dists/stable/Release"
                with self.assertRaises(OSError):
                    publish_repository(second, store)
                self.assertEqual((store.root / "dists/stable/InRelease").read_bytes(), old_release)
                self.check_http_client(store.root, first / "openpond.asc", "1.0.0")
                store.fail_key = None
                publish_repository(second, store)
                self.assertEqual(store.writes[-1], "dists/stable/InRelease")
                self.check_http_client(store.root, second / "openpond.asc", "1.0.1")
                publish_repository(second, store)  # Safe retries.
                with self.assertRaisesRegex(ValueError, "downgrade"):
                    publish_repository(first, store)
                # A legitimate signature for replacement bytes at the same version
                # still cannot overwrite packages already installed by clients.
                changed = self.build(root, "1.0.1", fingerprint, suffix="-changed", payload="replacement")
                with self.assertRaisesRegex(ValueError, "immutable"):
                    publish_repository(changed, store)
                package = next(second.glob("pool/**/*.deb"))
                package.write_bytes(package.read_bytes() + b"tampered")
                with self.assertRaisesRegex(ValueError, "checksum"):
                    publish_repository(second, store)
                signed = first / "dists/stable/InRelease"
                signed.write_bytes(signed.read_bytes().replace(b"OpenPond", b"Tampered", 1))
                with self.assertRaises(subprocess.CalledProcessError):
                    publish_repository(first, store)
                self.check_http_client(store.root, second / "openpond.asc", "1.0.1")
                with self.assertRaisesRegex(ValueError, "stable version"):
                    build_repository(root, root / "nightly", "1.0.2-nightly.1", fingerprint)
                missing = root / "missing"
                missing.mkdir()
                with self.assertRaisesRegex(ValueError, "exactly one"):
                    build_repository(missing, root / "incomplete", "1.0.2", fingerprint)
            finally:
                run("gpgconf", "--kill", "all")
                if previous_passphrase is None:
                    os.environ.pop("APT_SIGNING_PASSPHRASE", None)
                else:
                    os.environ["APT_SIGNING_PASSPHRASE"] = previous_passphrase
                if previous_home is None:
                    os.environ.pop("GNUPGHOME", None)
                else:
                    os.environ["GNUPGHOME"] = previous_home

    def build(self, root, version, fingerprint, suffix="", payload="original"):
        assets = root / f"assets-{version}{suffix}"
        assets.mkdir()
        for arch in ("amd64", "arm64"):
            package = root / f"package-{version}-{arch}{suffix}"
            (package / "DEBIAN").mkdir(parents=True)
            (package / "DEBIAN/control").write_text(
                f"Package: openpond\nVersion: {version}\nArchitecture: {arch}\n"
                "Maintainer: APT test <apt@example.invalid>\nDescription: Repository boundary fixture\n")
            (package / "payload").write_text(payload)
            run("dpkg-deb", "--build", "--root-owner-group", str(package), str(assets / f"{arch}.deb"))
        output = root / f"repository-{version}{suffix}"
        build_repository(assets, output, version, fingerprint)
        return output

    def check_http_client(self, root, key, version):
        class QuietHandler(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *args):
                pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=root))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client_module.check_client(f"http://127.0.0.1:{server.server_port}", key, version)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
