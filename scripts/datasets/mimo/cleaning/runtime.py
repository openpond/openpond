"""One mandatory, audited cleanup gate shared by every Code task."""
import json
import hashlib
from pathlib import Path
import shlex
import subprocess
import shutil
import tempfile
import time
import uuid

from archive import POLICY
from process import bounded_command


class CodeRuntime:
    def __init__(self, docker, task):
        self.docker, self.task = docker, task
        self.name = "openpond-mimo-runtime-" + uuid.uuid4().hex
        self.directory = tempfile.TemporaryDirectory(prefix="openpond-mimo-setup-")
        self.ready, self.receipt = False, None
        self.setup_capabilities = True

    def start(self):
        directory = Path(self.directory.name)
        directory.chmod(0o755)
        for name in ("setup_guest.py", "archive.py"):
            (directory / name).write_bytes((Path(__file__).parent / name).read_bytes())
        (directory / "request.json").write_text(json.dumps({"cwd": self.task["instance"]["cwd"]}))
        try:
            policy_hash = hashlib.sha256(b"".join((Path(__file__).parent / name).read_bytes()
                for name in ("runtime.py", "setup_guest.py", "archive.py"))).hexdigest()
            source_digest = self.task["image"].rsplit(":", 1)[1]
            cache_tag = f"openpond-mimo-runtime:{source_digest[:32]}-{policy_hash[:32]}"
            try:
                cached = self.docker.inspect(cache_tag)
            except subprocess.CalledProcessError:
                cached = None
            if cached is not None:
                labels = cached["Config"].get("Labels") or {}
                if (labels.get("openpond.sourceImage") != self.task["image"] or labels.get("openpond.cleanupCodeHash") != policy_hash
                        or labels.get("openpond.cwd") != self.task["instance"]["cwd"]):
                    raise ValueError("Runtime cleanup cache identity mismatch")
                self.receipt = json.loads(labels["openpond.cleanupReceipt"])
                if not self.receipt.get("agentAccessAllowed") or self.receipt.get("policy") != POLICY:
                    raise ValueError("Runtime cleanup cache lacks admission")
                self.docker.run("run", "-d", "--name", self.name, "--network", "none", "--cap-drop", "ALL",
                    "--security-opt", "no-new-privileges", "--pids-limit", "256", "--cpus", "2", "--memory", "2g",
                    "--user", "65532:65532", "--entrypoint", "/bin/sleep", cached["Id"], "infinity")
                self.setup_capabilities = False
                self.ready = True
                return self.receipt
            try:
                image = self.docker.inspect(self.task["image"])
            except subprocess.CalledProcessError:
                manifest = json.loads(self.docker.run("manifest", "inspect", self.task["image"], timeout=120).stdout)
                compressed = sum(layer["size"] for layer in manifest.get("layers", []))
                storage = self.docker.run("info", "--format", "{{.DockerRootDir}}").stdout.decode().strip()
                if not compressed or compressed > 4_000_000_000 or shutil.disk_usage(storage).free < compressed * 8 + 5_000_000_000:
                    raise OSError("Selected task exceeds local runtime capacity")
                self.docker.run("pull", self.task["image"], timeout=1800)
                image = self.docker.inspect(self.task["image"])
            if self.task["image"].removeprefix("docker.io/") not in {ref.removeprefix("docker.io/") for ref in image.get("RepoDigests", [])}:
                raise ValueError("Task image differs from pinned digest")
            command = ("python3 -I /run/openpond-setup/setup_guest.py && "
                       "exec setpriv --bounding-set=-all --reuid=65532 --regid=65532 "
                       "--clear-groups --no-new-privs /bin/sleep infinity")
            self.docker.run("run", "-d", "--name", self.name, "--network", "none", "--cap-drop", "ALL",
                "--cap-add", "CHOWN", "--cap-add", "FOWNER", "--cap-add", "DAC_OVERRIDE",
                "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "SETPCAP",
                "--security-opt", "no-new-privileges", "--pids-limit", "256", "--cpus", "2", "--memory", "2g",
                "--user", "0:0", "--env", "HOME=/tmp", "--env", "OPENPOND_MIMO_SETUP=" + POLICY,
                "--mount", f"type=bind,source={directory},target=/run/openpond-setup,readonly",
                "--entrypoint", "/bin/bash", self.task["image"], "-c", command)
            deadline = time.monotonic() + 900
            while time.monotonic() < deadline:
                output = self.docker.run("logs", self.name).stdout.decode().strip().splitlines()
                if output:
                    self.receipt = json.loads(output[-1])
                    if not self.receipt.get("agentAccessAllowed"):
                        raise ValueError("Runtime cleanup failed: " + self.receipt.get("message", "unknown"))
                    # Init must also have dropped its capabilities and UID.
                    identity = self.docker.run("exec", "--user", "0:0", self.name, "cat", "/proc/1/status").stdout.decode()
                    fields = dict(line.split(":", 1) for line in identity.splitlines() if ":" in line)
                    if fields["Uid"].split() != ["65532"] * 4 or int(fields["CapEff"].strip(), 16) != 0:
                        time.sleep(0.1)
                        continue
                    # This private local cache is captured before any agent
                    # tool is admitted. Fresh grading never inherits agent edits.
                    self.docker.run("commit", "--change", "USER 65532:65532",
                        "--change", "LABEL openpond.sourceImage=" + self.task["image"],
                        "--change", "LABEL openpond.cleanupCodeHash=" + policy_hash,
                        "--change", "LABEL openpond.cwd=" + self.task["instance"]["cwd"],
                        "--change", "LABEL openpond.cleanupReceipt=" + json.dumps(json.dumps(self.receipt)),
                        self.name, cache_tag, timeout=600)
                    self.ready = True
                    return self.receipt
                status = json.loads(self.docker.run("inspect", self.name).stdout)[0]["State"]
                if not status["Running"]:
                    raise ValueError("Cleanup container exited before admission")
                time.sleep(0.25)
            raise TimeoutError("Runtime cleanup admission timed out")
        except BaseException:
            self.close()
            raise

    def execute(self, command, timeout=120):
        if not self.ready:
            raise RuntimeError("Agent access requires successful cleanup admission")
        # Docker exec does not inherit PID 1's reduced bounding set. Drop it
        # explicitly for every tool invocation before changing to the task UID.
        flags = (["--user", "0:0"] if self.setup_capabilities else ["--user", "65532:65532"])
        drop = (["setpriv", "--bounding-set=-all", "--reuid=65532", "--regid=65532",
                 "--clear-groups", "--no-new-privs"] if self.setup_capabilities else [])
        return bounded_command(["docker", "exec", *flags, "--workdir", self.task["instance"]["cwd"],
            self.name, *drop, "/bin/bash", "-lc", command],
            env=self.docker.env, timeout=timeout)

    def candidate_patch(self):
        base = shlex.quote(self.receipt["cleanBaselineCommit"])
        cwd = shlex.quote(self.task["instance"]["cwd"])
        result = self.execute(f"git -c safe.directory={cwd} -c core.hooksPath=/dev/null add -Af . && "
            f"git -c safe.directory={cwd} -c core.hooksPath=/dev/null diff --cached --binary {base}")
        if len(result.stdout) == 262144:
            raise ValueError("Candidate patch exceeds retained output limit")
        if result.returncode:
            raise ValueError("Candidate state could not be collected against the admitted baseline")
        return result.stdout

    def close(self):
        self.ready = False
        subprocess.run(["docker", "rm", "-f", self.name], env=self.docker.env, capture_output=True, check=False)
        self.directory.cleanup()
