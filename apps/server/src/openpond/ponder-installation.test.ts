import { verify } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { loadPonderInstallation } from "./ponder-installation.js";

// A restart or concurrent process must never silently replace the pinned installation key.
it("publishes one persistent private installation identity and rejects corruption", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ponder-installation-"));
  try {
    const identities = await Promise.all(Array.from({ length: 8 }, () => loadPonderInstallation(directory)));
    const first = identities[0]!;
    expect(new Set(identities.map(identity => identity.installationId)).size).toBe(1);
    expect(new Set(identities.map(identity => identity.publicKey)).size).toBe(1);
    const restarted = await loadPonderInstallation(directory);
    expect(restarted.installationId).toBe(first.installationId);
    const message = "owner/team/profile/operation:payload-hash";
    const signature = Buffer.from(restarted.sign(message), "base64");
    expect(verify(null, Buffer.from(message), first.publicKey, signature)).toBe(true);
    expect(verify(null, Buffer.from(message + "changed"), first.publicKey, signature)).toBe(false);
    const file = path.join(directory, "ponder-installation", "identity.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const original = await readFile(file, "utf8");
    await writeFile(file, JSON.stringify({ ...JSON.parse(original), version: 2 }));
    await expect(loadPonderInstallation(directory)).rejects.toThrow("ponder_installation_invalid");
    expect(await readFile(file, "utf8")).not.toBe(original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
