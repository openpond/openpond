import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  DatasetReleaseSchema,
  EvidenceSetReleaseSchema,
  HarnessReleaseSchema,
  type DatasetRelease,
  type EvidenceSetRelease,
  type HarnessRelease,
} from "@openpond/contracts";
import { canonicalJson, sha256 } from "@openpond/taskset-sdk";

import {
  validateDatasetRelease,
  validateEvidenceSetRelease,
  validateHarnessRelease,
} from "./release-graph.js";

export type HarnessAssetReader = (
  asset: HarnessRelease["assets"][number],
) => Promise<Uint8Array>;
export type DatasetAssetReader = (
  asset: DatasetRelease["assets"][number],
) => Promise<Uint8Array>;

export class ContentAddressedReleaseStore {
  constructor(private readonly root: string) {}

  async publishHarnessRelease(input: {
    release: HarnessRelease;
    readAsset: HarnessAssetReader;
  }): Promise<HarnessRelease> {
    const release = HarnessReleaseSchema.parse(input.release);
    const issues = validateHarnessRelease(release);
    if (issues.length) throw new Error(formatIssues("Harness Release", issues));
    for (const asset of release.assets) {
      const bytes = await input.readAsset(asset);
      if (bytes.byteLength !== asset.sizeBytes || sha256(bytes) !== asset.sha256) {
        throw new Error(`Harness asset ${asset.path} failed hash or size validation.`);
      }
      await this.writeObject(asset.sha256, bytes);
    }
    await this.writeRelease(
      "harness",
      release.id,
      release.revision,
      release.contentHash,
      canonicalJson(release),
    );
    return release;
  }

  async publishEvidenceSetRelease(
    input: EvidenceSetRelease,
  ): Promise<EvidenceSetRelease> {
    const release = EvidenceSetReleaseSchema.parse(input);
    const issues = validateEvidenceSetRelease(release);
    if (issues.length) throw new Error(formatIssues("Evidence Set Release", issues));
    await this.writeRelease(
      "evidence",
      release.id,
      release.revision,
      release.contentHash,
      canonicalJson(release),
    );
    return release;
  }

  async publishDatasetRelease(input: {
    release: DatasetRelease;
    readAsset: DatasetAssetReader;
  }): Promise<DatasetRelease> {
    const release = DatasetReleaseSchema.parse(input.release);
    const issues = validateDatasetRelease(release);
    if (issues.length) {
      throw new Error(formatIssues("Dataset Release", issues));
    }
    for (const asset of release.assets) {
      const bytes = await input.readAsset(asset);
      if (
        bytes.byteLength !== asset.sizeBytes ||
        sha256(bytes) !== asset.sha256
      ) {
        throw new Error(
          `Dataset asset ${asset.path} failed hash or size validation.`,
        );
      }
      await this.writeObject(asset.sha256, bytes);
    }
    await this.writeRelease(
      "dataset",
      release.id,
      release.revision,
      release.contentHash,
      canonicalJson(release),
    );
    return release;
  }

  async readHarnessRelease(input: {
    id: string;
    revision: number;
    contentHash: string;
  }): Promise<HarnessRelease> {
    const release = HarnessReleaseSchema.parse(
      JSON.parse(
        await readFile(
          this.releasePath(
            "harness",
            input.id,
            input.revision,
            input.contentHash,
          ),
          "utf8",
        ),
      ),
    );
    const issues = validateHarnessRelease(release);
    if (
      issues.length > 0 ||
      release.id !== input.id ||
      release.revision !== input.revision ||
      release.contentHash !== input.contentHash
    ) {
      throw new Error("Stored Harness Release failed immutable identity validation.");
    }
    return release;
  }

  async resolveHarnessRelease(input: {
    id: string;
    contentHash: string;
  }): Promise<HarnessRelease> {
    assertReleaseHash(input.contentHash);
    const id = safeSegment(input.id);
    const root = path.join(this.root, "releases", "harness", id);
    const revisions = await import("node:fs/promises").then((fs) =>
      fs.readdir(root, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      ),
    );
    const matches: number[] = [];
    for (const entry of revisions) {
      if (
        !entry.isDirectory() ||
        !/^[1-9][0-9]*$/.test(entry.name)
      ) {
        continue;
      }
      const candidate = path.join(
        root,
        entry.name,
        `${input.contentHash}.json`,
      );
      if (await exists(candidate)) matches.push(Number(entry.name));
    }
    if (matches.length !== 1) {
      throw new Error(
        `Harness Release ${input.id}@${input.contentHash} resolved ${matches.length} immutable revisions.`,
      );
    }
    return this.readHarnessRelease({
      id: input.id,
      revision: matches[0]!,
      contentHash: input.contentHash,
    });
  }

