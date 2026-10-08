"""Flatten exported rootfs, replace the task checkout, and remove known leaks.

All removed files are recorded privately. This is a cleanup policy, not proof
against every possible side channel; scoring qualification remains separate.
"""
import copy
from pathlib import PurePosixPath
import tarfile

EPOCH = 946684800  # one public, task-independent timestamp
POLICY = "openpond.mimo.code-cleanup.v1"
EMPTY_ROOTS = ("root", "home", "tmp", "var/tmp", "var/cache", "var/log", "logs", "artifacts", "go/pkg/mod", "go/pkg/sumdb")
RESIDUE = {".cache", ".pytest_cache", "__pycache__", ".mypy_cache", ".ruff_cache",
           ".gradle", ".m2", ".npm", ".cargo", ".ccache", "git-hidden"}
LEAK_FILES = {"mimo_test_command.sh", "test.patch", "solution.patch", "gold.patch",
              "reference.patch", "model.patch", "last_result.json", ".bash_history",
              ".python_history", ".gitconfig", ".git-credentials"}

def archive_name(value):
    name = value.removeprefix("./").rstrip("/")
    p = PurePosixPath(name)
    if p.is_absolute() or ".." in p.parts or "\x00" in name:
        raise ValueError(f"Unsafe archive path: {value!r}")
    return str(p) if name else "."

def under(name, root):
    return name == root or name.startswith(root + "/")

def reason(name, cwd):
    p = PurePosixPath(name)
    if under(name, cwd):
        return "replace_checkout_with_base"
    if ".git" in p.parts or ("objects" in p.parts and ("pack" in p.parts or p.name == "HEAD")):
        return "git_object_store"
    if any(under(name, root) and name != root for root in EMPTY_ROOTS):
        return "home_cache_or_build_residue"
    if any(part in RESIDUE for part in p.parts) or p.suffix in {".pyc", ".pyo"}:
        return "cache"
    if p.name in LEAK_FILES:
        return "grading_or_solution_residue"
    return None

def normalized(member, name, owner=None):
    result = copy.copy(member)
    result.name, result.mtime = name, EPOCH
    result.pax_headers = {}  # do not retain atime/ctime or archive history
    result.uname = result.gname = ""
    result.mode &= ~0o6000  # no setuid/setgid escape from the task user
    if owner is not None:
        result.uid = result.gid = owner
    return result

def clean_rootfs(source, destination, base_archive, cwd):
    cwd = archive_name(cwd.lstrip("/"))
    kept, removed, emitted, links = set(), [], 0, []
    # Tar members are streamed; original layers never enter the new image.
    with tarfile.open(fileobj=source, mode="r|*") as incoming, tarfile.open(fileobj=destination, mode="w|") as outgoing:
        for member in incoming:
            name = archive_name(member.name)
            if name in kept:
                raise ValueError(f"Duplicate rootfs member: {name}")
            why = reason(name, cwd)
            if member.ischr() or member.isblk() or member.isfifo():
                why = "device_or_fifo"
            if why:
                removed.append({"path": name, "reason": why, "bytes": member.size})
                continue
            if member.islnk():
                target = archive_name(member.linkname)
                if reason(target, cwd):
                    raise ValueError(f"Retained hardlink reaches removed content: {name}")
                links.append((name, target))
            if member.issym():
                # OS absolute symlinks are allowed; never preserve a link into
                # excluded residue or an original Git store.
                target = str(PurePosixPath(member.linkname.lstrip("/"))) if member.linkname.startswith("/") else str(PurePosixPath(name).parent / member.linkname)
                import posixpath
                target = posixpath.normpath(target)
                if target.startswith("../") or reason(target, cwd):
                    raise ValueError(f"Retained symlink reaches removed content: {name}")
            data = incoming.extractfile(member) if member.isfile() else None
            outgoing.addfile(normalized(member, name), data)
            kept.add(name)
            emitted += member.size
        for name, target in links:
            if target not in kept:
                raise ValueError(f"Dangling hardlink after cleanup: {name}")
        root = tarfile.TarInfo(cwd)
        root.type, root.mode = tarfile.DIRTYPE, 0o755
        outgoing.addfile(normalized(root, cwd, 65532))
        with tarfile.open(base_archive, "r:*") as baseline:
            for member in baseline:
                relative = archive_name(member.name)
                if relative == ".":
                    continue
                if ".git" in PurePosixPath(relative).parts and relative != ".git" and not relative.startswith(".git/"):
                    raise ValueError("Nested Git data in baseline")
                name = cwd + "/" + relative
                if name in kept:
                    raise ValueError(f"Baseline collision: {name}")
                if not (member.isfile() or member.isdir() or member.issym()):
                    raise ValueError(f"Unsupported baseline member: {name}")
                if member.issym():
                    import posixpath
                    target = posixpath.normpath(str(PurePosixPath(relative).parent / member.linkname))
                    if member.linkname.startswith("/") or target == ".." or target.startswith("../"):
                        raise ValueError(f"Baseline symlink leaves task checkout: {relative}")
                outgoing.addfile(normalized(member, name, 65532), baseline.extractfile(member) if member.isfile() else None)
                kept.add(name)
                emitted += member.size
    return {"policy": POLICY, "timestamp": EPOCH, "retainedFiles": len(kept),
            "emittedFileBytes": emitted, "removed": removed}
