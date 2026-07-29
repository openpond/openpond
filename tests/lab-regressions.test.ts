import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";

import { SqliteStore } from "../apps/server/src/store/store";
import { buildLabDetailBreadcrumbs } from "../apps/web/src/hooks/useLabDetailNavigation";
import {
  closeTestDatabase,
  getTestSql,
  openTestDatabase,
  runTestSql,
} from "./helpers/sqlite-database";

const TIMESTAMP = "2026-07-28T12:00:00.000Z";

describe("Lab regressions", () => {
  test("keeps Lab and Model collection breadcrumb actions distinct", () => {
    const requestClose = vi.fn();
    const openModels = vi.fn();
    const breadcrumbs = buildLabDetailBreadcrumbs(
      {
        kind: "model",
        kindLabel: "Models",
        kindOnSelect: openModels,
        workproductLabel: "Support model",
        segments: [{ label: "Runs" }],
      },
      requestClose,
    );

    breadcrumbs[0]?.onSelect?.();
    expect(requestClose).toHaveBeenCalledWith(null);
    expect(openModels).not.toHaveBeenCalled();

    breadcrumbs[1]?.onSelect?.();
    expect(openModels).toHaveBeenCalledOnce();
  });

  test("preserves but isolates Model records that use retired destinations", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "openpond-lab-regression-"),
    );
    const storePath = path.join(directory, "state.sqlite");
    try {
      const initial = new SqliteStore(directory);
      await initial.snapshot();
      await initial.close();

      const project = {
        schemaVersion: "openpond.modelProject.v1",
        id: "retired_prime_model",
        profileId: "default",
        name: "Retired Prime model",
        objective: null,
        defaultBaseModel: null,
        defaultDestinationId: "prime_hosted",
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      };
      const draft = {
        schemaVersion: "openpond.modelRunDraft.v1",
        id: "retired_prime_draft",
        profileId: "default",
        modelId: project.id,
        status: "launched",
        title: "Retired Prime run",
        datasetMode: null,
        tasksetRef: null,
        datasetCreationId: null,
        buildIntent: null,
        buildSpecification: null,
        baseModel: null,
        method: null,
        destinationId: "prime_hosted",
        runPreset: null,
        recipe: null,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      };
      const database = openTestDatabase(storePath);
      await runTestSql(
        database,
        `INSERT INTO model_projects
          (id, profile_id, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          project.id,
          project.profileId,
          JSON.stringify(project),
          TIMESTAMP,
          TIMESTAMP,
        ],
      );
      await runTestSql(
        database,
        `INSERT INTO model_run_drafts
          (id, profile_id, model_id, status, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          draft.id,
          draft.profileId,
          draft.modelId,
          draft.status,
          JSON.stringify(draft),
          TIMESTAMP,
          TIMESTAMP,
        ],
      );
      await closeTestDatabase(database);

      const reopened = new SqliteStore(directory);
      expect(await reopened.getModelProject(project.id)).toMatchObject({
        id: project.id,
        defaultDestinationId: null,
      });
      expect(await reopened.listModelProjects("default")).toContainEqual(
        expect.objectContaining({
          id: project.id,
          defaultDestinationId: null,
        }),
      );
      expect(await reopened.getModelRunDraft(draft.id)).toBeNull();
      expect(await reopened.listModelRunDrafts("default")).toEqual([]);
      await reopened.close();

      const preserved = openTestDatabase(storePath);
      const projectRow = await getTestSql<{ payload: string }>(
        preserved,
        "SELECT payload FROM model_projects WHERE id = ?",
        [project.id],
      );
      const draftRow = await getTestSql<{ payload: string }>(
        preserved,
        "SELECT payload FROM model_run_drafts WHERE id = ?",
        [draft.id],
      );
      expect(JSON.parse(projectRow.payload).defaultDestinationId).toBe(
        "prime_hosted",
      );
      expect(JSON.parse(draftRow.payload).destinationId).toBe("prime_hosted");
      await closeTestDatabase(preserved);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
