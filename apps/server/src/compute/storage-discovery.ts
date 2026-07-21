import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ComputeStorageRoot } from "@openpond/contracts";
import type { CommandProbe } from "./command-probe.js";

export type StorageCandidate = Pick<
  ComputeStorageRoot,
  "datasetStorePath" | "kind" | "label" | "modelStorePath" | "path"
>;

const NETWORK_FILE_SYSTEMS = new Set([
  "9p",
  "afpfs",
  "cifs",
  "davfs",
  "fuse.rclone",
  "fuse.sshfs",
  "nfs",
  "nfs4",
  "smbfs",
  "sshfs",
  "webdav",
]);
const IGNORED_FILE_SYSTEMS = new Set([
  "autofs",
  "bpf",
  "cgroup",
  "cgroup2",
  "configfs",
  "debugfs",
  "devpts",
  "devtmpfs",
  "efivarfs",
  "fuse.gvfsd-fuse",
  "fuse.portal",
  "fusectl",
  "hugetlbfs",
  "mqueue",
  "nsfs",
  "overlay",
  "proc",
  "pstore",
  "ramfs",
  "securityfs",
  "squashfs",
  "sysfs",
  "tmpfs",
  "tracefs",
]);

export async function discoverStorageCandidates(input: {
  commandProbe: CommandProbe;
  platform: NodeJS.Platform;
  storeDir: string;
}): Promise<StorageCandidate[]> {
  const fallback = systemStorageCandidate(input.storeDir, input.platform);
  if (input.platform === "linux") {
    const [mountInfo, gvfs] = await Promise.all([
      readFile("/proc/self/mountinfo", "utf8").catch(() => ""),
      discoverGvfsCandidates(),
    ]);
    return uniqueCandidates([
      ...parseLinuxMountInfo(mountInfo, input.storeDir),
      ...gvfs,
      fallback,
    ]);
  }
  if (input.platform === "darwin") {
    const result = await input.commandProbe("mount", []);
    return uniqueCandidates([
      ...(result.state === "success" ? parseMacMountOutput(result.stdout, input.storeDir) : []),
      fallback,
    ]);
  }
  if (input.platform === "win32") {
    const script = "Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -in 2,3,4 } | Select-Object DeviceID,VolumeName,DriveType | ConvertTo-Json -Compress";
    const result = await input.commandProbe("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    return uniqueCandidates([
      ...(result.state === "success" ? parseWindowsLogicalDisks(result.stdout, input.storeDir) : []),
      fallback,
    ]);
  }
  return [fallback];
}

export function parseLinuxMountInfo(value: string, storeDir: string): StorageCandidate[] {
  const candidates: StorageCandidate[] = [];
  for (const line of value.split(/\r?\n/)) {
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const left = line.slice(0, separator).split(" ");
    const right = line.slice(separator + 3).split(" ");
    if (left.length < 6 || right.length < 2) continue;
    const mountPath = decodeMountField(left[4]!);
    const fileSystem = right[0]!.toLowerCase();
    const source = decodeMountField(right[1]!);
    if (!isRelevantLinuxMount(mountPath, source, fileSystem)) continue;
    const kind = storageKind({ fileSystem, mountPath, source });
    candidates.push({
      kind,
      label: driveLabel(mountPath, source, kind),
      modelStorePath: mountPath === "/" ? path.join(storeDir, "models") : mountPath,
      datasetStorePath: mountPath === "/"
        ? path.join(storeDir, "datasets")
        : path.join(mountPath, "OpenPond", "datasets"),
      path: mountPath,
    });
  }
  return uniqueCandidates(candidates);
}

export function parseMacMountOutput(value: string, storeDir: string): StorageCandidate[] {
  const candidates: StorageCandidate[] = [];
  for (const line of value.split(/\r?\n/)) {
    const match = /^(.+?) on (.+?) \(([^, )]+)/.exec(line.trim());
    if (!match) continue;
    const source = decodeMountField(match[1]!);
    const mountPath = decodeMountField(match[2]!);
    const fileSystem = match[3]!.toLowerCase();
    if (mountPath !== "/" && !mountPath.startsWith("/Volumes/")) continue;
    const kind = NETWORK_FILE_SYSTEMS.has(fileSystem) || source.startsWith("//") ? "network" : mountPath === "/" ? "local" : "removable";
    candidates.push({
      kind,
      label: driveLabel(mountPath, source, kind),
      modelStorePath: mountPath === "/" ? path.join(storeDir, "models") : mountPath,
      datasetStorePath: mountPath === "/"
        ? path.join(storeDir, "datasets")
        : path.join(mountPath, "OpenPond", "datasets"),
      path: mountPath,
    });
  }
  return uniqueCandidates(candidates);
}

