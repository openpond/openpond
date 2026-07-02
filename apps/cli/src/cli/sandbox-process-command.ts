import type { OpenPondSandboxClient } from "../sandbox/client";
import { parseIntegerOption } from "./common";
import { summarizeSandbox } from "./sandbox-helpers";

export async function handleSandboxProcessCommand(
  client: OpenPondSandboxClient,
  subcommand: string,
  options: Record<string, string | boolean>,
  rest: string[]
): Promise<boolean> {
  if (subcommand === "process-start") {
    const sandboxId = rest[1];
    const command =
      (typeof options.command === "string" ? options.command : null) ||
      rest.slice(2).join(" ");
    if (!sandboxId || !command.trim()) {
      throw new Error(
        "usage: sandbox process-start <sandboxId> --command <command>"
      );
    }
    const timeoutSeconds = parseIntegerOption(
      options.timeoutSeconds,
      "timeout-seconds"
    );
    const result = await client.startProcess(sandboxId, {
      command: command.trim(),
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    });
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          process: result.process,
        },
        null,
        2
      )
    );
    return true;
  }

  if (subcommand === "process-list") {
    const sandboxId = rest[1];
    if (!sandboxId) {
      throw new Error("usage: sandbox process-list <sandboxId>");
    }
    const result = await client.listProcesses(sandboxId);
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          processes: result.processes,
        },
        null,
        2
      )
    );
    return true;
  }

  if (subcommand === "process-get") {
    const sandboxId = rest[1];
    const processId = rest[2];
    if (!sandboxId || !processId) {
      throw new Error(
        "usage: sandbox process-get <sandboxId> <processId> [--since <cursor>]"
      );
    }
    const since = parseIntegerOption(options.since, "since");
    const result = await client.getProcess(sandboxId, processId, {
      ...(since !== undefined ? { since } : {}),
    });
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          process: result.process,
          output: result.output,
          cursor: result.cursor,
          completed: result.completed,
        },
        null,
        2
      )
    );
    return true;
  }

  if (subcommand === "process-stop") {
    const sandboxId = rest[1];
    const processId = rest[2];
    if (!sandboxId || !processId) {
      throw new Error("usage: sandbox process-stop <sandboxId> <processId>");
    }
    const result = await client.stopProcess(sandboxId, processId);
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          process: result.process,
        },
        null,
        2
      )
    );
    return true;
  }

  if (subcommand === "process-stream") {
    const sandboxId = rest[1];
    const processId = rest[2];
    if (!sandboxId || !processId) {
      throw new Error(
        "usage: sandbox process-stream <sandboxId> <processId> [--since <cursor>]"
      );
    }
    const since = parseIntegerOption(options.since, "since");
    await client.streamProcessOutput(sandboxId, processId, {
      ...(since !== undefined ? { since } : {}),
    });
    return true;
  }

  if (subcommand === "pty-start") {
    const sandboxId = rest[1];
    if (!sandboxId) {
      throw new Error(
        "usage: sandbox pty-start <sandboxId> [--command <command>]"
      );
    }
    const command =
      (typeof options.command === "string" ? options.command : null) ||
      rest.slice(2).join(" ");
    const timeoutSeconds = parseIntegerOption(
      options.timeoutSeconds,
      "timeout-seconds"
    );
    const rows = parseIntegerOption(options.rows, "rows");
    const cols = parseIntegerOption(options.cols, "cols");
    const result = await client.startPty(sandboxId, {
      ...(command.trim() ? { command: command.trim() } : {}),
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
      ...(rows !== undefined ? { rows } : {}),
      ...(cols !== undefined ? { cols } : {}),
    });
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          pty: result.pty,
        },
        null,
        2
      )
    );
    return true;
  }

  if (subcommand === "pty-list") {
    const sandboxId = rest[1];
    if (!sandboxId) {
      throw new Error("usage: sandbox pty-list <sandboxId>");
    }
    const result = await client.listPtys(sandboxId);
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          ptys: result.ptys,
        },
        null,
        2
      )
    );
    return true;
  }

  if (subcommand === "pty-get") {
    const sandboxId = rest[1];
    const ptyId = rest[2];
    if (!sandboxId || !ptyId) {
      throw new Error(
        "usage: sandbox pty-get <sandboxId> <ptyId> [--since <cursor>]"
      );
    }
    const since = parseIntegerOption(options.since, "since");
    const result = await client.getPty(sandboxId, ptyId, {
      ...(since !== undefined ? { since } : {}),
    });
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          pty: result.pty,
          output: result.output,
          cursor: result.cursor,
          completed: result.completed,
        },
        null,
        2
      )
    );
    return true;
  }

  if (subcommand === "pty-write") {
    const sandboxId = rest[1];
    const ptyId = rest[2];
    const inputBase64 =
      typeof options.inputBase64 === "string" ? options.inputBase64.trim() : "";
    const inputText =
      (typeof options.input === "string" ? options.input : null) ||
      rest.slice(3).join(" ");
    if (!sandboxId || !ptyId || (!inputBase64 && !inputText)) {
      throw new Error(
        "usage: sandbox pty-write <sandboxId> <ptyId> --input <text>"
      );
    }
    const result = await client.writePtyInput(
      sandboxId,
      ptyId,
      inputBase64 ? { dataBase64: inputBase64 } : inputText
    );
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          pty: result.pty,
        },
        null,
        2
      )
    );
    return true;
  }

  if (subcommand === "pty-stop") {
    const sandboxId = rest[1];
    const ptyId = rest[2];
    if (!sandboxId || !ptyId) {
      throw new Error("usage: sandbox pty-stop <sandboxId> <ptyId>");
    }
    const result = await client.stopPty(sandboxId, ptyId);
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          pty: result.pty,
        },
        null,
        2
      )
    );
    return true;
  }

  if (subcommand === "pty-stream") {
    const sandboxId = rest[1];
    const ptyId = rest[2];
    if (!sandboxId || !ptyId) {
      throw new Error(
        "usage: sandbox pty-stream <sandboxId> <ptyId> [--since <cursor>]"
      );
    }
    const since = parseIntegerOption(options.since, "since");
    await client.streamPtyOutput(sandboxId, ptyId, {
      ...(since !== undefined ? { since } : {}),
    });
    return true;
  }

  return false;
}
