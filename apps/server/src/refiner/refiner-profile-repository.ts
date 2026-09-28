import { getLocalRecord, listLocalRecords, withLocalDatabase, withFileLock, atomicWriteFile } from "@openpond/persistence";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { canonicalJson, contentHash, type ImmutableReleaseRef } from "@openpond/harness";
import {
  RefinerBindingSchema, RefinerReleaseSchema, RefinerTransitionReceiptSchema,
  type RefinerBinding, type RefinerRelease, type RefinerTransitionReceipt,
} from "@openpond/harness/refiner";

export type RefinerProfileRepositoryPaths = {
  home: string; root: string; source: string; releases: string;
};

export interface RefinerProfileRepository {
  binding(): RefinerBinding | null;
  releases(): Promise<RefinerRelease[]>;
  transitions(): RefinerTransitionReceipt[];
  release(ref: ImmutableReleaseRef): Promise<RefinerRelease>;
  persistRelease(release: RefinerRelease): Promise<void>;
  writeSource(contents: string): Promise<void>;
  transition(release: RefinerRelease, input: Pick<RefinerTransitionReceipt,
    "operation" | "bindingChanged" | "actor" | "reason" | "authoringSkillHash">): Promise<void>;
}

/** Local implementation retains the existing file layout and SQLite atomic
 * binding/transition update. Hosted control-plane mutation needs a separate
 * authenticated route and is intentionally not selected through a Work lease. */
export function createLocalRefinerProfileRepository(paths: RefinerProfileRepositoryPaths): RefinerProfileRepository {
  return {
    binding: () => {
      const row = getLocalRecord(paths.home, "refiner_bindings", "active");
      return row ? RefinerBindingSchema.parse(row.value) : null;
    },
    releases: async () => {
      const names = (await fs.readdir(paths.releases)).filter((name) => name.endsWith(".json"));
      return Promise.all(names.map(async (name) => RefinerReleaseSchema.parse(
        JSON.parse(await fs.readFile(path.join(paths.releases, name), "utf8")),
      )));
    },
    transitions: () => Object.values(listLocalRecords(paths.home, "refiner_transitions"))
      .map((entry) => RefinerTransitionReceiptSchema.parse(entry.value)),
    release: async (ref) => {
      const release = RefinerReleaseSchema.parse(JSON.parse(await fs.readFile(
        path.join(paths.releases, `${ref.contentHash}.json`), "utf8")));
      if (release.id !== ref.id || release.contentHash !== ref.contentHash)
        throw new Error("Refiner release reference does not match immutable release content.");
      return release;
    },
    persistRelease: async (release) => atomicWrite(paths.releases + `/${release.contentHash}.json`, canonicalJson(release), true),
    writeSource: async (contents) => atomicWrite(paths.source, contents),
    transition: async (release, input) => {
      withLocalDatabase(paths.home, (db) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const row = db.prepare("SELECT payload FROM refiner_bindings WHERE id = 'active'")
            .get() as { payload: string } | undefined;
          const previous = row ? RefinerBindingSchema.parse(JSON.parse(row.payload)) : null;
          const now = new Date().toISOString();
          const releaseRef = { id: release.id, contentHash: release.contentHash };
          const receiptWithoutHash = {
            schemaVersion: "openpond.refinerTransitionReceipt.v1" as const,
            id: `refiner-transition-${randomUUID()}`,
            operation: input.operation,
            bindingChanged: input.bindingChanged,
            previousRelease: previous?.release ?? null,
            nextRelease: releaseRef,
            actor: input.actor,
            reason: input.reason,
            authoringSkillHash: input.authoringSkillHash,
            validation: { valid: true, messages: [] },
            createdAt: now,
          };
          const receipt = RefinerTransitionReceiptSchema.parse({
            ...receiptWithoutHash, contentHash: contentHash(receiptWithoutHash),
          });
          db.prepare("INSERT INTO refiner_transitions VALUES (?, ?, 1)")
            .run(receipt.contentHash, JSON.stringify(receipt));
          if (input.bindingChanged) {
            const binding = RefinerBindingSchema.parse({
              schemaVersion: "openpond.refinerBinding.v1", channel: "active",
              revision: (previous?.revision ?? -1) + 1, release: releaseRef, updatedAt: now,
            });
            db.prepare("INSERT INTO refiner_bindings VALUES ('active', ?, 1) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, revision=revision+1")
              .run(JSON.stringify(binding));
          }
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      });
    },
  };
}

async function atomicWrite(filePath: string, contents: string, preserveExisting = false): Promise<void> {
  await withFileLock(filePath, async () => {
    if (preserveExisting) {
      const existing = await fs.readFile(filePath, "utf8").catch(() => null);
      if (existing !== null) {
        if (existing !== contents) throw new Error("Immutable Refiner release bytes changed.");
        return;
      }
    }
    await atomicWriteFile(filePath, contents);
  });
}
