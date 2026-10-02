/** Arguments are quoted for the local terminal; never interpolate source paths as shell code. */
export function nativeTerminalCommand(command: string, args: string[], environment: Record<string, string> = {}): string {
  if ([command, ...args, ...Object.values(environment)].some((value) => /[\r\n\0]/u.test(value))) throw new Error("Terminal arguments must be single-line values.");
  if (Object.keys(environment).some((key) => !/^[A-Z][A-Z0-9_]*$/u.test(key))) throw new Error("Invalid environment name.");
  if (process.platform === "win32") {
    const quote = (value: string) => `'${value.replace(/'/gu, "''")}'`;
    return `${Object.entries(environment).map(([key, value]) => `$env:${key} = ${quote(value)}; `).join("")}& ${[command, ...args].map(quote).join(" ")}`;
  }
  const quote = (value: string) => `'${value.replace(/'/gu, "'\\''")}'`;
  return ["env", ...Object.entries(environment).map(([key, value]) => quote(`${key}=${value}`)), ...[command, ...args].map(quote)].join(" ");
}
