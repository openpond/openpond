import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComputeStateResponse } from "@openpond/contracts";
import { ComputeSettingsSection } from "../apps/web/src/components/settings/ComputeSettingsSection";
import { ManualModelStorageDialog, manualStoragePathError } from "../apps/web/src/components/settings/ModelStoragePicker";

const noopAsync = async () => undefined;

function computeState(): ComputeStateResponse {
  const now = "2026-07-13T12:00:00.000Z";
  const selectedPath = "/run/user/1000/gvfs/smb-share:server=nas.local,share=models,user=test";
  return {
    schemaVersion: "openpond.computeState.v1",
    settings: { schemaVersion: "openpond.computeSettings.v1", modelStorePath: selectedPath, datasetStorePath: "/mnt/data/OpenPond/datasets", defaultDeviceIds: [], additionalModelPaths: [], updatedAt: now },
    inventory: {
      schemaVersion: "openpond.computeInventory.v1",
      host: { platform: "linux", architecture: "x64", operatingSystem: "Test Linux", hostname: "test", totalMemoryBytes: 16_000_000_000 },
      devices: [],
      runtimes: [],
      storageRoots: [
        { id: "storage:system", label: "System disk", path: "/", modelStorePath: "/home/test/.openpond/openpond-app/models", datasetStorePath: "/home/test/.openpond/openpond-app/datasets", kind: "local", configured: false, mounted: true, writable: true, totalBytes: 1_000_000_000, freeBytes: 500_000_000 },
        { id: "storage:smb", label: "models on nas.local", path: selectedPath, modelStorePath: selectedPath, datasetStorePath: "/mnt/data/OpenPond/datasets", kind: "network", configured: true, mounted: true, writable: true, totalBytes: 2_000_000_000, freeBytes: 1_000_000_000 },
      ],
      connections: [],
      models: [],
      downloads: [],
      warnings: [],
      scannedAt: now,
    },
    scanning: false,
  };
}

describe("compute model storage settings", () => {
  test("renders discovered drives in a dropdown with the selected SMB share and manual popup trigger", () => {
    const html = renderToStaticMarkup(createElement(ComputeSettingsSection, {
      state: computeState(),
      busy: null,
      onScan: noopAsync,
      onSave: async () => true,
      onDownloadSmolLm2: noopAsync,
      onCancelDownload: noopAsync,
    }));
    expect(html).toContain('<select aria-label="Model storage drive"');
    expect(html).toContain("System disk");
    expect(html).toContain("models on nas.local");
    expect(html).toContain('value="/run/user/1000/gvfs/smb-share:server=nas.local,share=models,user=test" selected=""');
    expect(html).toContain('aria-label="Add manual model storage location"');
    expect(html).not.toContain('aria-label="Dataset storage drive"');
    expect(html).not.toContain("Save Dataset storage");
    expect(html).not.toContain('role="radiogroup"');
    expect(html).not.toContain("Choose a writable drive");
    expect(html).not.toContain("model-storage-selection");
    expect(html).not.toContain('placeholder="Choose a local or mounted folder"');
  });

  test("shows the full mounted path inside the manual location dialog", () => {
    const mountedPath = "/run/user/1000/gvfs/smb-share:server=nas.local,share=models,user=test";
    const html = renderToStaticMarkup(createElement(ManualModelStorageDialog, { initialPath: mountedPath, onClose: () => undefined, onUse: () => undefined }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Manual model storage");
    expect(html).toContain(mountedPath);
    expect(html).toContain("Use location");
  });

  test("accepts mounted paths but rejects raw SMB URLs", () => {
    expect(manualStoragePathError("/run/user/1000/gvfs/smb-share:server=nas,share=models")).toBeNull();
    expect(manualStoragePathError("smb://nas/models")).toContain("mounted folder path");
    expect(manualStoragePathError("relative/models")).toBe("Enter an absolute mounted folder path.");
  });
});
