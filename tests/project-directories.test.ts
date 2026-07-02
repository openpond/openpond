import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { defaultNewProjectDirectory, normalizeProjectDirectory } from "../apps/server/src/workspace/project-directories";

const previousDocumentsDir = process.env.OPENPOND_APP_DOCUMENTS_DIR;

afterEach(() => {
  if (previousDocumentsDir === undefined) delete process.env.OPENPOND_APP_DOCUMENTS_DIR;
  else process.env.OPENPOND_APP_DOCUMENTS_DIR = previousDocumentsDir;
});

describe("project directories", () => {
  test("uses the desktop-provided Documents directory when available", () => {
    process.env.OPENPOND_APP_DOCUMENTS_DIR = path.join(os.tmpdir(), "OpenPond Docs");

    expect(defaultNewProjectDirectory()).toBe(
      path.join(os.tmpdir(), "OpenPond Docs", "OpenPond Projects")
    );
  });

  test("normalizes blank and home-relative project directories", () => {
    delete process.env.OPENPOND_APP_DOCUMENTS_DIR;

    expect(normalizeProjectDirectory("")).toBe(path.join(os.homedir(), "Documents", "OpenPond Projects"));
    expect(normalizeProjectDirectory("~/Projects")).toBe(path.join(os.homedir(), "Projects"));
  });
});
