"""Native Code environment for the existing managed-RL JSONL adapter."""
import hashlib
import json
from pathlib import Path
import signal
import subprocess
import sys
import tempfile

# Filled by packaging; this module's own digest pins these dependent files.
DEPENDENCY_HASHES = {}
ROOT = Path(__file__).resolve().parent.parent
for relative, expected in DEPENDENCY_HASHES.items():
    if hashlib.sha256((ROOT / relative).read_bytes()).hexdigest() != expected:
        raise ValueError("MiMo runtime dependency hash mismatch: " + relative)
sys.path.insert(0, str(Path(__file__).parent / "cleaning"))
from source import code_tasks
from docker import Docker
from runtime import CodeRuntime


class Bridge:
    def __init__(self, root, task_id):
        tasks = code_tasks(root)
        self.task = tasks[task_id.removeprefix("mimo-code-")]
        self.docker, self.runtime, self.root = Docker(root), None, root
        self.terminal, self.steps = False, 0

    def initialize(self):
        if self.runtime is not None:
            raise ValueError("Runtime already initialized")
        self.runtime = CodeRuntime(self.docker, self.task)
        receipt = self.runtime.start()
        return {"environmentVersion": receipt["policy"],
            "policy": "Solve the repository task using the terminal tool. Complete your work before sending a final answer.",
            "userPrompt": self.task["instance"]["problem_statement"],
            "tools": [{"type": "function", "function": {"name": "terminal", "description": "Run a command in the isolated task repository.",
                "parameters": {"type": "object", "properties": {"command": {"type": "string"}, "timeoutSeconds": {"type": "integer", "minimum": 1, "maximum": 120}}, "required": ["command"], "additionalProperties": False}}}]}

    def step(self, request):
        if self.runtime is None or self.terminal:
            raise ValueError("Runtime is not active")
        calls = request.get("toolCalls") or []
        if len(calls) > 16:
            raise ValueError("Too many tool calls")
        if not calls:
            return self.finish("completed")
        outputs = []
        for call in calls:
            try:
                if call["name"] != "terminal":
                    raise ValueError("Unsupported tool")
                args = json.loads(call["arguments"])
                if set(args) - {"command", "timeoutSeconds"} or not isinstance(args.get("command"), str) or not 0 < len(args["command"]) <= 16384:
                    raise ValueError("Invalid terminal arguments")
                timeout = args.get("timeoutSeconds", 120)
                if not isinstance(timeout, int) or isinstance(timeout, bool) or not 1 <= timeout <= 120:
                    raise ValueError("Invalid terminal timeout")
                result = self.runtime.execute(args["command"], timeout)
                output = {"exitCode": result.returncode, "stdout": result.stdout.decode(errors="replace")[:32000], "stderr": result.stderr.decode(errors="replace")[:16000]}
            except (ValueError, subprocess.TimeoutExpired) as error:
                if isinstance(error, subprocess.TimeoutExpired):
                    # A timed-out exec can leave processes behind. Abort this
                    # attempt before grading rather than allowing concurrent edits.
                    raise RuntimeError("Task command timed out; attempt is unscorable") from error
                output = {"error": str(error)}
            outputs.append({"id": call["id"], "name": call["name"], "output": output})
        self.steps += 1
        return {"toolResults": outputs, "userMessage": None, "terminal": False, "reward": 0,
                "components": {}, "stateHashes": {"baseline": self.runtime.receipt["cleanBaselineCommit"]}}

    def finish(self, reason):
        if self.runtime is None or self.terminal:
            raise ValueError("Runtime is not active")
        self.terminal = True
        candidate = self.runtime.candidate_patch()
        self.runtime.close()
        self.runtime = None
        # The agent filesystem and background processes are gone. Hidden
        # grading runs in a separate freshly cleaned instance of the image.
        grading = CodeRuntime(self.docker, self.task)
        try:
            receipt = grading.start()
            with tempfile.TemporaryDirectory(prefix="openpond-mimo-grade-") as temporary:
                directory = Path(temporary)
                (directory / "tests.patch").write_text(self.task["instance"]["test_patch"])
                if candidate:
                    (directory / "candidate.patch").write_bytes(candidate)
                (directory / "request.json").write_text(json.dumps({"cwd": self.task["instance"]["cwd"], "base": receipt["cleanBaselineCommit"],
                    "command": self.task["instance"]["test_command"], "timeout": self.task["instance"]["verifier_timeout_sec"]}))
                (directory / "grade.py").write_bytes((Path(__file__).parent / "cleaning/grade_guest.py").read_bytes())
                # Docker cp can assign the container's configured UID to the
                # copied files. Set readable modes before transfer so grading
                # needs no root capabilities in the fresh cached container.
                directory.chmod(0o755)
                for file in directory.iterdir():
                    file.chmod(0o644)
                self.docker.run("cp", str(directory), grading.name + ":/run/openpond-grading")
                result = grading.execute("python3 -I /run/openpond-grading/grade.py", self.task["instance"]["verifier_timeout_sec"] + 60)
                rows = result.stdout.decode().strip().splitlines()
                score = json.loads(rows[-1]) if rows else {"status": "unscorable"}
                if score["status"] != "scored" or result.returncode:
                    raise RuntimeError("Native Code grading failed: " + json.dumps(score))
                return {"toolResults": [], "userMessage": None, "terminal": True, "terminationReason": reason,
                    "reward": score["reward"], "components": {"testsPassed": score["reward"]},
                    "stateHashes": {"baseline": receipt["cleanBaselineCommit"], "candidate": hashlib.sha256(candidate).hexdigest()}}
        finally:
            grading.close()

    def close(self):
        if self.runtime is not None:
            self.runtime.close()


if __name__ == "__main__":
    bridge = Bridge(ROOT, sys.argv[1])
    def stop(signum, frame):
        bridge.close()
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        for line in sys.stdin:
            try:
                request = json.loads(line)
                operation = request["operation"]
                if operation == "init": response = bridge.initialize()
                elif operation == "step": response = bridge.step(request)
                elif operation == "terminate": response = bridge.finish(request.get("reason", "terminated"))
                else: raise ValueError("Unknown runtime operation")
                print(json.dumps(response), flush=True)
            except Exception as error:
                print(json.dumps({"fatal": type(error).__name__, "message": str(error)[:1000]}), flush=True)
                break
    finally:
        bridge.close()
