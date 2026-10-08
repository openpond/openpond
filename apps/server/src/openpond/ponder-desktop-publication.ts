import {
  PONDER_DESKTOP_CATALOG_PAGE_SIZE,
  PonderDesktopCatalogManifestSchema,
  PonderDesktopCatalogPageSchema,
  type PonderDesktopCatalog,
} from "@openpond/contracts";
import type { createPonderDesktopClient } from "./ponder-desktop-client.js";

/** Every request is bounded; only the final renewal makes these pages discoverable. */
export async function publishPonderDesktopCatalog(input: {
  catalog: PonderDesktopCatalog;
  client: ReturnType<typeof createPonderDesktopClient>;
  epoch: string;
  stillOwned(): Promise<boolean>;
}) {
  const { targets, ...snapshot } = input.catalog;
  const manifest = PonderDesktopCatalogManifestSchema.parse({
    ...snapshot,
    targetCount: targets.length,
    pageCount: Math.ceil(targets.length / PONDER_DESKTOP_CATALOG_PAGE_SIZE),
  });
  for (let index = 0; index < manifest.pageCount; index++) {
    if (!(await input.stillOwned())) throw new Error("ponder_desktop_catalog_owner_changed");
    await input.client.request(
      "catalog-page",
      PonderDesktopCatalogPageSchema.parse({
        catalog: manifest,
        index,
        targets: targets.slice(
          index * PONDER_DESKTOP_CATALOG_PAGE_SIZE,
          (index + 1) * PONDER_DESKTOP_CATALOG_PAGE_SIZE,
        ),
      }),
      input.epoch,
    );
  }
  if (!(await input.stillOwned())) throw new Error("ponder_desktop_catalog_owner_changed");
  return input.client.request("renew", { catalog: manifest }, input.epoch);
}