export function parseWindowsLogicalDisks(value: string, storeDir: string): StorageCandidate[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value.trim()); }
  catch { return []; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const record = row as Record<string, unknown>;
    const deviceId = typeof record.DeviceID === "string" ? record.DeviceID.trim() : "";
    const driveType = typeof record.DriveType === "number" ? record.DriveType : Number(record.DriveType);
    if (!/^[a-z]:$/i.test(deviceId) || ![2, 3, 4].includes(driveType)) return [];
    const root = `${deviceId}\\`;
    const volumeName = typeof record.VolumeName === "string" ? record.VolumeName.trim() : "";
    const kind = driveType === 4 ? "network" : driveType === 2 ? "removable" : "local";
    const storeRoot = path.win32.parse(path.win32.resolve(storeDir)).root.toLowerCase();
    return [{
      kind,
      label: volumeName || (root.toLowerCase() === storeRoot ? "System disk" : deviceId.toUpperCase()),
      modelStorePath: root.toLowerCase() === storeRoot ? path.win32.join(storeDir, "models") : root,
      datasetStorePath: root.toLowerCase() === storeRoot
        ? path.win32.join(storeDir, "datasets")
        : path.win32.join(root, "OpenPond", "datasets"),
      path: root,
    } satisfies StorageCandidate];
  });
}

export function storageKindForPath(value: string): ComputeStorageRoot["kind"] {
  const normalized = value.toLowerCase();
  if (normalized.includes("/gvfs/") || normalized.startsWith("//") || normalized.startsWith("\\\\")) return "network";
  if (normalized.startsWith("/media/") || normalized.startsWith("/run/media/") || normalized.startsWith("/volumes/")) return "removable";
  if (normalized.includes("/.cache/")) return "cache";
  return "local";
}

async function discoverGvfsCandidates(): Promise<StorageCandidate[]> {
  const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;
  const gvfsRoot = path.join("/run/user", String(uid), "gvfs");
  const entries = await readdir(gvfsRoot, { withFileTypes: true }).catch(() => []);
  return entries.flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const mountedPath = path.join(gvfsRoot, entry.name);
    return [{
      kind: "network",
      label: labelForGvfsMount(entry.name),
      modelStorePath: mountedPath,
      datasetStorePath: path.join(mountedPath, "OpenPond", "datasets"),
      path: mountedPath,
    } satisfies StorageCandidate];
  });
}

function systemStorageCandidate(storeDir: string, platform: NodeJS.Platform): StorageCandidate {
  const root = path.parse(path.resolve(storeDir)).root;
  return {
    kind: "local",
    label: "System disk",
    modelStorePath: path.join(storeDir, "models"),
    datasetStorePath: path.join(storeDir, "datasets"),
    path: platform === "win32" ? root : root || "/",
  };
}

function isRelevantLinuxMount(mountPath: string, source: string, fileSystem: string): boolean {
  if (mountPath === "/") return true;
  if (IGNORED_FILE_SYSTEMS.has(fileSystem)) return false;
  if (/^\/(?:boot|snap)(?:\/|$)/.test(mountPath)) return false;
  if (NETWORK_FILE_SYSTEMS.has(fileSystem) || source.startsWith("//")) return true;
  if (source.startsWith("/dev/")) return true;
  return /^(?:\/media\/|\/mnt\/|\/run\/media\/)/.test(mountPath);
}

function storageKind(input: { fileSystem: string; mountPath: string; source: string }): ComputeStorageRoot["kind"] {
  if (NETWORK_FILE_SYSTEMS.has(input.fileSystem) || input.source.startsWith("//")) return "network";
  if (/^(?:\/media\/|\/run\/media\/)/.test(input.mountPath)) return "removable";
  return "local";
}

function driveLabel(mountPath: string, source: string, kind: ComputeStorageRoot["kind"]): string {
  if (mountPath === "/") return "System disk";
  const mountName = path.basename(mountPath);
  if (kind === "network") {
    const sourceName = source.replace(/\/+$/, "").split("/").pop();
    return decodeSafely(sourceName || mountName || source);
  }
  return decodeSafely(mountName || path.basename(source) || source);
}

export function labelForGvfsMount(name: string): string {
  const separator = name.indexOf(":");
  const values = new Map<string, string>();
  for (const segment of name.slice(separator + 1).split(",")) {
    const equals = segment.indexOf("=");
    if (equals > 0) values.set(segment.slice(0, equals), decodeSafely(segment.slice(equals + 1)));
  }
  const share = values.get("share") ?? values.get("volume") ?? values.get("path");
  const server = values.get("server") ?? values.get("host");
  if (share && server) return `${share} on ${server}`;
  return share ?? server ?? decodeSafely(separator > 0 ? name.slice(0, separator) : name);
}

function decodeMountField(value: string): string {
  return value.replace(/\\040/g, " ").replace(/\\011/g, "\t").replace(/\\012/g, "\n").replace(/\\134/g, "\\");
}

function decodeSafely(value: string): string {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

function uniqueCandidates(candidates: StorageCandidate[]): StorageCandidate[] {
  const unique = new Map<string, StorageCandidate>();
  for (const candidate of candidates) {
    const key = normalizedPath(candidate.path);
    const current = unique.get(key);
    if (!current || current.label === "System disk") unique.set(key, candidate);
  }
  return [...unique.values()];
}

function normalizedPath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
