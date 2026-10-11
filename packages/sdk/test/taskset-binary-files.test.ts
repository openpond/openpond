import { expect, test } from "vitest";
import { sha256 } from "@openpond/harness";
import { decodeTasksetPackageFile } from "../src/taskset-package-files.js";
import { decodeTasksetDraftWorkspaceFile } from "../src/taskset-draft-workspace.js";
import { decodeTasksetDraftFileContent } from "../src/taskset-draft-files.js";

// Failure story: PDF/workbook transport must retain every binary byte at real
// file sizes, while fast conversion still rejects alternate encodings/tampering.
test("binary dataset admission retains large owned bytes and strict canonical hashes", () => {
  const bytes = new Uint8Array(2_097_155);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256;
  const base64 = Buffer.from(bytes).toString("base64");
  const asset = { id: "binary", path: "inputs/document.bin", mediaType: "application/octet-stream",
    sizeBytes: bytes.length, contentHash: sha256(bytes), visibility: "policy" as const };
  const file = { path: asset.path, sizeBytes: asset.sizeBytes, contentHash: asset.contentHash, base64 };
  const admitted = [decodeTasksetPackageFile({ asset, base64 }), decodeTasksetDraftWorkspaceFile(file),
    decodeTasksetDraftFileContent({ encoding: "base64", data: base64 })];
  for (const snapshot of admitted) expect(Buffer.compare(snapshot, bytes)).toBe(0);
  admitted[0]![0] = 255;
  expect(admitted[1]![0]).toBe(0);
  expect(bytes[0]).toBe(0);
  for (const invalid of ["AB==", "AA", "AA==\n", "!"]) {
    expect(() => decodeTasksetPackageFile({ asset, base64: invalid })).toThrow();
    expect(() => decodeTasksetDraftWorkspaceFile({ ...file, base64: invalid })).toThrow();
    expect(() => decodeTasksetDraftFileContent({ encoding: "base64", data: invalid })).toThrow();
  }
  expect(() => decodeTasksetPackageFile({ asset: { ...asset, contentHash: "0".repeat(64) }, base64 })).toThrow(/immutable bytes/);
  expect(() => decodeTasksetDraftWorkspaceFile({ ...file, sizeBytes: file.sizeBytes - 1 })).toThrow(/retained bytes/);
});
