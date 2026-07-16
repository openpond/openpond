import { describe, expect, test } from "vitest";

import {
  DesktopProcessTreeSampler,
  parseUnixProcessRows,
  parseWindowsProcessRows,
  sampleProcessTree,
  summarizeProcessTree,
  type ProcessTreeSample,
} from "../apps/desktop/src/desktop-process-sampler";

describe("desktop process tree sampler", () => {
  test("parses Unix ps rows and converts RSS KiB to bytes", () => {
    expect(
      parseUnixProcessRows(`
        100     1   1.5  256
        101   100   0.25 512
        invalid row
        102   100   nope 128
      `),
    ).toEqual([
      { pid: 100, ppid: 1, cpuPercent: 1.5, rssBytes: 262_144 },
      { pid: 101, ppid: 100, cpuPercent: 0.25, rssBytes: 524_288 },
    ]);
  });

  test("parses Windows process JSON rows", () => {
    expect(
      parseWindowsProcessRows(
        JSON.stringify([
          { pid: 200, ppid: 4, cpuPercent: 3.25, rssBytes: 4096 },
          { pid: 201, ppid: 200, cpuPercent: 0, rssBytes: 8192 },
          { pid: "bad", ppid: 200, cpuPercent: 1, rssBytes: 1 },
        ]),
      ),
    ).toEqual([
      { pid: 200, ppid: 4, cpuPercent: 3.25, rssBytes: 4096 },
      { pid: 201, ppid: 200, cpuPercent: 0, rssBytes: 8192 },
    ]);
  });

  test("summarizes only the requested root process and descendants", () => {
    const sample = summarizeProcessTree(
      100,
      [
        { pid: 1, ppid: 0, cpuPercent: 0.1, rssBytes: 100 },
        { pid: 100, ppid: 1, cpuPercent: 1.234, rssBytes: 1_000 },
        { pid: 101, ppid: 100, cpuPercent: 0.111, rssBytes: 2_000 },
        { pid: 102, ppid: 101, cpuPercent: 2.345, rssBytes: 3_000 },
        { pid: 200, ppid: 1, cpuPercent: 9, rssBytes: 9_000 },
      ],
      "2026-07-01T00:00:00.000Z",
    );

    expect(sample).toEqual({
      sampledAt: "2026-07-01T00:00:00.000Z",
      rootPid: 100,
      processCount: 3,
      cpuPercent: 3.69,
      rssBytes: 6_000,
      processes: [
        { pid: 100, ppid: 1, cpuPercent: 1.234, rssBytes: 1_000 },
        { pid: 101, ppid: 100, cpuPercent: 0.111, rssBytes: 2_000 },
        { pid: 102, ppid: 101, cpuPercent: 2.345, rssBytes: 3_000 },
      ],
    });
  });

  test("keeps a bounded retention window of recent samples", async () => {
    let sampleIndex = 0;
    let clock = 0;
    const sampler = new DesktopProcessTreeSampler({
      maxSamples: 2,
      sampleIntervalMs: 60_000,
      dateNow: () => `sample-${++clock}`,
      sampler: async (rootPid, dateNow): Promise<ProcessTreeSample> => {
        sampleIndex += 1;
        return {
          sampledAt: dateNow(),
          rootPid,
          processCount: 1,
          cpuPercent: sampleIndex,
          rssBytes: sampleIndex * 1024,
          processes: [
            {
              pid: rootPid,
              ppid: 1,
              cpuPercent: sampleIndex,
              rssBytes: sampleIndex * 1024,
            },
          ],
        };
      },
    });

    try {
      sampler.start(123);
      await Promise.resolve();
      await sampler.sampleNow();
      await sampler.sampleNow();

      const snapshot = sampler.snapshot();
      expect(snapshot.activePid).toBe(123);
      expect(snapshot.maxSamples).toBe(2);
      expect(snapshot.maxProcessRows).toBe(128);
      expect(snapshot.samples.map((sample) => sample.rssBytes)).toEqual([1_024, 2_048]);
      expect(snapshot.lastError).toBeNull();
    } finally {
      sampler.stop();
    }
  });

  test("allows only one in-flight sample and bounds reported process rows", async () => {
    let calls = 0;
    let release!: (sample: ProcessTreeSample) => void;
    const pending = new Promise<ProcessTreeSample>((resolve) => { release = resolve; });
    const sampler = new DesktopProcessTreeSampler({
      maxProcessRows: 2,
      sampleIntervalMs: 60_000,
      sampler: async () => { calls += 1; return pending; },
    });
    sampler.start(10);
    const first = sampler.sampleNow();
    const second = sampler.sampleNow();
    expect(second).toBe(first);
    expect(calls).toBe(1);
    release({
      sampledAt: "now",
      rootPid: 10,
      processCount: 3,
      cpuPercent: 1,
      rssBytes: 3,
      processes: [
        { pid: 10, ppid: 1, cpuPercent: 1, rssBytes: 1 },
        { pid: 11, ppid: 10, cpuPercent: 0, rssBytes: 1 },
      ],
    });
    await first;
    expect(sampler.snapshot().samples).toHaveLength(1);
    sampler.stop();
  });

  test("samples the current Unix process tree with real process metrics", async () => {
    if (process.platform === "win32") return;

    const sample = await sampleProcessTree(process.pid, () => "2026-07-01T00:00:00.000Z");

    expect(sample).not.toBeNull();
    expect(sample?.rootPid).toBe(process.pid);
    expect(sample?.processCount).toBeGreaterThanOrEqual(1);
    expect(sample?.rssBytes).toBeGreaterThan(0);
    expect(sample?.processes.some((row) => row.pid === process.pid)).toBe(true);
  });
});
