import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const State = z.object({ version: z.literal(1), disabled: z.array(z.string().regex(/^[a-f0-9]{64}$/)), devices: z.record(z.string(), z.string().uuid()).default({}) }).strict();
export type DeviceOwner = { installationId: string; profileId: string; ownerUserId: string; teamId: string | null; audience: string };
export function deviceOwnerKey(owner: DeviceOwner) {
  return createHash("sha256").update(JSON.stringify([owner.installationId, owner.profileId, owner.ownerUserId, owner.teamId, owner.audience])).digest("hex");
}

/** Off and remote unlink persist independently of credentials and connection health. */
export async function loadRemoteAccessPreference(storeDir: string) {
  const directory = path.join(storeDir, "remote-relay");
  const file = path.join(directory, "preference.json");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let disabled = new Set<string>();
  let devices: Record<string, string> = {};
  try { const stored = State.parse(JSON.parse(await readFile(file, "utf8"))); disabled = new Set(stored.disabled); devices = stored.devices; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let queue: Promise<unknown> = Promise.resolve();
  return {
    enabled(owner: DeviceOwner) { return !disabled.has(deviceOwnerKey(owner)); },
    deviceId(owner: DeviceOwner) { return devices[deviceOwnerKey(owner)] ?? null; },
    setDeviceId(owner: DeviceOwner, deviceId: string) { return this.set(owner, this.enabled(owner), deviceId); },
    set(owner: DeviceOwner, enabled: boolean, deviceId?: string) {
      const operation = queue.then(async () => {
        const next = new Set(disabled);
        const key = deviceOwnerKey(owner);
        if (enabled) next.delete(key); else next.add(key);
        const nextDevices = { ...devices, ...(deviceId ? { [key]: deviceId } : {}) };
        const temporary = path.join(directory, `${randomUUID()}.tmp`);
        try {
          const handle = await open(temporary, "wx", 0o600);
          try { await handle.writeFile(JSON.stringify({ version: 1, disabled: [...next], devices: nextDevices })); await handle.sync(); }
          finally { await handle.close(); }
          await rename(temporary, file);
          const handleDirectory = await open(directory, "r");
          try { await handleDirectory.sync(); } finally { await handleDirectory.close(); }
          disabled = next; devices = nextDevices;
        } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
      });
      queue = operation.catch(() => undefined);
      return operation;
    },
  };
}
