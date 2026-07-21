import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ComputeStateResponse,
  DatasetCatalogResponse,
} from "@openpond/contracts";
import { DatasetStorageSettingsSection } from "../apps/web/src/components/settings/DatasetStorageSettingsSection";

const now = "2026-07-20T12:00:00.000Z";
const datasetPath = "/mnt/training/OpenPond/datasets";

function computeState(): ComputeStateResponse {
  return {
    schemaVersion: "openpond.computeState.v1",
    settings: {
      schemaVersion: "openpond.computeSettings.v1",
      modelStorePath: "/mnt/training/OpenPond/models",
      datasetStorePath: datasetPath,
      defaultDeviceIds: [],
      additionalModelPaths: [],
      updatedAt: now,
    },
    inventory: {
      schemaVersion: "openpond.computeInventory.v1",
      host: {
        platform: "linux",
        architecture: "x64",
        operatingSystem: "Test Linux",
        hostname: "test",
        totalMemoryBytes: 16_000_000_000,
      },
      devices: [],
      runtimes: [],
      storageRoots: [{
        id: "storage:training",
        label: "Training drive",
        path: "/mnt/training",
        modelStorePath: "/mnt/training/OpenPond/models",
        datasetStorePath: datasetPath,
        kind: "local",
        configured: true,
        mounted: true,
        writable: true,
        totalBytes: 2_000_000_000,
        freeBytes: 1_000_000_000,
      }],
      connections: [],
      models: [],
      downloads: [],
      warnings: [],
      scannedAt: now,
    },
    scanning: false,
  };
}

function catalog(): DatasetCatalogResponse {
  return {
    schemaVersion: "openpond.datasetCatalog.v1",
    profileId: "default",
    datasets: [{
      schemaVersion: "openpond.datasetCatalogItem.v1",
      tasksetId: "taskset-1",
      tasksetRevision: 1,
      artifactId: "dataset-artifact-1",
      name: "Renewal Risk Triage",
      status: "ready",
      storageKind: "parquet",
      rowCount: 70,
      splitCounts: {
        train: 50,
        validation: 10,
        test: 10,
        frozen_eval: 0,
      },
      sizeBytes: 32_768,
      available: true,
      unavailableReason: null,
      createdAt: now,
      updatedAt: now,
    }],
    generatedAt: now,
  };
}

describe("DatasetStorageSettingsSection", () => {
  test("renders the Dataset location and bounded registered Dataset summaries", () => {
    const html = renderToStaticMarkup(createElement(
      DatasetStorageSettingsSection,
      {
        state: computeState(),
        catalog: catalog(),
        busy: null,
        catalogLoading: false,
        onRefresh: async () => undefined,
        onSave: async () => true,
      },
    ));

    expect(html).toContain("<h1>Dataset Storage</h1>");
    expect(html).toContain('aria-label="Dataset storage drive"');
    expect(html).toContain(datasetPath);
    expect(html).toContain("Renewal Risk Triage");
    expect(html).toContain("70 rows");
    expect(html).toContain("50 train");
    expect(html).toContain("10 validation");
    expect(html).toContain("10 test");
    expect(html).toContain("Parquet");
    expect(html).toContain("32 KB");
    expect(html).not.toContain("prompt");
    expect(html).not.toContain("expectedOutput");
  });
});
