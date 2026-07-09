export type LocalShellCommand = {
  command: string;
  shell: true | string;
};

export function pipefailLocalShellCommand(command: string): LocalShellCommand {
  if (process.platform === "win32") return { command, shell: true };
  return {
    command: `set -o pipefail\n${command}`,
    shell: "/bin/bash",
  };
}

export function pipefailSandboxShellCommand(command: string): string {
  return `bash -o pipefail -lc ${quotePosixShellArg(command)}`;
}

function quotePosixShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
