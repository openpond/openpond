import type { OpenPondSandboxClient } from "./client.js";
import type {
  SandboxReceipt,
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
        "cat > server.cjs <<'EOF'",
        "const { createServer } = require('node:http');",
        `createServer((_request, response) => response.end('${expectedPreview}')).listen(${previewPort}, '0.0.0.0');`,
        "EOF",
        "nohup node server.cjs > server.log 2>&1 & sleep 1",
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
        await deleteSandboxForSmoke(client, forked.id);
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

    const { sandbox: readback, receipts } = await stopSandboxForSmoke(
      client,
      sandbox.id
    );

    if (!options.keep) {
      await deleteSandboxForSmoke(client, sandbox.id);
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
      await cleanupSandboxBestEffort(client, forkSandboxId);
    }
    if (sandboxId && !options.keep && !deleted) {
      await cleanupSandboxBestEffort(client, sandboxId);
    }
  }
}

async function stopSandboxForSmoke(
  client: OpenPondSandboxClient,
  sandboxId: string
): Promise<{ sandbox: SandboxRecord; receipts: SandboxReceipt[] }> {
  try {
    await client.stop(sandboxId);
  } catch {
    await client.stop(sandboxId, { async: true });
  }
  const sandbox = await waitForSandboxState(
    client,
    sandboxId,
    new Set(["stopped", "deleted"]),
    "stop"
  );
  const receipts = await waitForReceipts(client, sandboxId);
  if (receipts.length === 0) {
    throw new Error("expected receipt readback");
  }
  return { sandbox, receipts };
}

async function deleteSandboxForSmoke(
  client: OpenPondSandboxClient,
  sandboxId: string
): Promise<SandboxRecord> {
  try {
    const deleted = await client.delete(sandboxId);
    if (deleted.state === "deleted") {
      return deleted;
    }
    await client.delete(sandboxId, { async: true });
  } catch {
    await client.delete(sandboxId, { async: true });
  }
  return waitForSandboxState(
    client,
    sandboxId,
    new Set(["deleted"]),
    "delete"
  );
}

async function cleanupSandboxBestEffort(
  client: OpenPondSandboxClient,
  sandboxId: string
): Promise<void> {
  try {
    await deleteSandboxForSmoke(client, sandboxId);
  } catch {
    await client.delete(sandboxId, { async: true }).catch(() => undefined);
  }
}

async function waitForSandboxState(
  client: OpenPondSandboxClient,
  sandboxId: string,
  targetStates: Set<SandboxRecord["state"]>,
  operation: "delete" | "stop"
): Promise<SandboxRecord> {
  const timeoutMs = 5 * 60_000;
  const pollMs = 3_000;
  const deadline = Date.now() + timeoutMs;
  let latest = await client.get(sandboxId);
  while (Date.now() < deadline) {
    if (targetStates.has(latest.state)) {
      return latest;
    }
    if (latest.state === "error") {
      throw new Error(`sandbox ${operation} failed: ${sandboxId}`);
    }
    await sleep(pollMs);
    latest = await client.get(sandboxId);
  }
  throw new Error(
    `sandbox ${operation} did not reach ${[...targetStates].join(
      "/"
    )} before timeout: ${sandboxId} (${latest.state})`
  );
}

async function waitForReceipts(
  client: OpenPondSandboxClient,
  sandboxId: string
): Promise<SandboxReceipt[]> {
  const timeoutMs = 2 * 60_000;
  const pollMs = 3_000;
  const deadline = Date.now() + timeoutMs;
  let receipts = await client.receipts(sandboxId);
  while (Date.now() < deadline) {
    if (receipts.length > 0) {
      return receipts;
    }
    await sleep(pollMs);
    receipts = await client.receipts(sandboxId);
  }
  return receipts;
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
