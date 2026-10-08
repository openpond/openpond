"""Bound agent command output without accumulating unlimited host memory."""
import selectors
import subprocess
import time


def bounded_command(command, env, timeout, max_stdout=262144, max_stderr=65536):
    process = subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    outputs = {"stdout": bytearray(), "stderr": bytearray()}
    limits = {"stdout": max_stdout, "stderr": max_stderr}
    deadline = time.monotonic() + timeout
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ, "stdout")
            selector.register(process.stderr, selectors.EVENT_READ, "stderr")
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(command, timeout)
                for key, _ in selector.select(min(remaining, 1)):
                    block = key.fileobj.read1(16384)
                    if not block:
                        selector.unregister(key.fileobj)
                        continue
                    output = outputs[key.data]
                    output.extend(block[:max(0, limits[key.data] - len(output))])
            return subprocess.CompletedProcess(command, process.wait(timeout=max(0.01, deadline - time.monotonic())),
                bytes(outputs["stdout"]), bytes(outputs["stderr"]))
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        process.stdout.close()
        process.stderr.close()
