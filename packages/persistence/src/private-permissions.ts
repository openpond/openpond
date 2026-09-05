import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync } from "node:fs";
import { PersistenceError } from "./errors.js";

const secured = new Map<string, string>();
// Set a complete protected DACL. The path is data in the environment, never PowerShell source.
const setOwnerAcl = [
  "$ErrorActionPreference='Stop'",
  "$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$acl=New-Object System.Security.AccessControl.DirectorySecurity",
  "$acl.SetOwner($identity)",
  "$acl.SetAccessRuleProtection($true,$false)",
  "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')",
  "$acl.AddAccessRule($rule)",
  "Set-Acl -LiteralPath $env:OPENPOND_PRIVATE_DIRECTORY -AclObject $acl",
].join("; ");

/** New children inherit a private ACL on Windows, or a 0700 parent on POSIX. */
export function protectPrivateDirectory(directory: string): void {
  if (process.platform !== "win32") { chmodSync(directory, 0o700); return; }
  const stat = lstatSync(directory);
  const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  if (secured.get(directory) === identity) return;
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", setOwnerAcl], {
      env: { ...process.env, OPENPOND_PRIVATE_DIRECTORY: directory },
      stdio: ["ignore", "ignore", "pipe"], timeout: 30_000, windowsHide: true,
    });
    secured.set(directory, identity);
  } catch (cause) {
    throw new PersistenceError({ code: "PRIVATE_STORAGE_UNAVAILABLE", path: directory,
      message: "OpenPond could not restrict this storage folder to its owner.",
      action: "Use a local folder that supports private access controls, then retry." }, { cause });
  }
}
