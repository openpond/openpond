export const PYTHON_SANDBOX_WORKER_SOURCE = String.raw`
import contextlib, io, json, math, statistics, decimal, datetime, collections, itertools, functools, sys

import resource

# Startup fails if the kernel cannot enforce these limits. They are set before
# reading any model input, and the hard limits cannot be raised by that input.
max_memory_bytes = int(sys.argv[1])
max_output_bytes = int(sys.argv[2])
for kind, value in ((resource.RLIMIT_CPU, 5), (resource.RLIMIT_AS, max_memory_bytes),
                    (resource.RLIMIT_NPROC, 1), (resource.RLIMIT_NOFILE, 32),
                    (resource.RLIMIT_FSIZE, max_output_bytes), (resource.RLIMIT_CORE, 0)):
    _, hard = resource.getrlimit(kind)
    limit = value if hard == resource.RLIM_INFINITY else min(value, hard)
    resource.setrlimit(kind, (limit, limit))

class BoundedOutput(io.StringIO):
    def __init__(self):
        super().__init__()
        self.bytes_written = 0
    def write(self, value):
        self.bytes_written += len(value.encode("utf-8"))
        if self.bytes_written > max_output_bytes:
            raise ValueError("Python sandbox output exceeded the byte limit.")
        return super().write(value)

# This allowlist describes the tool, not a security boundary. Python reflection
# can bypass it; the surrounding OS namespaces must contain unrestricted Python.
ALLOWED_MODULES = {"math", "statistics", "decimal", "datetime", "collections", "itertools", "functools", "json"}
real_import = __import__
def safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".", 1)[0]
    if root not in ALLOWED_MODULES:
        raise ImportError("module is not available in the standard-library-only sandbox")
    return real_import(name, globals, locals, fromlist, level)

safe_builtins = {
    "abs": abs, "all": all, "any": any, "bool": bool, "dict": dict, "enumerate": enumerate,
    "filter": filter, "float": float, "int": int, "len": len, "list": list, "map": map,
    "max": max, "min": min, "next": next, "print": print, "range": range, "repr": repr,
    "reversed": reversed, "round": round, "set": set, "sorted": sorted, "str": str,
    "sum": sum, "tuple": tuple, "zip": zip, "Exception": Exception, "ValueError": ValueError,
    "TypeError": TypeError, "__import__": safe_import,
}
state = {"__builtins__": safe_builtins}
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    request_id = ""
    try:
        request = json.loads(line)
        request_id = str(request.get("id") or "")
        code = request.get("code")
        if not request_id or not isinstance(code, str) or not code.strip():
            raise ValueError("id and non-empty code are required")
        output = BoundedOutput()
        state.pop("_result", None)
        with contextlib.redirect_stdout(output):
            exec(compile(code, "<openpond-run-python>", "exec"), state, state)
        rendered = output.getvalue()
        result = state.get("_result")
        json.dumps(result)
        print(json.dumps({"id": request_id, "ok": True, "stdout": rendered, "result": result}), flush=True)
    except BaseException as exc:
        print(json.dumps({"id": request_id, "ok": False, "error": str(exc)}), flush=True)
`;
