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
  test("keeps Models root and Model collection breadcrumb actions distinct", () => {
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

    expect(breadcrumbs[0]?.label).toBe("Models");
    breadcrumbs[0]?.onSelect?.();
    expect(requestClose).toHaveBeenCalledWith(null);
    expect(openModels).not.toHaveBeenCalled();

    breadcrumbs[1]?.onSelect?.();
    expect(openModels).toHaveBeenCalledOnce();
  });
});
