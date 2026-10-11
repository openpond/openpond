import type { OpenPondSandboxClient } from "../sandbox/client";
import { readFile, stat } from "node:fs/promises";
import { parseBooleanOption, parseIntegerOption, parseNumberOption } from "./common";
import { summarizeSandbox } from "./sandbox-helpers";

export async function handleSandboxFilesCommand(
  client: OpenPondSandboxClient,
  subcommand: string,
  options: Record<string, string | boolean>,
  rest: string[]
): Promise<boolean> {
  if (subcommand === "list-files") {
    const sandboxId = rest[1];
    if (!sandboxId) {
      throw new Error("usage: sandbox list-files <sandboxId> [--path <path>]");
    }
    const path =
      typeof options.path === "string" ? options.path.trim() : undefined;
    const maxEntries = parseNumberOption(options.maxEntries, "max-entries");
    const recursive =
      options.recursive !== undefined
        ? parseBooleanOption(options.recursive)
        : undefined;
    const result = await client.listFiles(sandboxId, {
      ...(path ? { path } : {}),
      ...(recursive !== undefined ? { recursive } : {}),
      ...(maxEntries !== undefined ? { maxEntries } : {}),
    });
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          files: result.files,
        },
        null,
        2
      )
    );
    return true;
  }

  if (subcommand === "upload-file") {
    const sandboxId = rest[1];
    const path = typeof options.path === "string" ? options.path.trim() : "";
    const contents =
      typeof options.contents === "string"
        ? options.contents
        : typeof options.content === "string"
        ? options.content
        : "";
    let contentsBase64 =
      typeof options.contentsBase64 === "string"
        ? options.contentsBase64.trim()
        : typeof options.contentBase64 === "string"
        ? options.contentBase64.trim()
        : "";
    const fromPath = typeof options.fromPath === "string" ? options.fromPath.trim() : "";
    if (!sandboxId || !path) {
      throw new Error(
        'usage: sandbox upload-file <sandboxId> --path <path> --contents "text"'
      );
    }
    if (fromPath) {
      if (contents || contentsBase64) throw new Error("Choose --from-path or inline contents for the upload.");
      const info = await stat(fromPath);
      if (!info.isFile() || info.size > 10 * 1024 * 1024) throw new Error("Sandbox upload requires a file within 10 MiB.");
      const bytes = await readFile(fromPath);
      if (bytes.byteLength > 10 * 1024 * 1024) throw new Error("Sandbox upload file changed beyond 10 MiB.");
      contentsBase64 = bytes.toString("base64");
    }
    if (!contents && !contentsBase64) {
      throw new Error(
        'usage: sandbox upload-file <sandboxId> --path <path> --contents "text"'
      );
    }
    const result = contentsBase64
      ? await client.uploadFileBase64(sandboxId, path, contentsBase64)
      : await client.uploadFile(sandboxId, path, contents);
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          file: result.file,
        },
        null,
        2
      )
    );
    return true;
  }

  if (subcommand === "download-file") {
    const sandboxId = rest[1];
    const path = typeof options.path === "string" ? options.path.trim() : "";
    const offsetBytes = parseIntegerOption(options.offsetBytes, "offset-bytes");
    const maxBytes = parseIntegerOption(options.maxBytes, "max-bytes");
    if (!sandboxId || !path) {
      throw new Error("usage: sandbox download-file <sandboxId> --path <path>");
    }
    const result = await client.downloadFileResponse(sandboxId, {
      path,
      ...(offsetBytes !== undefined ? { offsetBytes } : {}),
      ...(maxBytes !== undefined ? { maxBytes } : {}),
    });
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          file: result.file,
          contents: Buffer.from(result.file.contentsBase64, "base64").toString(
            "utf-8"
          ),
        },
        null,
        2
      )
    );
    return true;
  }

  if (subcommand === "search-files") {
    const sandboxId = rest[1];
    const query = typeof options.query === "string" ? options.query.trim() : "";
    if (!sandboxId || !query) {
      throw new Error(
        "usage: sandbox search-files <sandboxId> --query <text> [--path <path>]"
      );
    }
    const path =
      typeof options.path === "string" ? options.path.trim() : undefined;
    const maxResults = parseNumberOption(options.maxResults, "max-results");
    const result = await client.searchFiles(sandboxId, {
      query,
      ...(path ? { path } : {}),
      ...(maxResults !== undefined ? { maxResults } : {}),
    });
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          matches: result.matches,
        },
        null,
        2
      )
    );
    return true;
  }

  if (subcommand === "delete-file") {
    const sandboxId = rest[1];
    const path = typeof options.path === "string" ? options.path.trim() : "";
    if (!sandboxId || !path) {
      throw new Error(
        "usage: sandbox delete-file <sandboxId> --path <path> [--recursive]"
      );
    }
    const result = await client.deleteFile(sandboxId, path, {
      recursive: parseBooleanOption(options.recursive),
    });
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          deleted: result.deleted,
        },
        null,
        2
      )
    );
    return true;
  }

  if (subcommand === "stat-file") {
    const sandboxId = rest[1];
    const path = typeof options.path === "string" ? options.path.trim() : "";
    if (!sandboxId || !path) {
      throw new Error("usage: sandbox stat-file <sandboxId> --path <path>");
    }
    const result = await client.statFile(sandboxId, path);
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          file: result.file,
        },
        null,
        2
      )
    );
    return true;
  }

  if (subcommand === "mkdir") {
    const sandboxId = rest[1];
    const path = typeof options.path === "string" ? options.path.trim() : "";
    if (!sandboxId || !path) {
      throw new Error(
        "usage: sandbox mkdir <sandboxId> --path <path> [--recursive false]"
      );
    }
    const result = await client.mkdir(sandboxId, {
      path,
      recursive:
        options.recursive !== undefined
          ? parseBooleanOption(options.recursive)
          : undefined,
    });
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          directory: result.directory,
        },
        null,
        2
      )
    );
    return true;
  }

  if (subcommand === "move-file") {
    const sandboxId = rest[1];
    const fromPath =
      typeof options.fromPath === "string" ? options.fromPath.trim() : "";
    const toPath =
      typeof options.toPath === "string" ? options.toPath.trim() : "";
    if (!sandboxId || !fromPath || !toPath) {
      throw new Error(
        "usage: sandbox move-file <sandboxId> --from-path <path> --to-path <path> [--overwrite]"
      );
    }
    const result = await client.moveFile(sandboxId, {
      fromPath,
      toPath,
      overwrite: parseBooleanOption(options.overwrite),
    });
    console.log(
      JSON.stringify(
        {
          sandbox: summarizeSandbox(result.sandbox),
          moved: result.moved,
          file: result.file,
        },
        null,
        2
      )
    );
    return true;
  }

  return false;
}
