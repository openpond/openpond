"""Trusted pre-agent cleanup, executed only in a disposable Docker container."""
import io
import json
import os
from pathlib import Path
import posixpath
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile

sys.path.insert(0, str(Path(__file__).parent))
from archive import EPOCH, POLICY, reason

CONTROL = Path("/run/openpond-setup")
RUNTIME_PATHS = {"/etc", "/etc/mtab", "/etc/hosts", "/etc/hostname", "/etc/resolv.conf", "/.dockerenv"}


def prepare(request):
    cwd = Path(request["cwd"])
    if (not Path("/.dockerenv").exists() or os.environ.get("OPENPOND_MIMO_SETUP") != POLICY
            or cwd not in (Path("/testbed"), Path("/workspace/repo")) or cwd.is_symlink()):
        raise RuntimeError("Cleanup requires the designated disposable task container")
    env = {**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
           "GIT_AUTHOR_DATE": f"{EPOCH} +0000", "GIT_COMMITTER_DATE": f"{EPOCH} +0000"}
    def git(*args):
        return subprocess.check_output(["/usr/bin/git", "-c", "safe.directory=" + str(cwd),
            "-c", "core.hooksPath=/dev/null", "-C", str(cwd), *args], env=env)
    base = git("rev-parse", "HEAD").decode().strip()
    source = git("archive", "--format=tar", base)
    expected = {name for name in git("ls-tree", "-rz", "--name-only", base).split(b"\0") if name}
    with tarfile.open(fileobj=io.BytesIO(source)) as archive:
        if {m.name.encode() for m in archive if not m.isdir()} != expected:
            raise ValueError("Baseline export omitted tracked files")
    # Capture baseline first, then remove the complete original worktree and
    # Git object store. No unreachable object can survive a fresh Git init.
    shutil.rmtree(cwd)
    cwd.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(source)) as archive:
        archive.extractall(cwd, filter="data")
    with tempfile.TemporaryDirectory(prefix="openpond-empty-template-", dir="/run") as template:
        git("init", "-q", "--initial-branch=task", "--template=" + template)
        git("add", "-Af", ".")
        git("-c", "user.name=OpenPond", "-c", "user.email=dataset@openpond.ai",
            "commit", "-q", "--allow-empty", "-m", "Task baseline")
    clean_base = git("rev-parse", "HEAD").decode().strip()
    removed = []
    for directory, directories, files in os.walk("/", topdown=True, followlinks=False):
        for entry in list(directories) + files:
            path = Path(directory) / entry
            if str(path) in ("/proc", "/sys", "/dev") or path == CONTROL or path == cwd:
                if entry in directories:
                    directories.remove(entry)
                continue
            why = reason(str(path).lstrip("/"), str(cwd).lstrip("/"))
            if why:
                if path.is_symlink() or not path.is_dir():
                    path.unlink()
                else:
                    shutil.rmtree(path)
                if entry in directories:
                    directories.remove(entry)
                removed.append(str(path))
    checked = 0
    for directory, directories, files in os.walk("/", topdown=True, followlinks=False):
        directories[:] = [d for d in directories if str(Path(directory) / d) not in ("/proc", "/sys", "/dev", str(CONTROL))]
        for entry in directories + files:
            path = Path(directory) / entry
            if str(path) in RUNTIME_PATHS:
                continue
            info = path.lstat()
            if path.is_symlink():
                target = posixpath.normpath(str(path.parent / os.readlink(path)))
                if any(target == p or target.startswith(p + "/") for p in removed):
                    raise ValueError("Runtime dependency points into removed residue: " + str(path) + " -> " + target)
            elif stat.S_ISREG(info.st_mode) and info.st_mode & 0o6000:
                path.chmod(stat.S_IMODE(info.st_mode) & ~0o6000)
            if path == cwd or cwd in path.parents:
                os.chown(path, 65532, 65532, follow_symlinks=False)
            os.utime(path, (EPOCH, EPOCH), follow_symlinks=False)
            checked += 1
    if git("fsck", "--full", "--no-reflogs", "--unreachable").strip() or git("rev-list", "--all", "--count").strip() != b"1":
        raise ValueError("Fresh baseline contains unexpected Git history")
    return {"policy": POLICY, "sourceBaseCommit": base, "cleanBaselineCommit": clean_base,
            "checkedPaths": checked, "removedPaths": len(removed), "agentAccessAllowed": True}


if __name__ == "__main__":
    try:
        result = prepare(json.loads((CONTROL / "request.json").read_text()))
        print(json.dumps(result), flush=True)
    except Exception as error:
        print(json.dumps({"agentAccessAllowed": False, "errorType": type(error).__name__, "message": str(error)[:500]}), flush=True)
        raise SystemExit(2)
