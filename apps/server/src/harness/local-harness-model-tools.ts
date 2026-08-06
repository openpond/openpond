import { promises as fs } from "node:fs";
import path from "node:path";

import { HarnessSourceManifestSchema } from "@openpond/contracts";

import type { ModelToolDefinition } from "../openpond/model-tool-registry.js";
import type { SqliteStore } from "../store/store.js";
import { loadLocalHarnessRuntimeForAgentRun } from "./local-harness-run-overlay.js";

const MAX_INSPECT_BYTES = 24_000;

export function createLocalHarnessModelToolDefinitions(input: {
  store: SqliteStore;
}): ModelToolDefinition[] {
  return [
    {
      name: "memory_search",
      description:
        "Search bounded active Personal Harness memory without loading the full memory corpus into context. Returns ranked stable memory keys and excerpts.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", minLength: 1, maxLength: 500 },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["query"],
      },
      execute: async (context) => {
        const runtime = await loadLocalHarnessRuntimeForAgentRun(input.store, context.session.id);
        if (!runtime) throw new Error("No Local Harness is selected for this run.");
        const query = boundedText(context.args.query, 500).toLowerCase();
        const terms = [...new Set(query.split(/[^a-z0-9]+/).filter((term) => term.length > 1))];
        const limit = typeof context.args.limit === "number"
          ? Math.max(1, Math.min(20, Math.trunc(context.args.limit)))
          : 8;
        const memories = await input.store.listHarnessMemories(runtime.workspace.id);
        const matches = memories
          .map((entry) => {
            const haystack = `${entry.key} ${entry.tags.join(" ")} ${entry.content}`.toLowerCase();
            const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
            return { entry, score };
          })
          .filter(({ score }) => terms.length === 0 || score > 0)
          .sort((left, right) => right.score - left.score || right.entry.updatedAt.localeCompare(left.entry.updatedAt))
          .slice(0, limit)
          .map(({ entry, score }) => ({
            key: entry.key,
            revision: entry.revision,
            score,
            excerpt: entry.content.slice(0, 1_000),
            tags: entry.tags,
            updatedAt: entry.updatedAt,
          }));
        return modelResult(context.callId, "memory_search", { query, matches });
      },
    },
    {
      name: "memory_inspect",
      description: "Read one exact active Personal Harness memory entry returned by memory_search.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { key: { type: "string", minLength: 1, maxLength: 120 } },
        required: ["key"],
      },
      execute: async (context) => {
        const runtime = await loadLocalHarnessRuntimeForAgentRun(input.store, context.session.id);
        if (!runtime) throw new Error("No Local Harness is selected for this run.");
        const key = boundedText(context.args.key, 120).toLowerCase();
        const entry = await input.store.getHarnessMemory(runtime.workspace.id, key);
        if (!entry || entry.status !== "active") throw new Error(`Harness memory does not exist: ${key}.`);
        return modelResult(context.callId, "memory_inspect", entry);
      },
    },
    {
      name: "context_read",
      description:
        "Read a bounded slice of the current Agent run's canonical host-owned turns or runtime events. This never exposes other conversations or the whole history corpus.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          scope: { type: "string", enum: ["turns", "events"] },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
        required: ["scope"],
      },
      execute: async (context) => {
        const limit = typeof context.args.limit === "number"
          ? Math.max(1, Math.min(50, Math.trunc(context.args.limit)))
          : 12;
        if (context.args.scope === "turns") {
          const turns = await input.store.turnsForSession(context.session.id, limit);
          return modelResult(context.callId, "context_read", {
            scope: "turns",
            values: turns.map((turn) => boundedJson(turn, 6_000)),
          });
        }
        if (context.args.scope === "events") {
          const events = await input.store.runtimeEventsForSession(context.session.id, { limit });
          return modelResult(context.callId, "context_read", {
            scope: "events",
            values: events.map((event) => boundedJson(event, 6_000)),
          });
        }
        throw new Error("context_read scope must be turns or events.");
      },
    },
    {
      name: "harness_inspect",
      description:
        "Inspect the immutable Harness release pinned to this Agent run. With no path, returns its release, overlay, and component catalog. With a policy-visible text path, returns bounded exact source content.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: {
            type: "string",
            minLength: 1,
            description: "Optional exact Harness-relative source path from the returned catalog.",
          },
        },
      },
      execute: async (context) => {
        const runtime = await loadLocalHarnessRuntimeForAgentRun(input.store, context.session.id);
        if (!runtime) throw new Error("No Local Harness release is selected for this run.");
        const overlay = await input.store.getHarnessRunOverlay(context.session.id);
        const sourceRoot = path.join(runtime.release.bundlePath, "source");
        const manifest = HarnessSourceManifestSchema.parse(
          JSON.parse(await fs.readFile(path.join(sourceRoot, "harness.json"), "utf8")),
        );
        const requestedPath = typeof context.args.path === "string"
          ? context.args.path.trim().replaceAll("\\", "/")
          : null;
        let source: { path: string; content: string; truncated: boolean } | null = null;
        if (requestedPath) {
          const declaration = manifest.files.find((file) => file.path === requestedPath);
          if (!declaration || declaration.visibility !== "policy") {
            throw new Error(`Harness source is not policy-visible or declared: ${requestedPath}`);
          }
          if (!declaration.mediaType.startsWith("text/") && declaration.mediaType !== "application/json") {
            throw new Error(`Harness source is not inspectable text: ${requestedPath}`);
          }
          const content = await fs.readFile(containedSourcePath(sourceRoot, requestedPath), "utf8");
          source = {
            path: requestedPath,
            content: content.slice(0, MAX_INSPECT_BYTES),
            truncated: content.length > MAX_INSPECT_BYTES,
          };
        }
        return modelResult(context.callId, "harness_inspect", {
          workspace: {
            id: runtime.workspace.id,
            name: runtime.workspace.name,
            revision: runtime.workspace.revision,
            channel: runtime.workspace.currentChannel,
          },
          pinnedRelease: {
            id: runtime.release.harnessRelease.id,
            contentHash: runtime.release.harnessRelease.contentHash,
            sourceRevision: runtime.release.sourceRevision,
          },
          overlay: overlay
            ? { id: overlay.id, revision: overlay.revision, status: overlay.status, contentHash: overlay.contentHash }
            : null,
          components: manifest.files
            .filter((file) => file.visibility === "policy")
            .map((file) => ({ kind: file.kind, path: file.path, portability: file.portability })),
          source,
        });
      },
    },
    {
      name: "skill_inspect",
      description:
        "Read one exact textual Skill from the immutable Harness release pinned to this run. Use this before asking the Refiner to update an existing Skill.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1, description: "Exact Skill name from harness_inspect." },
        },
        required: ["name"],
      },
      execute: async (context) => {
        const runtime = await loadLocalHarnessRuntimeForAgentRun(input.store, context.session.id);
        const name = typeof context.args.name === "string" ? context.args.name.trim() : "";
        if (!runtime?.skillRuntime.readSkill || !name) {
          throw new Error("A valid Skill name and a selected Local Harness are required.");
        }
        return modelResult(
          context.callId,
          "skill_inspect",
          await runtime.skillRuntime.readSkill(name),
        );
      },
    },
    {
      name: "refine_request",
      description:
        "Mark a concrete reusable lesson from the current turn for bounded Harness refinement at the next safe tool boundary. Immediate task recovery remains your responsibility. Do not call for one-off errors or transient facts.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string", minLength: 1, maxLength: 2000 },
          suggestedRoute: {
            type: "string",
            enum: ["runtime", "memory", "prompt", "skill", "agent", "product", "taskset", "training"],
          },
        },
        required: ["summary"],
      },
      execute: async (context) => modelResult(context.callId, "refine_request", {
        queuedAtBoundary: true,
        summary: boundedText(context.args.summary, 2_000),
        suggestedRoute: typeof context.args.suggestedRoute === "string"
          ? context.args.suggestedRoute
          : null,
      }),
    },
    {
      name: "refine_status",
      description:
        "Inspect bounded Refiner trigger, proposal, route, validation, and outcome status for this Agent run.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: async (context) => {
        const runtime = await loadLocalHarnessRuntimeForAgentRun(input.store, context.session.id);
        if (!runtime) throw new Error("No Local Harness is selected for this run.");
        const all = async (kind: Parameters<SqliteStore["listHarnessImprovementArtifacts"]>[1]) =>
          input.store.listHarnessImprovementArtifacts(runtime.workspace.id, kind, 200);
        const triggers = (await all("trigger_decision")).filter(
          (artifact): artifact is Extract<typeof artifact, { schemaVersion: "openpond.refinementTriggerDecision.v1" }> =>
            artifact.schemaVersion === "openpond.refinementTriggerDecision.v1",
        ).filter(
          (artifact) => artifact.runRef === context.session.id,
        );
        const triggerRefs = new Set(triggers.map((artifact) => artifactRefKey(artifact)));
        const relatedToTrigger = (artifact: Record<string, unknown>) =>
          triggerRefs.has(artifactRefKey(asRecord(artifact.trigger)));
        const routes = (await all("route_decision")).filter(
          (artifact): artifact is Extract<typeof artifact, { schemaVersion: "openpond.improvementRouteDecision.v1" }> =>
            artifact.schemaVersion === "openpond.improvementRouteDecision.v1",
        ).filter(relatedToTrigger);
        const outcomes = (await all("refiner_outcome")).filter(
          (artifact): artifact is Extract<typeof artifact, { schemaVersion: "openpond.harnessRefinerOutcome.v1" }> =>
            artifact.schemaVersion === "openpond.harnessRefinerOutcome.v1",
        ).filter(relatedToTrigger);
        const proposalRefs = new Set(
          outcomes.flatMap((artifact) => {
            const proposal = asRecord(artifact.proposal);
            return proposal.id && proposal.contentHash ? [artifactRefKey(proposal)] : [];
          }),
        );
        const proposals = (await all("proposal")).filter(
          (artifact): artifact is Extract<typeof artifact, { schemaVersion: "openpond.harnessImprovementProposal.v1" }> =>
            artifact.schemaVersion === "openpond.harnessImprovementProposal.v1",
        ).filter((artifact) =>
          proposalRefs.has(artifactRefKey(artifact)),
        );
        const relatedToProposal = (artifact: Record<string, unknown>) =>
          proposalRefs.has(artifactRefKey(asRecord(artifact.proposal)));
        const artifacts = [
          { kind: "trigger_decision", values: triggers },
          { kind: "route_decision", values: routes },
          { kind: "proposal", values: proposals },
          { kind: "targeted_validation", values: (await all("targeted_validation")).filter(relatedToProposal) },
          { kind: "apply_receipt", values: (await all("apply_receipt")).filter(relatedToProposal) },
          { kind: "refiner_outcome", values: outcomes },
        ];
        return modelResult(context.callId, "refine_status", {
          runId: context.session.id,
          artifacts,
        });
      },
    },
  ];
}

function artifactRefKey(artifact: Record<string, unknown>): string {
  return `${String(artifact.id ?? "")}:${String(artifact.contentHash ?? "")}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function modelResult(callId: string, name: string, data: unknown) {
  return { toolCallId: callId, name, ok: true, contentText: JSON.stringify(data), data };
}

function boundedText(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("A non-empty refinement summary is required.");
  }
  return value.trim().slice(0, maxLength);
}

function boundedJson(value: unknown, maxLength: number): unknown {
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxLength) return value;
  return { truncated: true, json: serialized.slice(0, maxLength) };
}

function containedSourcePath(sourceRoot: string, relativePath: string): string {
  const root = path.resolve(sourceRoot);
  const absolute = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Harness source path escapes its release: ${relativePath}`);
  }
  return absolute;
}
