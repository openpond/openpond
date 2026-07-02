import type { SandboxSmokeOptions } from "../sandbox/types/index";
import {
  parseBooleanOption,
  parseIntegerOption,
  parseNumberOption,
  resolveSandboxClient,
} from "./common";
import { handleSandboxFilesCommand } from "./sandbox-files-command";
import { handleSandboxGitCommand } from "./sandbox-git-command";
import { handleSandboxProcessCommand } from "./sandbox-process-command";
import { handleSandboxReplayCommand } from "./sandbox-replay-command";
import { handleSandboxRuntimeCommand } from "./sandbox-runtime-command";
import { handleSandboxSecretsCommand } from "./sandbox-secrets-command";
import { handleSandboxTemplateBuildsCommand } from "./sandbox-template-builds-command";
import {
  buildSandboxCreateInput,
  buildSandboxIntegrationAttachInput,
  buildSnapshotCreateInput,
  createSandboxFromPlan,
  formatSandboxLine,
  formatSandboxTemplateLine,
  formatSnapshotCatalogLine,
  normalizeSnapshotValidationCleanup,
  summarizeSandbox,
  waitForSandboxCreateReady,
} from "./sandbox-helpers";

export async function runSandboxCommand(
  options: Record<string, string | boolean>,
  rest: string[]
): Promise<void> {
  const subcommand = rest[0] || "list";
  const client = await resolveSandboxClient(options);

  if (subcommand === "list") {
    const teamId =
      typeof options.teamId === "string" ? options.teamId.trim() : "";
    const projectId =
      typeof options.projectId === "string" ? options.projectId.trim() : "";
    const agentId =
      typeof options.agentId === "string" ? options.agentId.trim() : "";
    const sandboxes = await client.list({
      ...(teamId ? { teamId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(agentId ? { agentId } : {}),
    });
    if (sandboxes.length === 0) {
      console.log("no sandboxes found");
      return;
    }
    for (const sandbox of sandboxes) {
      console.log(formatSandboxLine(sandbox));
    }
    return;
  }

  if (subcommand === "mcp-config" || subcommand === "mcp-url") {
    const config = client.mcpServerConfig();
    console.log(
      JSON.stringify(
        {
          ...config,
          headers: {
            "openpond-api-key":
              "set OPENPOND_API_KEY or use your saved openpond profile",
          },
        },
        null,
        2
      )
    );
    return;
  }

  if (await handleSandboxRuntimeCommand(client, subcommand, options, rest)) {
    return;
  }

  if (subcommand === "pricing") {
    const pricing = await client.pricing();
    console.log(JSON.stringify(pricing, null, 2));
    return;
  }

  if (subcommand === "costs") {
    const teamId =
      typeof options.teamId === "string" ? options.teamId.trim() : "";
    const projectId =
      typeof options.projectId === "string" ? options.projectId.trim() : "";
    const agentId =
      typeof options.agentId === "string" ? options.agentId.trim() : "";
    const costs = await client.costs({
      ...(teamId ? { teamId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(agentId ? { agentId } : {}),
    });
    if (parseBooleanOption(options.summary)) {
      console.log(
        JSON.stringify(
          {
            costs: {
              teamId: costs.costs.teamId,
              ownerUserId: costs.costs.ownerUserId,
              generatedAt: costs.costs.generatedAt,
              summary: costs.costs.summary,
              lineItems: costs.costs.lineItems,
              tiers: costs.costs.pricing.tiers.map((tier) => ({
                key: tier.key,
                resources: tier.resources,
                keepRunningEstimate: tier.keepRunningEstimate,
              })),
            },
          },
          null,
          2
        )
      );
      return;
    }
    console.log(JSON.stringify(costs, null, 2));
    return;
  }

  if (await handleSandboxSecretsCommand(client, subcommand, options, rest)) {
    return;
  }

  if (subcommand === "snapshots" || subcommand === "snapshot-catalog") {
    const teamId =
      typeof options.teamId === "string" ? options.teamId.trim() : "";
    const projectId =
      typeof options.projectId === "string" ? options.projectId.trim() : "";
    const agentId =
      typeof options.agentId === "string" ? options.agentId.trim() : "";
    const query =
      typeof options.query === "string" && options.query.trim()
        ? options.query.trim()
        : typeof options.q === "string" && options.q.trim()
        ? options.q.trim()
        : "";
    const tag = typeof options.tag === "string" ? options.tag.trim() : "";
    const useCase =
      typeof options.useCase === "string" ? options.useCase.trim() : "";
    const replayState =
      typeof options.replayState === "string" ? options.replayState.trim() : "";
    const catalog = await client.snapshotCatalog({
      ...(teamId ? { teamId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(query ? { q: query } : {}),
      ...(tag ? { tag } : {}),
      ...(useCase ? { useCase } : {}),
      ...(replayState === "draft" ||
      replayState === "validated" ||
      replayState === "published"
        ? { replayState }
        : {}),
    });
    if (catalog.snapshots.length === 0) {
      console.log("no sandbox snapshots found");
      return;
    }
    for (const snapshot of catalog.snapshots) {
      console.log(formatSnapshotCatalogLine(snapshot));
    }
    return;
  }

  if (
    subcommand === "published-snapshots" ||
    subcommand === "published-snapshot-catalog" ||
    subcommand === "templates" ||
    subcommand === "template-catalog"
  ) {
    const teamId =
      typeof options.teamId === "string" ? options.teamId.trim() : "";
    const projectId =
      typeof options.projectId === "string" ? options.projectId.trim() : "";
    const query =
      typeof options.query === "string" && options.query.trim()
        ? options.query.trim()
        : typeof options.q === "string" && options.q.trim()
        ? options.q.trim()
        : "";
    const name =
      typeof options.name === "string" && options.name.trim()
        ? options.name.trim()
        : typeof options.templateName === "string" &&
          options.templateName.trim()
        ? options.templateName.trim()
        : "";
    const version =
      typeof options.version === "string" ? options.version.trim() : "";
    const tag = typeof options.tag === "string" ? options.tag.trim() : "";
    const useCase =
      typeof options.useCase === "string" ? options.useCase.trim() : "";
    const catalog = await client.publishedSnapshots({
      ...(teamId ? { teamId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(query ? { q: query } : {}),
      ...(name ? { name } : {}),
      ...(version ? { version } : {}),
      ...(tag ? { tag } : {}),
      ...(useCase ? { useCase } : {}),
    });
    if (catalog.publishedSnapshots.length === 0) {
      console.log("no published snapshots found");
      return;
    }
    for (const template of catalog.publishedSnapshots) {
      console.log(formatSandboxTemplateLine(template));
    }
    return;
  }

  if (
    (await handleSandboxTemplateBuildsCommand(
      client,
      subcommand,
      options,
      rest
    )) ||
    (await handleSandboxReplayCommand(client, subcommand, options, rest))
  ) {
    return;
  }

  if (
    subcommand === "run-published-snapshot" ||
    subcommand === "published-snapshot-run" ||
    subcommand === "template-launch" ||
    subcommand === "launch-template"
  ) {
    const teamId =
      typeof options.teamId === "string" ? options.teamId.trim() : "";
    const projectId =
      typeof options.projectId === "string" ? options.projectId.trim() : "";
    const snapshotId =
      typeof options.snapshotId === "string" && options.snapshotId.trim()
        ? options.snapshotId.trim()
        : typeof options.snapshot === "string" && options.snapshot.trim()
        ? options.snapshot.trim()
        : "";
    const templateName =
      typeof options.templateName === "string" && options.templateName.trim()
        ? options.templateName.trim()
        : typeof options.name === "string" && options.name.trim()
        ? options.name.trim()
        : typeof rest[1] === "string" && rest[1].trim()
        ? rest[1].trim()
        : "";
    const version =
      typeof options.version === "string" ? options.version.trim() : "";
    const useCase =
      typeof options.useCase === "string" ? options.useCase.trim() : "";
    if (!snapshotId && !templateName && !useCase) {
      throw new Error(
        "usage: sandbox run-published-snapshot [--snapshot-id <id>|--name <name>|--use-case <id>] [--version <v>]"
      );
    }
    const budgetUsd =
      typeof options.budgetUsd === "string" && options.budgetUsd.trim()
        ? options.budgetUsd.trim()
        : typeof options.budget === "string" && options.budget.trim()
        ? options.budget.trim()
        : "";
    const result = await client.runPublishedSnapshot({
      ...(teamId ? { teamId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(snapshotId ? { snapshotId } : {}),
      ...(templateName ? { templateName } : {}),
      ...(version ? { version } : {}),
      ...(useCase ? { useCase } : {}),
      ...(budgetUsd ? { budget: { maxUsd: budgetUsd } } : {}),
      metadata: {
        source: "openpond-code-published-snapshot-run",
      },
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === "snapshot-fork" || subcommand === "fork-snapshot") {
    const snapshotId = rest[1];
    if (!snapshotId) {
      throw new Error("snapshot-fork requires <snapshotId>");
    }
    const teamId =
      typeof options.teamId === "string" ? options.teamId.trim() : "";
    const projectId =
      typeof options.projectId === "string" ? options.projectId.trim() : "";
    const budgetUsd =
      typeof options.budgetUsd === "string" && options.budgetUsd.trim()
        ? options.budgetUsd.trim()
        : typeof options.budget === "string" && options.budget.trim()
        ? options.budget.trim()
        : "";
    const result = await client.forkSnapshot(snapshotId, {
      ...(teamId ? { teamId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(budgetUsd ? { budget: { maxUsd: budgetUsd } } : {}),
      metadata: {
        source: "openpond-code-snapshot-fork",
        templateSnapshotId: snapshotId,
      },
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === "snapshot-create" || subcommand === "create-snapshot") {
    const sandboxId = rest[1];
    if (!sandboxId) {
      throw new Error(
        "usage: sandbox snapshot-create <sandboxId> --name <name>"
      );
    }
    const result = await client.createSnapshot(
      sandboxId,
      buildSnapshotCreateInput(options)
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (
    subcommand === "snapshot-validate" ||
    subcommand === "validate-snapshot"
  ) {
    const sandboxId = rest[1];
    const snapshotId = rest[2];
    if (!sandboxId || !snapshotId) {
      throw new Error("snapshot-validate requires <sandboxId> <snapshotId>");
    }
    const cleanup = normalizeSnapshotValidationCleanup(options.cleanup);
    const result = await client.validateSnapshot(sandboxId, snapshotId, {
      ...(cleanup ? { cleanup } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === "snapshot-publish" || subcommand === "publish-snapshot") {
    const sandboxId = rest[1];
    const snapshotId = rest[2];
    if (!sandboxId || !snapshotId) {
      throw new Error("snapshot-publish requires <sandboxId> <snapshotId>");
    }
    const result = await client.publishSnapshot(sandboxId, snapshotId);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === "integration-connections") {
    const teamId =
      typeof options.teamId === "string" ? options.teamId.trim() : "";
    const projectId =
      typeof options.projectId === "string" ? options.projectId.trim() : "";
    const agentId =
      typeof options.agentId === "string" ? options.agentId.trim() : "";
    const status =
      options.status === "active" ||
      options.status === "revoked" ||
      options.status === "error" ||
      options.status === "all"
        ? options.status
        : undefined;
    const result = await client.integrationConnections({
      ...(teamId ? { teamId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(status ? { status } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === "create") {
    const result = await createSandboxFromPlan(
      client,
      buildSandboxCreateInput(options)
    );
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          ...(result.runtime ? { runtime: result.runtime } : {}),
        },
        null,
        2
      )
    );
    return;
  }

  if (subcommand === "exec") {
    const sandboxId = rest[1];
    const command =
      (typeof options.command === "string" ? options.command : null) ||
      rest.slice(2).join(" ");
    if (!sandboxId || !command.trim()) {
      throw new Error("usage: sandbox exec <sandboxId> --command <command>");
    }
    const timeoutSeconds = parseIntegerOption(
      options.timeoutSeconds,
      "timeout-seconds"
    );
    const result = await client.exec(sandboxId, {
      command: command.trim(),
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    });
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          command: result.command,
        },
        null,
        2
      )
    );
    return;
  }

  if (subcommand === "port" || subcommand === "preview") {
    const sandboxId = rest[1];
    const port = parseIntegerOption(options.port, "port");
    if (!sandboxId || port === undefined) {
      throw new Error("usage: sandbox port <sandboxId> --port <port>");
    }
    const label = typeof options.label === "string" ? options.label : undefined;
    const rawAccess =
      typeof options.access === "string" ? options.access.trim() : "";
    if (rawAccess && rawAccess !== "private" && rawAccess !== "public") {
      throw new Error("sandbox port --access must be private or public");
    }
    const access = rawAccess === "public" ? "public" : "private";
    const customDomain =
      typeof options.domain === "string" ? options.domain.trim() : "";
    const authToken =
      typeof options.authToken === "string" ? options.authToken : "";
    const authHeader =
      typeof options.authHeader === "string" ? options.authHeader.trim() : "";
    const authHeaderValue =
      typeof options.authHeaderValue === "string"
        ? options.authHeaderValue
        : "";
    if (authToken && (authHeader || authHeaderValue)) {
      throw new Error(
        "sandbox port auth options must use either --auth-token or --auth-header with --auth-header-value"
      );
    }
    if ((authHeader && !authHeaderValue) || (!authHeader && authHeaderValue)) {
      throw new Error(
        "sandbox port custom header auth requires both --auth-header and --auth-header-value"
      );
    }
    const result = await client.openPort(sandboxId, {
      port,
      ...(label ? { label } : {}),
      access,
      ...(options["auto-start"] || options.autoStart
        ? { autoStart: true }
        : {}),
      ...(customDomain ? { customDomain } : {}),
      ...(authToken
        ? { authPolicy: { mode: "bearer", token: authToken } as const }
        : {}),
      ...(authHeader && authHeaderValue
        ? {
            authPolicy: {
              mode: "header",
              headerName: authHeader,
              headerValue: authHeaderValue,
            } as const,
          }
        : {}),
    });
    console.log(JSON.stringify(result.preview, null, 2));
    return;
  }

  if (subcommand === "stop") {
    const sandboxId = rest[1];
    if (!sandboxId) {
      throw new Error(
        "usage: sandbox stop <sandboxId> [--fail-on-unpreserved-changes]"
      );
    }
    const result = await client.stop(sandboxId, {
      failOnUnpreservedChanges: parseBooleanOption(
        options.failOnUnpreservedChanges
      ),
    });
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          receipt: (result as { receipt?: unknown }).receipt,
        },
        null,
        2
      )
    );
    return;
  }

  if (subcommand === "start") {
    const sandboxId = rest[1];
    if (!sandboxId) {
      throw new Error("usage: sandbox start <sandboxId>");
    }
    const result = await client.start(sandboxId);
    console.log(
      JSON.stringify(
        {
          sandbox: await waitForSandboxCreateReady(client, result.sandbox),
          receipt: (result as { receipt?: unknown }).receipt,
        },
        null,
        2
      )
    );
    return;
  }

  if (subcommand === "delete") {
    const sandboxId = rest[1];
    if (!sandboxId) {
      throw new Error(
        "usage: sandbox delete <sandboxId> [--fail-on-unpreserved-changes]"
      );
    }
    const sandbox = await client.delete(sandboxId, {
      failOnUnpreservedChanges: parseBooleanOption(
        options.failOnUnpreservedChanges
      ),
    });
    console.log(
      JSON.stringify({ sandbox: summarizeSandbox(sandbox) }, null, 2)
    );
    return;
  }

  if (subcommand === "receipts") {
    const sandboxId = rest[1];
    if (!sandboxId) {
      throw new Error("usage: sandbox receipts <sandboxId>");
    }
    const receipts = await client.receipts(sandboxId);
    console.log(JSON.stringify({ receipts }, null, 2));
    return;
  }

  if (subcommand === "logs") {
    const sandboxId = rest[1];
    if (!sandboxId) {
      throw new Error("usage: sandbox logs <sandboxId>");
    }
    const logs = await client.logs(sandboxId);
    for (const line of logs) {
      console.log(line);
    }
    return;
  }

  if (
    (await handleSandboxProcessCommand(client, subcommand, options, rest)) ||
    (await handleSandboxFilesCommand(client, subcommand, options, rest)) ||
    (await handleSandboxGitCommand(client, subcommand, options, rest))
  ) {
    return;
  }

  if (subcommand === "billing") {
    const sandboxId = rest[1];
    if (!sandboxId) {
      throw new Error("usage: sandbox billing <sandboxId>");
    }
    const result = await client.billing(sandboxId);
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          billing: result.billing,
        },
        null,
        2
      )
    );
    return;
  }

  if (subcommand === "integration-leases") {
    const sandboxId = rest[1];
    if (!sandboxId) {
      throw new Error("usage: sandbox integration-leases <sandboxId>");
    }
    const result = await client.integrationLeases(sandboxId);
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          integrationLeases: result.integrationLeases,
        },
        null,
        2
      )
    );
    return;
  }

  if (subcommand === "integration-attach") {
    const sandboxId = rest[1];
    if (!sandboxId) {
      throw new Error(
        "usage: sandbox integration-attach <sandboxId> --integration-connection <id> --integration-capabilities <csv>"
      );
    }
    const result = await client.attachIntegrationConnection(
      sandboxId,
      buildSandboxIntegrationAttachInput(options)
    );
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          integrationLeases: result.integrationLeases,
        },
        null,
        2
      )
    );
    return;
  }

  if (subcommand === "integration-remove") {
    const sandboxId = rest[1];
    const leaseId =
      typeof options.leaseId === "string" ? options.leaseId.trim() : "";
    if (!sandboxId || !leaseId) {
      throw new Error(
        "usage: sandbox integration-remove <sandboxId> --lease-id <id>"
      );
    }
    const result = await client.removeIntegrationLease(sandboxId, leaseId);
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          integrationLeases: result.integrationLeases,
        },
        null,
        2
      )
    );
    return;
  }

  if (subcommand === "smoke") {
    const repo =
      typeof options.repo === "string" ? options.repo.trim() : undefined;
    const budgetUsd =
      typeof options.budgetUsd === "string"
        ? options.budgetUsd.trim()
        : typeof options.budget === "string"
        ? options.budget.trim()
        : undefined;
    const keep = parseBooleanOption(options.keep);
    const preview =
      options.preview !== undefined
        ? parseBooleanOption(options.preview)
        : !parseBooleanOption(options.noPreview);
    const snapshot = parseBooleanOption(options.snapshot);
    const fork = parseBooleanOption(options.fork);
    const smokeOptions: SandboxSmokeOptions = {
      ...(repo ? { repo } : {}),
      ...(budgetUsd ? { budgetUsd } : {}),
      keep,
      preview,
      snapshot,
      fork,
    };
    if (
      typeof options.expectedMppMode === "string" &&
      options.expectedMppMode.trim()
    ) {
      smokeOptions.expectedMppMode =
        options.expectedMppMode.trim() as SandboxSmokeOptions["expectedMppMode"];
    }
    const cpu = parseNumberOption(options.cpu, "cpu");
    const memoryGb = parseNumberOption(options.memoryGb, "memory-gb");
    const diskGb = parseNumberOption(options.diskGb, "disk-gb");
    if (cpu !== undefined) smokeOptions.cpu = cpu;
    if (memoryGb !== undefined) smokeOptions.memoryGb = memoryGb;
    if (diskGb !== undefined) smokeOptions.diskGb = diskGb;
    const summary = await client.smoke(smokeOptions);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  throw new Error(
    "usage: sandbox <list|mcp-config|runtime-list|runtime-get|runtime-events|runtime-status|runtime-event|runtime-preserve-source|pricing|costs|secrets|secret-create|secret-rotate|secret-attach|secret-revoke|secret-delete|snapshots|published-snapshots|run-published-snapshot|snapshot-fork|snapshot-validate|snapshot-publish|create|exec|port|preview|stop|start|delete|receipts|logs|billing|process-start|process-list|process-get|process-stop|process-stream|pty-start|pty-list|pty-get|pty-write|pty-stop|pty-stream|upload-file|download-file|list-files|search-files|delete-file|stat-file|mkdir|move-file|git-status|git-diff|git-export-patch|git-branch|git-commit|git-pull|git-push|smoke> [args]"
  );
}
