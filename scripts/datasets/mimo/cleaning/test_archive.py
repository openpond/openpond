"""Protect the boundary that prevents exported source history reaching agents."""
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

from archive import clean_rootfs, EPOCH


def archive(entries):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as output:
        for name, content in entries:
            member = tarfile.TarInfo(name)
            member.size, member.mtime = len(content), 1720000000
            output.addfile(member, io.BytesIO(content))
    buffer.seek(0)
    return buffer


class CleanupBoundary(unittest.TestCase):
    def test_history_residue_and_timestamps_do_not_survive_flattening(self):
        # A cached future solution or an original Git pack must not be visible
        # to agents even when ordinary package files are retained.
        source = archive([
            ("testbed/.git/objects/pack/original.pack", b"future solution"),
            ("testbed/code.py", b"modified solution"),
            ("root/.cache/build/reference.py", b"cached solution"),
            ("opt/other/.git/objects/pack/future.pack", b"future solution"),
            ("opt/solution.patch", b"solution patch"),
            ("usr/lib/runtime.py", b"runtime"),
        ])
        base = archive([
            ("code.py", b"baseline"),
            (".git/objects/baseline", b"fresh baseline only"),
        ])
        with tempfile.TemporaryDirectory() as directory:
            baseline = Path(directory) / "baseline.tar"
            baseline.write_bytes(base.getvalue())
            result = io.BytesIO()
            receipt = clean_rootfs(source, result, baseline, "/testbed")
            result.seek(0)
            with tarfile.open(fileobj=result) as cleaned:
                self.assertEqual(set(cleaned.getnames()), {
                    "usr/lib/runtime.py", "testbed", "testbed/code.py",
                    "testbed/.git/objects/baseline",
                })
                self.assertEqual(cleaned.extractfile("testbed/code.py").read(), b"baseline")
                self.assertTrue(all(member.mtime == EPOCH for member in cleaned))
                self.assertEqual(cleaned.getmember("testbed/code.py").uid, 65532)
            self.assertEqual(len(receipt["removed"]), 5)

    def test_link_cannot_reintroduce_removed_history(self):
        # An innocently named hardlink could otherwise bypass path filtering.
        source = io.BytesIO()
        with tarfile.open(fileobj=source, mode="w") as output:
            link = tarfile.TarInfo("usr/lib/cache.bin")
            link.type, link.linkname = tarfile.LNKTYPE, "testbed/.git/objects/pack/leak.pack"
            output.addfile(link)
        source.seek(0)
        with tempfile.TemporaryDirectory() as directory:
            baseline = Path(directory) / "baseline.tar"
            baseline.write_bytes(archive([]).getvalue())
            with self.assertRaises(ValueError):
                clean_rootfs(source, io.BytesIO(), baseline, "/testbed")


if __name__ == "__main__":
    unittest.main()
