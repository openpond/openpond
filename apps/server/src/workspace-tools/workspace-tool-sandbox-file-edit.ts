import { Buffer } from "node:buffer";
import { sandboxRequestPayload } from "../openpond/sandboxes.js";
import {
  asRecord,
  booleanArg,
  numberArg,
  requiredStringArg,
} from "./workspace-tool-arguments.js";

export async function editSandboxFile(input: {
  sandboxId: string;
  args: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const filePath = requiredStringArg(input.args, "path");
  const oldText = requiredStringArg(input.args, "oldText");
  const newText = typeof input.args.newText === "string" ? input.args.newText : "";
  const replaceAll = booleanArg(input.args, "replaceAll") === true;
  const maxBytes = numberArg(input.args, "maxBytes") ?? 2 * 1024 * 1024;
  const currentPayload = asRecord(
    await sandboxRequestPayload({
      type: "download_file",
      sandboxId: input.sandboxId,
      payload: { path: filePath, maxBytes },
    }),
  );
  const currentText = sandboxTextFileContents(asRecord(currentPayload.file), filePath);
  const replacements = currentText.split(oldText).length - 1;
  if (replacements === 0) throw new Error(`Text not found in ${filePath}`);
  if (replacements > 1 && !replaceAll) {
    throw new Error(
      `Text matched ${replacements} times in ${filePath}; provide a longer oldText that matches only the intended location, or set replaceAll true.`,
    );
  }
  const nextText = currentText.split(oldText).join(newText);
  const uploadPayload = asRecord(
    await sandboxRequestPayload({
      type: "upload_file",
      sandboxId: input.sandboxId,
      payload: { path: filePath, contents: nextText },
    }),
  );
  const verifyPayload = asRecord(
    await sandboxRequestPayload({
      type: "download_file",
      sandboxId: input.sandboxId,
      payload: { path: filePath, maxBytes: Math.max(1, Buffer.byteLength(nextText, "utf8")) },
    }),
  );
  const verifiedText = sandboxTextFileContents(asRecord(verifyPayload.file), filePath);
  if (verifiedText !== nextText) throw new Error(`Failed to verify sandbox edit for ${filePath}`);
  return {
    ...uploadPayload,
    edit: {
      path: filePath,
      replacements,
      verified: true,
      sizeBytes: Buffer.byteLength(nextText, "utf8"),
    },
  };
}

function sandboxTextFileContents(file: Record<string, unknown>, filePath: string): string {
  if (file.isBinary === true) throw new Error(`Cannot text-edit binary sandbox file ${filePath}`);
  if (file.truncated === true) throw new Error(`Cannot text-edit truncated sandbox file ${filePath}`);
  if (typeof file.contentsBase64 !== "string") {
    throw new Error(`Sandbox file ${filePath} did not return text contents`);
  }
  return Buffer.from(file.contentsBase64, "base64").toString("utf8");
}