  async readEvidenceSetRelease(input: {
    id: string;
    revision: number;
    contentHash: string;
  }): Promise<EvidenceSetRelease> {
    const release = EvidenceSetReleaseSchema.parse(
      JSON.parse(
        await readFile(
          this.releasePath(
            "evidence",
            input.id,
            input.revision,
            input.contentHash,
          ),
          "utf8",
        ),
      ),
    );
    const issues = validateEvidenceSetRelease(release);
    if (
      issues.length > 0 ||
      release.id !== input.id ||
      release.revision !== input.revision ||
      release.contentHash !== input.contentHash
    ) {
      throw new Error(
        "Stored Evidence Set Release failed immutable identity validation.",
      );
    }
    return release;
  }

  async readDatasetRelease(input: {
    id: string;
    revision: number;
    contentHash: string;
  }): Promise<DatasetRelease> {
    const release = DatasetReleaseSchema.parse(
      JSON.parse(
        await readFile(
          this.releasePath(
            "dataset",
            input.id,
            input.revision,
            input.contentHash,
          ),
          "utf8",
        ),
      ),
    );
    const issues = validateDatasetRelease(release);
    if (
      issues.length > 0 ||
      release.id !== input.id ||
      release.revision !== input.revision ||
      release.contentHash !== input.contentHash
    ) {
      throw new Error(
        "Stored Dataset Release failed immutable identity validation.",
      );
    }
    return release;
  }

  async readObject(contentHash: string): Promise<Uint8Array> {
    const bytes = await readFile(this.objectPath(contentHash));
    if (sha256(bytes) !== contentHash) {
      throw new Error(`Content-addressed object ${contentHash} failed verification.`);
    }
    return bytes;
  }

  private async writeObject(contentHash: string, bytes: Uint8Array): Promise<void> {
    const target = this.objectPath(contentHash);
    await mkdir(path.dirname(target), { recursive: true });
    if (await exists(target)) {
      const current = await readFile(target);
      if (sha256(current) !== contentHash) {
        throw new Error(`Content-addressed object ${contentHash} is corrupt.`);
      }
      return;
    }
    await atomicWrite(target, bytes);
  }

  private async writeRelease(
    kind: "harness" | "dataset" | "evidence",
    id: string,
    revision: number,
    contentHash: string,
    serialized: string,
  ): Promise<void> {
    const directory = path.dirname(
      this.releasePath(kind, id, revision, contentHash),
    );
    await mkdir(directory, { recursive: true });
    const entries = await import("node:fs/promises").then((fs) =>
      fs.readdir(directory).catch(() => []),
    );
    const other = entries.find(
      (entry) => entry.endsWith(".json") && entry !== `${contentHash}.json`,
    );
    if (other) {
      throw new Error(
        `${kind} release ${id} revision ${revision} is already published with another immutable hash.`,
      );
    }
    const target = this.releasePath(kind, id, revision, contentHash);
    if (await exists(target)) {
      const current = await readFile(target, "utf8");
      if (current !== serialized) {
        throw new Error(`${kind} release ${id} changed after publication.`);
      }
      return;
    }
    await atomicWrite(target, Buffer.from(serialized, "utf8"));
  }

  private objectPath(contentHash: string): string {
    assertReleaseHash(contentHash);
    return path.join(this.root, "objects", "sha256", contentHash.slice(0, 2), contentHash);
  }

  private releasePath(
    kind: "harness" | "dataset" | "evidence",
    id: string,
    revision: number,
    contentHash: string,
  ): string {
    if (!Number.isInteger(revision) || revision < 1) {
      throw new Error("Release revision must be a positive integer.");
    }
    assertReleaseHash(contentHash);
    return path.join(
      this.root,
      "releases",
      kind,
      safeSegment(id),
      String(revision),
      `${contentHash}.json`,
    );
  }
}

async function atomicWrite(target: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    if (!(await exists(target))) throw error;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error(`Release ID ${value} cannot be used as a store path.`);
  }
  return value;
}

function assertReleaseHash(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("Release content hash is invalid.");
  }
}

function formatIssues(
  label: string,
  issues: Array<{ code: string; path: string; message: string }>,
): string {
  return `${label} validation failed: ${issues
    .map((issue) => `${issue.code} (${issue.path})`)
    .join(", ")}`;
}
