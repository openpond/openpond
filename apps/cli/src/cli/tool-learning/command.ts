import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { readCredential } from "@openpond/persistence";
import { contentHash } from "@openpond/harness";
import { assertBoundedTaskJson } from "@openpond/evals/task-schema";
import {
  ToolEpisodeAppendSchema,
  ToolLearningRegistrationSchema,
  ToolLearningRoutingRequestSchema,
  prepareToolLearningRegistration,
  OpenPondToolLearningClient,
  ToolLearningEnvironmentSchema,
} from "openpond-sdk/tool-learning";
import { ToolLearningLocalStore } from "openpond-sdk/tool-learning/node";
import { scanAndRedactEvidence } from "openpond-sdk/training-bundle";
import { hostedTrainingAccount } from "../hosted-training-account";
import { optionString } from "../common/options";
import {
  ToolLearningCredentialRecordSchema,
  loadToolLearningCredential,
  saveToolLearningCredential,
  toolLearningCredentialId,
  toolLearningHome,
  toolLearningOwner,
  toolLearningProducer,
  type ToolLearningCredentialRecord,
  type ToolLearningOptions,
} from "./credentials";
import { configureLocalToolLearning, flushToolLearning } from "./delivery";

import {
  installClaudeToolLearning,
  uninstallClaudeToolLearning,
  doctorToolLearning,
} from "./installation";
import { runToolLearningHook } from "./hook";
import { installExternalToolLearning, uninstallExternalToolLearning, doctorExternalToolLearning } from "./external-installation";
import { runExternalToolLearningHook } from "./external-hook";
import { runCodexWithCapture } from "./codex-run";

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
async function inputJson(options: ToolLearningOptions) {
  const path = optionString(options, "inputFile");
  if (!path) throw new Error("This operation requires --input-file <absolute-json-path>.");
  const bytes = await readFile(path);
  if (bytes.byteLength > 2097152) throw new Error("Tool learning input exceeds 2 MiB.");
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  assertBoundedTaskJson(value, 2097152);
  return value;
}

async function register(options: ToolLearningOptions, preparedRegistration?: unknown) {
  let environment = null;
  const environmentFile = optionString(options, "environmentFile");
  if (environmentFile) {
    const bytes = await readFile(environmentFile);
    if (bytes.byteLength > 16384) throw new Error("Environment context exceeds 16 KiB.");
    const context = ToolLearningEnvironmentSchema.partial({ fingerprint: true }).parse(
      JSON.parse(bytes.toString("utf8")),
    );
    environment = ToolLearningEnvironmentSchema.parse({
      ...context,
      fingerprint: context.fingerprint ?? contentHash(context),
    });
    const privacy = scanAndRedactEvidence(JSON.stringify(environment));
    if (privacy.secretStatus !== "passed" || privacy.piiStatus !== "passed")
      throw new Error("Remove private data from the environment context.");
  }
  const registration = ToolLearningRegistrationSchema.parse(
    preparedRegistration ?? (await inputJson(options)),
  );
  if (!["claude_code", "openpond", "codex", "opencode"].includes(registration.client))
    throw new Error("This client is outside the current tool learning release.");
  if (
    optionString(options, "projectId") &&
    optionString(options, "projectId") !== registration.projectId
  )
    throw new Error("The selected Model Project differs from the registration.");
  const home = toolLearningHome(options);
  const workspaceRoot = await realpath(
    resolve(optionString(options, "workspace") || optionString(options, "cwd") || process.cwd()),
  );
  if (!registration.collectionPolicy.workspaceRootHashes.includes(contentHash(workspaceRoot)))
    throw new Error("The collection policy must explicitly include this workspace root hash.");
  const { context, baseUrl, teamId } = await hostedTrainingAccount(options);
  const id = registration.installationId;
  const existing = await readCredential<ToolLearningCredentialRecord>(
    home,
    toolLearningCredentialId(id),
  );
  let revision = existing?.revision ?? null;
  let record: ToolLearningCredentialRecord;
  if (existing) {
    record = ToolLearningCredentialRecordSchema.parse(existing.value);
    if (
      record.apiOrigin !== new URL(baseUrl).origin ||
      record.teamId !== teamId ||
      record.workspaceRoot !== workspaceRoot ||
      contentHash(record.prepared.registration) !== contentHash(registration) ||
      (environmentFile !== "" && contentHash(record.environment) !== contentHash(environment))
    )
      throw new Error(
        "This installation is already bound to different registration bytes or workspace. Use a new installation ID.",
      );
  } else {
    record = ToolLearningCredentialRecordSchema.parse({
      schemaVersion: "openpond.toolLearningLocalCredential.v1",
      apiOrigin: new URL(baseUrl).origin,
      teamId,
      projectId: registration.projectId,
      workspaceRoot,
      ownerAccount: context.account?.handle ?? null,
      locallyEnabled: true,
      environment,
      prepared: prepareToolLearningRegistration(
        registration,
        optionString(options, "expiresAt") || new Date(Date.now() + 30 * 86400000).toISOString(),
      ),
      installation: null,
    });
    // Persist the issuer's prepared secret in the existing encrypted vault
    // before the first effect, so a lost HTTP response is safely recoverable.
    revision = await saveToolLearningCredential(home, record, null);
  }
  const store = new ToolLearningLocalStore(home);
  try {
    configureLocalToolLearning(store, record, null);
    const client = new OpenPondToolLearningClient({
      baseUrl,
      apiKey: context.token,
      teamId,
      projectId: registration.projectId,
    });
    const result = await client.register(record.prepared);
    record = { ...record, installation: result.installation };
    await saveToolLearningCredential(home, record, revision);
    configureLocalToolLearning(store, record, result.installation);
    return {
      installation: result.installation,
      local: store.status(id),
      credentials: "stored_privately",
      learningEnrollment: false,
    };
  } finally {
    store.close();
  }
}

