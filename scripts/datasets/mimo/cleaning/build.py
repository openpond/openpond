import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tarfile
import tempfile
import uuid

from archive import clean_rootfs, EPOCH, POLICY
from source import digest, REVISION

SAFE_ENV = {"PATH", "LANG", "LC_ALL", "VIRTUAL_ENV", "CONDA_PREFIX", "JAVA_HOME",
            "GOPATH", "GOMODCACHE", "GOROOT", "LD_LIBRARY_PATH", "PYTHONPATH", "NODE_PATH"}

def baseline(docker, task, directory):
    cwd = shlex.quote(task["instance"]["cwd"])
    git = f"git -c safe.directory={cwd} -c core.hooksPath=/dev/null -C {cwd}"
    base = docker.guest(task["image"], f"{git} rev-parse HEAD").stdout.decode().strip()
    if len(base) != 40 or any(c not in "0123456789abcdef" for c in base):
        raise ValueError("Source image has no trustworthy base commit")
    original = directory / "original-base.tar"
    original.write_bytes(docker.guest(task["image"], f"{git} archive --format=tar {base}").stdout)
    expected = docker.guest(task["image"], f"{git} ls-tree -rz --name-only {base}").stdout.split(b"\0")
    with tarfile.open(original) as archive:
        names = {m.name.encode() for m in archive if not m.isdir()}
    if names != {n for n in expected if n}:
        raise ValueError("Git archive omitted or substituted tracked files; inspect source attributes before cleanup")
    checkout = directory / "base"
    checkout.mkdir()
    with tarfile.open(original) as archive:
        archive.extractall(checkout, filter="data")
    empty = directory / "empty-git-template"
    empty.mkdir()
    git_env = {**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
               "GIT_AUTHOR_DATE": f"{EPOCH} +0000", "GIT_COMMITTER_DATE": f"{EPOCH} +0000"}
    def local_git(*args):
        return subprocess.run(["git", "-C", str(checkout), *args], env=git_env,
                              capture_output=True, check=True).stdout
    local_git("init", "-q", "--initial-branch=task", f"--template={empty}")
    local_git("config", "core.hooksPath", "/dev/null")
    local_git("add", "-Af", ".")
    local_git("-c", "user.name=OpenPond", "-c", "user.email=dataset@openpond.ai",
              "commit", "-q", "--allow-empty", "-m", "Task baseline")
    new_base = local_git("rev-parse", "HEAD").decode().strip()
    if local_git("fsck", "--full", "--no-reflogs", "--unreachable").strip():
        raise ValueError("Fresh baseline contains unreachable objects")
    rebuilt = directory / "rebuilt-base.tar"
    with tarfile.open(rebuilt, "w") as archive:
        for entry in sorted(checkout.iterdir()):
            archive.add(entry, arcname=entry.name)
    return base, new_base, rebuilt

def build_image(docker, task, root):
    image = docker.inspect(task["image"])
    if task["image"].removeprefix("docker.io/") not in {ref.removeprefix("docker.io/") for ref in image.get("RepoDigests", [])}:
        raise ValueError("Local source image does not match the pinned registry digest")
    docker_root = Path(docker.run("info", "--format", "{{.DockerRootDir}}").stdout.decode().strip())
    if shutil.disk_usage(docker_root).free < image["Size"] * 2 + 2_000_000_000:
        raise ValueError("Insufficient Docker storage for a flattened image; use a larger cleanup worker")
    output = root / "cleanup/code" / task["id"]
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    tag = f"openpond-mimo-clean:{task['id']}-v1"
    if (output / "cleanup-receipt.json").exists():
        receipt = json.loads((output / "cleanup-receipt.json").read_text())
        if receipt["sourceImage"] != task["image"] or receipt["policy"] != POLICY or receipt["cleanImageId"] != docker.inspect(tag)["Id"]:
            raise ValueError("Retained cleanup receipt differs from the current image")
        return receipt
    name = "openpond-mimo-export-" + uuid.uuid4().hex
    with tempfile.TemporaryDirectory(prefix="build-", dir=output) as temporary:
        directory = Path(temporary)
        base, new_base, archive = baseline(docker, task, directory)
        docker.run("create", "--name", name, "--network", "none", "--entrypoint", "/bin/true", task["image"])
        exporting = importing = None
        try:
            exporting = docker.start("export", name, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            changes = ["--change", f"WORKDIR {task['instance']['cwd']}", "--change", "USER 65532:65532",
                       "--change", 'ENV HOME="/tmp"', "--change", 'CMD ["/bin/bash"]']
            for item in (image.get("Config") or {}).get("Env") or []:
                key, value = item.split("=", 1)
                if key in SAFE_ENV:
                    changes.extend(["--change", f"ENV {key}={json.dumps(value)}"])
            importing = docker.start("import", *changes, "-", tag, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            policy_receipt = clean_rootfs(exporting.stdout, importing.stdin, archive, task["instance"]["cwd"])
            importing.stdin.close()
            importing.stdin = None
            stdout, stderr = importing.communicate(timeout=600)
            if importing.returncode:
                raise RuntimeError("Flattened image import failed: " + stderr.decode()[-1000:])
            if exporting.wait(timeout=60):
                raise RuntimeError("Source image export failed")
            clean = docker.inspect(tag)
            if len(clean["RootFS"]["Layers"]) != 1 or set(clean["RootFS"]["Layers"]) & set(image["RootFS"]["Layers"]):
                raise ValueError("Flattened image retained an upstream layer")
            removed = output / "removed-paths.json"
            removed.write_text(json.dumps(policy_receipt.pop("removed"), indent=2))
            receipt = {**policy_receipt, "schemaVersion": "openpond.mimoCodeCleanup.v1",
                       "sourceRevision": REVISION, "taskId": task["id"], "sourceImage": task["image"],
                       "sourceImageId": image["Id"], "sourceBaseCommit": base,
                       "cleanBaselineCommit": new_base, "cleanImageTag": tag, "cleanImageId": clean["Id"],
                       "removedPathsHash": digest(removed.read_bytes()), "status": "rebuilt_pending_scoring_and_leak_audit"}
            (output / "cleanup-receipt.json").write_text(json.dumps(receipt, indent=2))
            return receipt
        finally:
            for process in (exporting, importing):
                if process and process.poll() is None:
                    process.kill()
                    process.wait()
            subprocess.run(["docker", "rm", "-f", name], env=docker.env, capture_output=True, check=False)
