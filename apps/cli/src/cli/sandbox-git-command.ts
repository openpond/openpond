import type { OpenPondSandboxClient } from "../sandbox/client";
import { parseBooleanOption } from "./common";
import { summarizeSandbox } from "./sandbox-helpers";

export async function handleSandboxGitCommand(
  client: OpenPondSandboxClient,
  subcommand: string,
  options: Record<string, string | boolean>,
  rest: string[]
): Promise<boolean> {
  if (subcommand === "git-status") {
    const sandboxId = rest[1];
    if (!sandboxId) {
      throw new Error("usage: sandbox git-status <sandboxId>");
    }
    const result = await client.gitStatus(sandboxId);
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          status: result.status,
        },
        null,
        2
      )
    );
    return true;
  }

  if (subcommand === "git-diff") {
    const sandboxId = rest[1];
    if (!sandboxId) {
      throw new Error("usage: sandbox git-diff <sandboxId> [--base-ref <ref>]");
    }
    const baseRef =
      typeof options.baseRef === "string" && options.baseRef.trim()
        ? options.baseRef.trim()
        : undefined;
    const result = await client.gitDiff(sandboxId, {
      ...(baseRef ? { baseRef } : {}),
    });
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          diff: result.diff,
        },
        null,
        2
      )
    );
    return true;
  }

  if (subcommand === "git-export-patch") {
    const sandboxId = rest[1];
    if (!sandboxId) {
      throw new Error(
        "usage: sandbox git-export-patch <sandboxId> [--base-ref <ref>]"
      );
    }
    const baseRef =
      typeof options.baseRef === "string" && options.baseRef.trim()
        ? options.baseRef.trim()
        : undefined;
    const result = await client.gitExportPatch(sandboxId, {
      ...(baseRef ? { baseRef } : {}),
    });
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          patch: result.patch,
        },
        null,
        2
      )
    );
    return true;
  }

  if (subcommand === "git-branch") {
    const sandboxId = rest[1];
    const branch =
      typeof options.branch === "string" ? options.branch.trim() : "";
    const startPoint =
      typeof options.startPoint === "string" && options.startPoint.trim()
        ? options.startPoint.trim()
        : undefined;
    if (!sandboxId || !branch) {
      throw new Error(
        "usage: sandbox git-branch <sandboxId> --branch <name> [--create] [--start-point <ref>]"
      );
    }
    const result = await client.gitBranch(sandboxId, {
      branch,
      create: parseBooleanOption(options.create),
      ...(startPoint ? { startPoint } : {}),
    });
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          branch: result.branch,
        },
        null,
        2
      )
    );
    return true;
  }

  if (subcommand === "git-commit") {
    const sandboxId = rest[1];
    const message =
      typeof options.message === "string" ? options.message.trim() : "";
    const all = parseBooleanOption(options.all);
    const rawPaths =
      typeof options.paths === "string"
        ? options.paths
        : typeof options.path === "string"
        ? options.path
        : "";
    const paths = rawPaths
      .split(",")
      .map((path) => path.trim())
      .filter(Boolean);
    if (!sandboxId || !message || (!all && paths.length === 0)) {
      throw new Error(
        'usage: sandbox git-commit <sandboxId> --message "..." [--all|--paths <csv>]'
      );
    }
    const result = await client.gitCommit(sandboxId, {
      message,
      ...(all ? { all: true } : { paths }),
    });
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          commit: result.commit,
        },
        null,
        2
      )
    );
    return true;
  }

  if (subcommand === "git-pull") {
    const sandboxId = rest[1];
    if (!sandboxId) {
      throw new Error(
        "usage: sandbox git-pull <sandboxId> [--remote origin] [--branch main] [--rebase|--ff-only false]"
      );
    }
    const remote =
      typeof options.remote === "string" && options.remote.trim()
        ? options.remote.trim()
        : undefined;
    const branch =
      typeof options.branch === "string" && options.branch.trim()
        ? options.branch.trim()
        : undefined;
    const result = await client.gitPull(sandboxId, {
      ...(remote ? { remote } : {}),
      ...(branch ? { branch } : {}),
      ...(options.rebase !== undefined
        ? { rebase: parseBooleanOption(options.rebase) }
        : {}),
      ...(options.ffOnly !== undefined
        ? { ffOnly: parseBooleanOption(options.ffOnly) }
        : {}),
    });
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          pull: result.pull,
        },
        null,
        2
      )
    );
    return true;
  }

  if (subcommand === "git-push") {
    const sandboxId = rest[1];
    if (!sandboxId) {
      throw new Error(
        "usage: sandbox git-push <sandboxId> [--remote origin] [--branch main] [--set-upstream] [--force-with-lease]"
      );
    }
    const remote =
      typeof options.remote === "string" && options.remote.trim()
        ? options.remote.trim()
        : undefined;
    const branch =
      typeof options.branch === "string" && options.branch.trim()
        ? options.branch.trim()
        : undefined;
    const result = await client.gitPush(sandboxId, {
      ...(remote ? { remote } : {}),
      ...(branch ? { branch } : {}),
      ...(options.setUpstream !== undefined
        ? { setUpstream: parseBooleanOption(options.setUpstream) }
        : {}),
      ...(options.forceWithLease !== undefined
        ? { forceWithLease: parseBooleanOption(options.forceWithLease) }
        : {}),
    });
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          push: result.push,
        },
        null,
        2
      )
    );
    return true;
  }

  return false;
}