export async function runToolLearningCommand(options: ToolLearningOptions, rest: string[]) {
  const [action, id, episodeId] = rest;
  if (
    !action ||
    ![
      "register",
      "setup",
      "run",
      "routing",
      "configure",
      "install",
      "doctor",
      "uninstall",
      "hook",
      "opencode-hook",
      "mcp",
      "status",
      "append",
      "flush",
      "episodes",
      "episode",
      "project",
      "disable",
      "enable",
      "revoke",
      "purge",
    ].includes(action) ||
    rest.length > (action === "episode" ? 3 : 2)
  )
    throw new Error(
      "Use tool-learning <register|status|append|flush|episodes|episode|project|disable|enable|revoke|purge> [installation-id].",
    );
  if (action === "setup") {
    if (id) throw new Error("Setup takes --project-id, not an installation argument.");
    const registration = await (await import("./setup")).prepareToolLearningSetup(options);
    const registered = await register(options, registration);
    const integration =
      registration.client === "claude_code"
        ? await installClaudeToolLearning(options, registration.installationId)
        : registration.client === "codex" || registration.client === "opencode"
          ? await installExternalToolLearning(options, registration.installationId)
          : { bundled: true, restartSession: true };
    print({
      ...registered,
      integration,
      next: "Restart the client, then run tool-learning doctor. Review evidence separately before training.",
    });
    return;
  }
  if (action === "register") {
    if (id) throw new Error("Registration takes --input-file, not an installation argument.");
    print(await register(options));
    return;
  }
  if (!id) throw new Error("Select a tool learning installation ID.");
  if (["hook", "opencode-hook"].includes(action)) {
    try {
      if (action === "hook") await runToolLearningHook(options, id);
      else await runExternalToolLearningHook(options, id, "opencode");
    } catch {
      process.stderr.write("OpenPond capture was unavailable; run tool-learning doctor.\n");
    }
    return;
  }
  if (action === "mcp") {
    await (
      await import("@openpond/local-server/tool-learning")
    ).runToolLearningMcp(toolLearningHome(options), id);
    return;
  }
  if (action === "run") { await runCodexWithCapture(options, id); return; }
  if (action === "install") {
    const { value } = await loadToolLearningCredential(toolLearningHome(options), id);
    print(await (value.prepared.registration.client === "codex" || value.prepared.registration.client === "opencode" ? installExternalToolLearning : installClaudeToolLearning)(options, id));
    return;
  }
  if (action === "doctor") {
    const { value } = await loadToolLearningCredential(toolLearningHome(options), id);
    print(await (value.prepared.registration.client === "codex" || value.prepared.registration.client === "opencode" ? doctorExternalToolLearning : doctorToolLearning)(options, id));
    return;
  }
  const home = toolLearningHome(options);
  let saved = await loadToolLearningCredential(home, id);
  let record = saved.value;
  const store = new ToolLearningLocalStore(home);
  try {
    if (action === "routing" || action === "configure") {
      const owner = await toolLearningOwner(options, record);
      print(
        action === "routing"
          ? await owner.routing(id)
          : await owner.configureRouting(
              id,
              ToolLearningRoutingRequestSchema.parse(await inputJson(options)),
            ),
      );
      return;
    }
    if (action === "status") {
      const remote =
        !record.installation || record.installation.state === "revoked"
          ? record.installation
          : await toolLearningProducer(record).installation(id);
      if (remote) configureLocalToolLearning(store, record, remote);
      print({
        installation: remote,
        registrationPending: remote === null,
        locallyEnabled: record.locallyEnabled,
        local: store.status(id),
        learningEnrollment: false,
      });
      return;
    }
    if (action === "append") {
      if (!record.locallyEnabled || !record.installation)
        throw new Error("This installation is disabled or has not completed registration.");
      const input = ToolEpisodeAppendSchema.parse(await inputJson(options));
      if (input.installationId !== id) throw new Error("Append belongs to another installation.");
      configureLocalToolLearning(store, record, record.installation);
      for (const event of input.events) {
        const scan = scanAndRedactEvidence(JSON.stringify(event.payload));
        if (scan.secretStatus !== "passed" || scan.piiStatus !== "passed")
          throw new Error("Remove private data before adding this event to the local queue.");
        const result = store.append(event);
        if (!["retained", "already_retained"].includes(result))
          throw new Error(`Tool learning capture could not retain this event: ${result}.`);
      }
    }
    if (action === "append" || action === "flush") {
      const seconds = Number(optionString(options, "timeoutSec") || "10");
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60)
        throw new Error("--timeout-sec must be between 1 and 60.");
      print(await flushToolLearning(home, store, record, AbortSignal.timeout(seconds * 1000)));
      return;
    }
    const owner = await toolLearningOwner(options, record);
    if (action === "episodes") {
      print(await owner.episodes(id, optionString(options, "after") || undefined));
      return;
    }
    if (action === "episode") {
      if (!episodeId) throw new Error("Select an episode ID.");
      print(await owner.episode(id, episodeId));
      return;
    }
    if (action === "project") {
      print(
        await owner.project(id, (await inputJson(options)) as Parameters<typeof owner.project>[1]),
      );
      return;
    }
    const state =
      action === "disable"
        ? "disabled"
        : action === "enable"
          ? "enabled"
          : action === "revoke" || action === "uninstall"
            ? "revoked"
            : null;
    if (state) {
      if (state !== "enabled") {
        record = { ...record, locallyEnabled: false };
        const revision = await saveToolLearningCredential(home, record, saved.revision);
        saved = { revision, value: record };
        configureLocalToolLearning(store, record, null);
      }
      const current = await owner.installation(id);
      const remote =
        current.state === state
          ? current
          : await owner.setState(id, {
              operationId: crypto.randomUUID(),
              expectedRevision: current.revision,
              state,
            });
      record = { ...record, installation: remote, locallyEnabled: state === "enabled" };
      await saveToolLearningCredential(home, record, saved.revision);
      configureLocalToolLearning(store, record, remote);
      print({
        installation: remote,
        locallyEnabled: record.locallyEnabled,
        local: store.status(id),
        ...(action === "uninstall"
          ? { client: await (record.prepared.registration.client === "codex" || record.prepared.registration.client === "opencode" ? uninstallExternalToolLearning : uninstallClaudeToolLearning)(options, id) }
          : {}),
      });
      return;
    }
    if (action === "purge") {
      const current = await owner.installation(id);
      print(
        await owner.purge(id, {
          operationId: crypto.randomUUID(),
          expectedRevision: current.revision,
        }),
      );
      return;
    }
    throw new Error("Unknown tool learning operation.");
  } finally {
    store.close();
  }
}
