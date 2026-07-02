import { WorkspaceToolResultSchema, type WorkspaceToolResult } from "@openpond/contracts";
import {
  deleteWorkspaceFile,
  editWorkspaceFile,
  listWorkspaceFiles,
  previewWorkspaceDeleteFile,
  previewWorkspaceEditFile,
  previewWorkspaceWriteFile,
  previewWorkspaceWriteFiles,
  readWorkspaceFiles,
  searchWorkspaceFiles,
  writeWorkspaceFile,
} from "./workspace-tools.js";
import {
  readLocalWorkspaceResource,
  searchLocalWorkspaceResources,
  type ResourceReadRequest,
  type ResourceSearchRequest,
} from "../openpond/resources.js";
import { stringArg, stringArrayArg, stringRecordArg, stringValueArg } from "./workspace-tool-arg-utils.js";
import type { ActiveWorkspaceActionContext } from "./workspace-tool-active-types.js";

export async function handleActiveWorkspaceFileAction(
  context: ActiveWorkspaceActionContext
): Promise<WorkspaceToolResult | null> {
  const { app, args, input, runChecks, runPostEditWorkflow, session, state, turnId } = context;

  switch (input.action) {
    case "resource_read": {
      const resource = await readLocalWorkspaceResource({
        repoPath: state.repoPath,
        request: resourceReadRequest(args),
      });
      return WorkspaceToolResultSchema.parse({
        ok: true,
        action: input.action,
        appId: app.id,
        output: `Read resource ${resource.ref}.`,
        data: { resource },
      });
    }

    case "resource_search": {
      const result = await searchLocalWorkspaceResources({
        repoPath: state.repoPath,
        request: resourceSearchRequest(args),
      });
      return WorkspaceToolResultSchema.parse({
        ok: true,
        action: input.action,
        appId: app.id,
        output: `Found ${result.items.length} resource${result.items.length === 1 ? "" : "s"}.`,
        data: { result },
      });
    }

    case "workspace_status":
      return WorkspaceToolResultSchema.parse({
        ok: true,
        action: input.action,
        appId: app.id,
        output: state.initialized ? "Workspace is initialized." : "Workspace is not initialized.",
        data: state,
      });

    case "list_files": {
      const files = await listWorkspaceFiles(state.repoPath);
      return WorkspaceToolResultSchema.parse({
        ok: true,
        action: input.action,
        appId: app.id,
        output: `Found ${files.length} file${files.length === 1 ? "" : "s"}.`,
        data: { files },
      });
    }

    case "read_files": {
      const files = await readWorkspaceFiles(state.repoPath, stringArrayArg(args, "paths"));
      return WorkspaceToolResultSchema.parse({
        ok: true,
        action: input.action,
        appId: app.id,
        output: `Read ${files.length} file${files.length === 1 ? "" : "s"}.`,
        data: { files },
      });
    }

    case "search_files": {
      const matches = await searchWorkspaceFiles(state.repoPath, stringArg(args, "query"));
      return WorkspaceToolResultSchema.parse({
        ok: true,
        action: input.action,
        appId: app.id,
        output: `Found ${matches.length} match${matches.length === 1 ? "" : "es"}.`,
        data: { matches },
      });
    }

    case "preview_write_file": {
      const preview = await previewWorkspaceWriteFile(
        state.repoPath,
        stringArg(args, "path"),
        stringValueArg(args, "content")
      );
      return WorkspaceToolResultSchema.parse({
        ok: true,
        action: input.action,
        appId: app.id,
        output: `Previewed ${preview.filesChanged} file change${preview.filesChanged === 1 ? "" : "s"}.`,
        data: { preview },
      });
    }

    case "preview_write_files": {
      const preview = await previewWorkspaceWriteFiles(state.repoPath, stringRecordArg(args, "files"));
      return WorkspaceToolResultSchema.parse({
        ok: true,
        action: input.action,
        appId: app.id,
        output: `Previewed ${preview.filesChanged} file change${preview.filesChanged === 1 ? "" : "s"}.`,
        data: { preview },
      });
    }

    case "preview_edit_file": {
      const replaceAll = args.replaceAll === true;
      const preview = await previewWorkspaceEditFile(
        state.repoPath,
        stringArg(args, "path"),
        stringArg(args, "oldText"),
        typeof args.newText === "string" ? args.newText : "",
        { replaceAll }
      );
      return WorkspaceToolResultSchema.parse({
        ok: true,
        action: input.action,
        appId: app.id,
        output: `Previewed edit for ${stringArg(args, "path")}.`,
        data: { preview },
      });
    }

    case "preview_delete_file": {
      const preview = await previewWorkspaceDeleteFile(state.repoPath, stringArg(args, "path"));
      return WorkspaceToolResultSchema.parse({
        ok: true,
        action: input.action,
        appId: app.id,
        output: `Previewed delete for ${stringArg(args, "path")}.`,
        data: { preview },
      });
    }

    case "write_file": {
      const filePath = stringArg(args, "path");
      const content = stringValueArg(args, "content");
      const preview = await previewWorkspaceWriteFile(state.repoPath, filePath, content);
      const written = await writeWorkspaceFile(state.repoPath, filePath, content);
      const workflow = await runPostEditWorkflow({ session, app, state, turnId, source: input.source, args, runChecks });
      const ok = workflow.ok;
      return WorkspaceToolResultSchema.parse({
        ok,
        action: input.action,
        appId: app.id,
        output: ok ? `Wrote ${written.path}.` : `Wrote ${written.path}, but post-edit checks or preview failed.`,
        data: { ...written, preview, checks: workflow.checks, managed: workflow.managed },
      });
    }

    case "write_files": {
      const files = stringRecordArg(args, "files");
      const preview = await previewWorkspaceWriteFiles(state.repoPath, files);
      const written: Array<{ path: string }> = [];
      for (const [filePath, content] of Object.entries(files)) {
        written.push(await writeWorkspaceFile(state.repoPath, filePath, content));
      }
      const workflow = await runPostEditWorkflow({ session, app, state, turnId, source: input.source, args, runChecks });
      const ok = workflow.ok;
      return WorkspaceToolResultSchema.parse({
        ok,
        action: input.action,
        appId: app.id,
        output: ok
          ? `Wrote ${written.length} file${written.length === 1 ? "" : "s"}.`
          : `Wrote ${written.length} file${written.length === 1 ? "" : "s"}, but post-edit checks or preview failed.`,
        data: { files: written, preview, checks: workflow.checks, managed: workflow.managed },
      });
    }

    case "edit_file": {
      const filePath = stringArg(args, "path");
      const oldText = stringArg(args, "oldText");
      const newText = typeof args.newText === "string" ? args.newText : "";
      const replaceAll = args.replaceAll === true;
      const preview = await previewWorkspaceEditFile(state.repoPath, filePath, oldText, newText, { replaceAll });
      const edited = await editWorkspaceFile(state.repoPath, filePath, oldText, newText, { replaceAll });
      const workflow = await runPostEditWorkflow({ session, app, state, turnId, source: input.source, args, runChecks });
      const ok = workflow.ok;
      return WorkspaceToolResultSchema.parse({
        ok,
        action: input.action,
        appId: app.id,
        output: ok ? `Edited ${edited.path}.` : `Edited ${edited.path}, but post-edit checks or preview failed.`,
        data: { ...edited, preview, checks: workflow.checks, managed: workflow.managed },
      });
    }

    case "delete_file": {
      const filePath = stringArg(args, "path");
      const preview = await previewWorkspaceDeleteFile(state.repoPath, filePath);
      const deleted = await deleteWorkspaceFile(state.repoPath, filePath);
      const workflow = await runPostEditWorkflow({ session, app, state, turnId, source: input.source, args, runChecks });
      const ok = workflow.ok;
      return WorkspaceToolResultSchema.parse({
        ok,
        action: input.action,
        appId: app.id,
        output: ok ? `Deleted ${deleted.path}.` : `Deleted ${deleted.path}, but post-edit checks or preview failed.`,
        data: { ...deleted, preview, checks: workflow.checks, managed: workflow.managed },
      });
    }

    default:
      return null;
  }
}

function resourceReadRequest(args: Record<string, unknown>): ResourceReadRequest {
  const ref = stringArg(args, "ref");
  const mode = args.mode;
  if (
    mode !== undefined &&
    mode !== "content" &&
    mode !== "summary" &&
    mode !== "metadata"
  ) {
    throw new Error("mode must be content, summary, or metadata");
  }
  return {
    ref,
    ...(typeof args.maxBytes === "number" ? { maxBytes: args.maxBytes } : {}),
    ...(mode ? { mode } : {}),
  };
}

function resourceSearchRequest(args: Record<string, unknown>): ResourceSearchRequest {
  const scope = args.scope;
  if (
    scope !== "workspace" &&
    scope !== "git" &&
    scope !== "events" &&
    scope !== "messages" &&
    scope !== "artifacts" &&
    scope !== "goal-context" &&
    scope !== "sandbox"
  ) {
    throw new Error("scope must be workspace, git, events, messages, artifacts, goal-context, or sandbox");
  }
  return {
    scope,
    query: stringArg(args, "query"),
    ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
    ...(args.filters && typeof args.filters === "object" && !Array.isArray(args.filters)
      ? { filters: args.filters as Record<string, unknown> }
      : {}),
  };
}
