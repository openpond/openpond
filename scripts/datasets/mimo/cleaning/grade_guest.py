"""Trusted qualification payload. Uploaded only to a separate grading guest."""
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess

payload = Path("/run/openpond-grading")
request = json.loads((payload / "request.json").read_text())
cwd = Path(request["cwd"])
def git(*args, check=True):
    return subprocess.run(["git", "-c", f"safe.directory={cwd}", "-c", "core.hooksPath=/dev/null", "-C", str(cwd), *args], capture_output=True, check=check)

try:
    if git("rev-parse", "HEAD").stdout.decode().strip() != request["base"]:
        raise ValueError("Grading baseline mismatch")
    # Candidate patches never reach Git metadata or leave the checkout.
    candidate = payload / "candidate.patch"
    if candidate.exists():
        listing = git("apply", "--numstat", "-z", str(candidate)).stdout
        if any(b".git" in row.split(b"\t")[-1].split(b"/") or b".." in row.split(b"\t")[-1].split(b"/") for row in listing.split(b"\0") if row):
            raise ValueError("Candidate patch changes protected paths")
        git("apply", "--check", str(candidate))
        git("apply", str(candidate))
    patch = payload / "tests.patch"
    listing = git("apply", "--numstat", "-z", str(patch)).stdout.split(b"\0")
    touched = []
    index = 0
    while index < len(listing) and listing[index]:
        fields = listing[index].split(b"\t", 2)
        if len(fields) != 3:
            raise ValueError("Malformed test patch path list")
        if fields[2]:
            touched.append(fields[2].decode())
            index += 1
        else:
            touched.extend([listing[index + 1].decode(), listing[index + 2].decode()])
            index += 3
    for relative in sorted(set(touched)):
        path = PurePosixPath(relative)
        if path.is_absolute() or ".." in path.parts or ".git" in path.parts:
            raise ValueError("Test patch leaves checkout")
        target = cwd / relative
        if any(parent.is_symlink() for parent in target.parents if parent != cwd and cwd in parent.parents):
            raise ValueError("Test path traverses a candidate symlink")
        if target.is_symlink() or target.is_file():
            target.unlink()
        elif target.is_dir():
            shutil.rmtree(target)
        if git("ls-tree", request["base"], "--", relative).stdout:
            git("restore", "--source", request["base"], "--staged", "--worktree", "--", relative)
    git("apply", "--check", str(patch))
    git("apply", str(patch))
    command = subprocess.run(["/bin/bash", "-lc", request["command"]], cwd=cwd, capture_output=True,
                             timeout=request["timeout"], start_new_session=True)
    (Path("/tmp") / "qualification-command.log").write_bytes(command.stdout + command.stderr)
    print(json.dumps({"status": "scored", "exitCode": command.returncode, "reward": int(command.returncode == 0)}))
except Exception as error:
    print(json.dumps({"status": "unscorable", "errorType": type(error).__name__, "message": str(error)[:400]}))
    raise SystemExit(2)
