export class PythonSandboxUnavailableError extends Error {
  constructor(detail: string) {
    super(`Secure Python execution is unavailable. Use Linux with bubblewrap, enabled user namespaces, and system Python 3. ${detail}`);
    this.name = "PythonSandboxUnavailableError";
  }
}

/** No host home, repository, /etc, sockets, credentials, or shared network.
 * The import allowlist in the worker is deliberately not trusted for isolation.
 * Missing mounts, namespaces or executables are fatal; never launch bare Python.
 */
export function pythonSandboxLaunch(input: {
  pythonBin?: string;
  maxMemoryBytes: number;
  maxOutputBytes: number;
  source: string;
}): string[] {
  if (process.platform !== "linux") throw new PythonSandboxUnavailableError("This host cannot provide the required namespaces.");
  return [
    "--unshare-all", "--unshare-user", "--die-with-parent", "--new-session",
    "--as-pid-1", "--cap-drop", "ALL", "--info-fd", "3",
    "--ro-bind", input.pythonBin ?? "/usr/bin/python3", "/usr/bin/python3",
    "--ro-bind", "/usr/lib", "/usr/lib",
    "--ro-bind-try", "/usr/lib64", "/usr/lib64",
    "--ro-bind", "/lib", "/lib", "--ro-bind-try", "/lib64", "/lib64",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--clearenv", "--setenv", "PATH", "/usr/bin",
    "--setenv", "HOME", "/tmp", "--setenv", "LANG", "C.UTF-8",
    "--chdir", "/tmp", "--", "/usr/bin/python3", "-I", "-S", "-u",
    "-c", input.source, String(input.maxMemoryBytes), String(input.maxOutputBytes),
  ];
}
