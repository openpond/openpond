import { expect, test } from "vitest";

import { loadProfileActionCatalogForSources } from "./profile-catalog.js";

test("a blank Profile has an empty, current Agent action catalog", async () => {
  const result = await loadProfileActionCatalogForSources([]);
  expect(result.actionCatalog).toEqual([]);
  expect(result.catalog).toMatchObject({
    actionCount: 0,
    stale: false,
    error: null,
  });
});
