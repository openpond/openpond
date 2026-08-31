import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FileOutputRef } from "@openpond/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api, type ClientConnection } from "../apps/web/src/api";
import { OutputsPage } from "../apps/web/src/components/outputs/OutputsPage";
import {
  clearCachedWorkOutputs,
  loadCachedWorkOutputs,
} from "../apps/web/src/components/outputs/useCachedWorkOutputs";

const connection: ClientConnection = {
  arch: "x64",
  platform: "linux",
  serverUrl: "http://localhost:31415",
  token: "test-token",
};

const output: FileOutputRef = {
  id: "output_1",
  title: "report.txt",
  sourceTaskId: "task_1",
  sourceTurnId: "turn_1",
  revision: 1,
  createdAt: "2026-08-07T12:00:00.000Z",
  kind: "file",
  contentType: "text/plain",
  sizeBytes: 12,
  sha256: "a".repeat(64),
  location: {
    kind: "local",
    path: "/tmp/report.txt",
    deviceId: "device_1",
  },
  validation: [],
};

afterEach(() => {
  clearCachedWorkOutputs();
  vi.restoreAllMocks();
});

describe("OutputsPage", () => {
  test("reuses a fresh output response", async () => {
    const workOutputs = vi
      .spyOn(api, "workOutputs")
      .mockResolvedValue({ outputs: [output] });

    const first = await loadCachedWorkOutputs(connection);
    const second = await loadCachedWorkOutputs(connection);

    expect(first).toEqual([output]);
    expect(second).toBe(first);
    expect(workOutputs).toHaveBeenCalledTimes(1);
  });

  test("labels download actions with the output filename", async () => {
    vi.spyOn(api, "workOutputs").mockResolvedValue({ outputs: [output] });
    await loadCachedWorkOutputs(connection);

    const markup = renderToStaticMarkup(
      createElement(OutputsPage, {
        connection,
        onViewChat: () => undefined,
      }),
    );

    expect(markup).toContain('aria-label="Download report.txt"');
  });

  test("deduplicates concurrent output requests", async () => {
    let resolveRequest: ((value: { outputs: FileOutputRef[] }) => void) | undefined;
    vi.spyOn(api, "workOutputs").mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );

    const first = loadCachedWorkOutputs(connection);
    const second = loadCachedWorkOutputs(connection);
    resolveRequest?.({ outputs: [output] });

    await expect(first).resolves.toEqual([output]);
    await expect(second).resolves.toEqual([output]);
    expect(api.workOutputs).toHaveBeenCalledTimes(1);
  });
});
