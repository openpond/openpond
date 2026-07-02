import path from "node:path";
import {
  optionString,
  parseBooleanOption,
  requiredTeamId,
  resolveSandboxClient,
} from "./common";
import { buildProjectUpsertInput, buildProjectUpdateInput } from "./project-agent-inputs";
import { formatProjectLine } from "./project-agent-formatters";
import {
  collectAgentSdkProjectSourceUploadEntries,
  collectProjectSourceUploadEntries,
  mergeProjectSourceUploadEntries,
  resolveProjectSourceUploadBranch,
} from "./project-source-upload";

export async function runProjectCommand(
  options: Record<string, string | boolean>,
  rest: string[]
): Promise<void> {
  const subcommand = rest[0] || "list";
  const client = await resolveSandboxClient(options);

  if (subcommand === "list") {
    const teamId = requiredTeamId(options, "usage: project list");
    const projects = await client.projects.list({ teamId });
    if (parseBooleanOption(options.json)) {
      console.log(JSON.stringify({ projects }, null, 2));
      return;
    }
    if (projects.length === 0) {
      console.log("no sandbox projects found");
      return;
    }
    for (const project of projects) {
      console.log(formatProjectLine(project));
    }
    return;
  }

  if (subcommand === "create" || subcommand === "upsert") {
    const project = await client.projects.upsert(
      buildProjectUpsertInput(options)
    );
    console.log(JSON.stringify({ project }, null, 2));
    return;
  }

  if (subcommand === "get") {
    const projectId = rest[1]?.trim();
    const teamId = requiredTeamId(options, "usage: project get <projectId>");
    if (!projectId) {
      throw new Error("usage: project get <projectId> --team-id <id>");
    }
    const project = await client.projects.get(projectId, { teamId });
    console.log(JSON.stringify({ project }, null, 2));
    return;
  }

  if (subcommand === "update") {
    const projectId = rest[1]?.trim();
    const teamId = requiredTeamId(options, "usage: project update <projectId>");
    if (!projectId) {
      throw new Error("usage: project update <projectId> --team-id <id>");
    }
    const project = await client.projects.update(
      projectId,
      buildProjectUpdateInput(teamId, options)
    );
    console.log(JSON.stringify({ project }, null, 2));
    return;
  }

  if (subcommand === "sync") {
    const projectId = rest[1]?.trim();
    const teamId = requiredTeamId(options, "usage: project sync <projectId>");
    if (!projectId) {
      throw new Error("usage: project sync <projectId> --team-id <id>");
    }
    const project = await client.projects.sync(projectId, { teamId });
    console.log(JSON.stringify({ project }, null, 2));
    return;
  }

  if (subcommand === "source-upload" || subcommand === "upload-source") {
    const projectId = rest[1]?.trim();
    const teamId = requiredTeamId(
      options,
      "usage: project source-upload <projectId>"
    );
    if (!projectId) {
      throw new Error(
        "usage: project source-upload <projectId> --team-id <id> [--path <dir>]"
      );
    }
    const projectPath = path.resolve(optionString(options, "path") || ".");
    const branch = await resolveProjectSourceUploadBranch(projectPath, options);
    const commitMessage =
      optionString(options, "commitMessage") ||
      optionString(options, "commit-message") ||
      "Upload OpenPond project source";
    const collected = await collectProjectSourceUploadEntries(projectPath);
    const agentSdk = await collectAgentSdkProjectSourceUploadEntries(
      projectPath,
      collected.entries
    );
    const upload = mergeProjectSourceUploadEntries(collected, agentSdk.entries);
    const project = await client.projects.uploadSource(projectId, {
      teamId,
      entries: upload.entries,
      ...(branch ? { branch } : {}),
      commitMessage,
    });
    console.log(
      JSON.stringify(
        {
          project,
          uploaded: {
            path: projectPath,
            branch,
            fileCount: upload.fileCount,
            totalBytes: upload.totalBytes,
            limits: upload.limits,
            transport: upload.transport,
            ...(agentSdk.generatedManifestPath
              ? {
                  agentSdk: {
                    generatedManifestPath: agentSdk.generatedManifestPath,
                    generatedEntryCount: agentSdk.entries.length,
                    synthesizedOpenPondYaml: agentSdk.synthesizedOpenPondYaml,
                    uploadMetadataPath: agentSdk.uploadMetadataPath,
                    uploadMetadataHash: agentSdk.uploadMetadataHash,
                    commands: agentSdk.uploadMetadata?.commands,
                    dependencySetup: agentSdk.uploadMetadata?.dependencySetup,
                    packageManager: agentSdk.uploadMetadata?.packageManager,
                    sourceTreeMode: agentSdk.uploadMetadata?.sourceTreeMode,
                    artifactHashes: agentSdk.uploadMetadata?.artifactHashes,
                  },
                }
              : {}),
          },
        },
        null,
        2
      )
    );
    return;
  }

  if (subcommand === "archive") {
    const projectId = rest[1]?.trim();
    const teamId = requiredTeamId(
      options,
      "usage: project archive <projectId>"
    );
    if (!projectId) {
      throw new Error("usage: project archive <projectId> --team-id <id>");
    }
    const project = await client.projects.archive(projectId, { teamId });
    console.log(JSON.stringify({ project }, null, 2));
    return;
  }

  throw new Error(
    "usage: project <list|create|upsert|get|update|sync|source-upload|archive> [--team-id <id>] [--name <name>]"
  );
}
