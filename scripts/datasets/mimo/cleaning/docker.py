"""Bounded Docker operations with no host credentials or network in guests."""
import json
import os
import subprocess
import uuid

class Docker:
    def __init__(self, root):
        config = root / "cleanup/docker-config"
        config.mkdir(parents=True, exist_ok=True)
        self.env = {**os.environ, "DOCKER_CONFIG": str(config)}

    def run(self, *args, **kwargs):
        return subprocess.run(["docker", *args], env=self.env, check=True,
                              capture_output=True, **kwargs)

    def start(self, *args, **kwargs):
        return subprocess.Popen(["docker", *args], env=self.env, **kwargs)

    def inspect(self, image):
        return json.loads(self.run("image", "inspect", image).stdout)[0]

    def guest(self, image, args, *, readonly=True, timeout=120):
        name = "openpond-mimo-" + uuid.uuid4().hex
        flags = ["run", "--name", name, "--network", "none", "--cap-drop", "ALL",
                 "--security-opt", "no-new-privileges", "--pids-limit", "256",
                 "--cpus", "2", "--memory", "2g", "--user", "0:0"]
        if readonly:
            flags.append("--read-only")
        try:
            return self.run(*flags, "--entrypoint", "/bin/bash", image,
                            "-c", args, timeout=timeout)
        finally:
            # Only the explicitly named container created by this call.
            subprocess.run(["docker", "rm", "-f", name], env=self.env,
                           capture_output=True, check=False)
