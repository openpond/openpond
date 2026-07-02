import type { CodexServerRequest, CodexServerRequestResult } from "./types.js";

export function defaultServerRequestResult(request: CodexServerRequest): CodexServerRequestResult {
  if (request.method === "item/commandExecution/requestApproval") {
    return { result: { decision: "decline" } };
  }
  if (request.method === "item/fileChange/requestApproval") {
    return { result: { decision: "decline" } };
  }
  if (request.method === "execCommandApproval") {
    return { result: { decision: "denied" } };
  }
  if (request.method === "applyPatchApproval") {
    return { result: { decision: "denied" } };
  }
  if (request.method === "item/tool/requestUserInput") {
    return { result: { answers: {} } };
  }
  if (request.method === "mcpServer/elicitation/request") {
    return { result: { action: "cancel", content: null, _meta: null } };
  }
  if (request.method === "item/tool/call") {
    return {
      result: {
        contentItems: [{ type: "inputText", text: "OpenPond App did not expose this app-server tool." }],
        success: false,
      },
    };
  }
  return {
    error: {
      code: -32601,
      message: `OpenPond App does not handle Codex app-server request ${request.method}`,
    },
  };
}
