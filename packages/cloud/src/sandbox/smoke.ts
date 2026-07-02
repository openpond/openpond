import type { OpenPondSandboxClient } from "./client.js";
import type {
  SandboxRecord,
  SandboxSmokeOptions,
  SandboxSmokeSummary,
  SandboxSnapshotResponse,
} from "./types/index.js";

export async function runSandboxSmoke(
  client: OpenPondSandboxClient,
  options: SandboxSmokeOptions = {}
): Promise<SandboxSmokeSummary> {
  const runId = `openpond-code-smoke-${Date.now()}`;
  const expectedExec = `openpond-code-exec-ok:${runId}`;
  const expectedPreview = `openpond-code-preview-ok:${runId}`;
  const expectedFile = `openpond-code-file-ok:${runId}`;
  const previewPort = 4173;
  let sandboxId: string | null = null;
  let forkSandboxId: string | null = null;
  let deleted = false;
  let forkDeleted = false;

  try {
    const sandbox = await waitForCreateReady(
      client,
      await client.create(
        {
          repo: options.repo ?? "https://github.com/octocat/Hello-World",
          resources: {
            cpu: options.cpu ?? 1,
            memoryGb: options.memoryGb ?? 1,
            diskGb: options.diskGb ?? 8,
          },
          budget: { maxUsd: options.budgetUsd ?? "0.05" },
          quotas: {
            maxSpendUsd: options.budgetUsd ?? "0.05",
            maxDurationSeconds: 600,
            idleTimeoutSeconds: 600,
            maxOpenPorts: 2,
          },
          metadata: {
            runId,
            source: "openpond-code-sandbox-smoke",
          },
        },
        { async: true }
      )
    );
    sandboxId = sandbox.id;

    const expectedRuntimeDriver =
      options.expectedRuntimeDriver ?? "remote-firecracker";
    if (sandbox.runtimeDriver !== expectedRuntimeDriver) {
      throw new Error(
        `expected ${expectedRuntimeDriver}, got ${sandbox.runtimeDriver}`
      );
    }

    const expectedMppMode = options.expectedMppMode;
    if (expectedMppMode && sandbox.reservation.mpp?.mode !== expectedMppMode) {
      throw new Error(
        `expected ${expectedMppMode} reservation, got ${
          sandbox.reservation.mpp?.mode ?? "none"
        }`
      );
    }
    if (!expectedMppMode && !sandbox.reservation.mpp?.mode) {
      throw new Error("expected sandbox reservation MPP metadata");
    }

    const exec = await client.exec(sandbox.id, {
      command: [
        `printf '${expectedExec}\\n'`,
        "test -f README && printf 'repo-clone-ok\\n'",
        "cat > server.js <<'EOF'",
        `Bun.serve({ port: ${previewPort}, fetch() { return new Response('${expectedPreview}'); } });`,
        "EOF",
        "nohup bun server.js > server.log 2>&1 & sleep 1",
      ].join("\n"),
      timeoutSeconds: 120,
    });
    if (exec.command.status !== "succeeded") {
      throw new Error(`expected command success, got ${exec.command.status}`);
    }
    if (!exec.command.output.includes(expectedExec)) {
      throw new Error("expected exec marker");
    }

    await client.uploadFile(
      sandbox.id,
      "openpond-code-smoke.txt",
      expectedFile
    );
    const downloaded = await client.downloadFile(
      sandbox.id,
      "openpond-code-smoke.txt"
    );
    if (downloaded !== expectedFile) {
      throw new Error("expected file roundtrip marker");
    }

    let snapshotId: string | null = null;
    if (options.snapshot || options.fork) {
      const snapshotResponse = (await client.createSnapshot(sandbox.id, {
        async: true,
        name: `openpond-code-smoke-${runId}`,
        replay: {
          entrypoints: [
            {
              command: "cat openpond-code-smoke.txt",
              name: "default",
            },
          ],
          retention: {
            class: "pinned",
          },
          safety: {
            cleanup: "delete",
            idleTimeoutSeconds: 600,
            internetEgress: "block",
            maxDurationSeconds: 600,
            maxSpendUsd: options.budgetUsd ?? "0.05",
            publicPreview: false,
          },
          validation: {
            commands: [
              {
                command: "test -f openpond-code-smoke.txt",
              },
            ],
          },
        },
      })) as SandboxSnapshotResponse & {
        snapshotJob?: {
          snapshotId?: string;
          status?: string;
          error?: string | null;
        };
      };
      const snapshot =
        snapshotResponse.snapshot ??
        (
          await waitForSnapshotReady(
            client,
            sandbox.id,
            snapshotResponse.snapshotJob?.snapshotId
          )
        ).snapshot;
      snapshotId = snapshot.id;
      if (snapshot.state !== "ready") {
        throw new Error(`expected ready snapshot, got ${snapshot.state}`);
      }
    }

    if (options.fork) {
      if (!snapshotId) {
        throw new Error("expected snapshot id before fork");
      }
      const forked = await waitForCreateReady(
        client,
        (
          await client.forkSnapshot(
            snapshotId,
            {
              budget: { maxUsd: options.budgetUsd ?? "0.05" },
              metadata: {
                source: "openpond-code-sandbox-smoke-fork",
                templateSnapshotId: snapshotId,
              },
            },
            { async: true }
          )
        ).sandbox
      );
      forkSandboxId = forked.id;
      const forkExec = await client.exec(forked.id, {
        command: "cat openpond-code-smoke.txt",
        timeoutSeconds: 120,
      });
      if (forkExec.command.status !== "succeeded") {
        throw new Error(
          `expected fork command success, got ${forkExec.command.status}`
        );
      }
      if (!forkExec.command.output.includes(expectedFile)) {
        throw new Error("expected fork snapshot marker");
      }
      if (!options.keep) {
        await client.delete(forked.id);
        forkDeleted = true;
      }
    }

    let previewStatus: number | null = null;
    if (options.preview !== false) {
      const opened = await client.openPort(sandbox.id, {
        label: "openpond-code-smoke",
        port: previewPort,
      });
      const preview = await fetch(opened.preview.url);
      previewStatus = preview.status;
      const body = await preview.text();
      if (preview.status !== 200) {
        throw new Error(`expected preview HTTP 200, got ${preview.status}`);
      }
      if (!body.includes(expectedPreview)) {
        throw new Error("expected preview marker");
      }
    }

    const stopped = await client.stop(sandbox.id);
    const readback = await client.get(sandbox.id);
    const receipts = await client.receipts(sandbox.id);
    if (stopped.sandbox.state !== "stopped" || readback.state !== "stopped") {
      throw new Error("expected stopped sandbox");
    }
    if (receipts.length === 0) {
      throw new Error("expected receipt readback");
    }

    if (!options.keep) {
      await client.delete(sandbox.id);
      deleted = true;
    }

    return {
      deleted,
      execOutput: exec.command.output.trim(),
      fileRoundtrip: true,
      forkSandboxId,
      previewStatus,
      receiptRefs: receipts.map((receipt) => receipt.mpp.receiptRef ?? null),
      reservationRef: sandbox.reservation.mpp?.reservationRef ?? null,
      runId,
      sandboxId: sandbox.id,
      snapshotId,
      state: readback.state,
    };
  } finally {
    if (forkSandboxId && !options.keep && !forkDeleted) {
      await client.delete(forkSandboxId).catch(() => undefined);
    }
    if (sandboxId && !options.keep && !deleted) {
      await client.delete(sandboxId).catch(() => undefined);
    }
  }
}

async function waitForCreateReady(
  client: OpenPondSandboxClient,
  sandbox: SandboxRecord
): Promise<SandboxRecord> {
  if (sandbox.state === "running" || sandbox.state === "stopped") {
    return sandbox;
  }
  if (sandbox.state === "error") {
    throw new Error(
      `sandbox create failed: ${sandbox.id}\n${sandbox.logs.join("\n")}`
    );
  }

  const timeoutMs = 12 * 60_000;
  const pollMs = 3_000;
  const deadline = Date.now() + timeoutMs;
  let latest = sandbox;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    latest = await client.get(sandbox.id);
    if (latest.state === "running" || latest.state === "stopped") {
      return latest;
    }
    if (latest.state === "error") {
      throw new Error(
        `sandbox create failed: ${latest.id}\n${latest.logs.join("\n")}`
      );
    }
  }

  throw new Error(
    `sandbox create did not reach running state before timeout: ${latest.id} (${latest.state})`
  );
}

async function waitForSnapshotReady(
  client: OpenPondSandboxClient,
  sandboxId: string,
  snapshotId?: string
): Promise<SandboxSnapshotResponse> {
  if (!snapshotId) {
    throw new Error("snapshot job did not return snapshot id");
  }
  const timeoutMs = 12 * 60_000;
  const pollMs = 3_000;
  const deadline = Date.now() + timeoutMs;
  let latest = await client.get(sandboxId);
  while (Date.now() < deadline) {
    const snapshot = latest.snapshots?.find((item) => item.id === snapshotId);
    if (snapshot?.state === "ready") {
      return { sandbox: latest, snapshot };
    }
    const job = latest.snapshotJobs?.find(
      (item) => item.snapshotId === snapshotId
    );
    if (job?.status === "failed") {
      throw new Error(`snapshot job failed: ${job.error ?? snapshotId}`);
    }
    await sleep(pollMs);
    latest = await client.get(sandboxId);
  }
  throw new Error(
    `snapshot did not reach ready state before timeout: ${snapshotId}`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
