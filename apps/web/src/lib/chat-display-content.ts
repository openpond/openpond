const RUNTIME_CONTEXT_OPEN = "<openpond_trusted_runtime_context>";
const RUNTIME_CONTEXT_CLOSE = "</openpond_trusted_runtime_context>";

/** Keep the runtime's prompt envelope out of the user-facing transcript. */
export function userMessageDisplayContent(content: string): string {
  const prompt = content.trimStart();
  if (!prompt.startsWith(RUNTIME_CONTEXT_OPEN)) return content;

  const contextEnd = prompt.indexOf(RUNTIME_CONTEXT_CLOSE, RUNTIME_CONTEXT_OPEN.length);
  if (contextEnd === -1) return "";

  const request = prompt.slice(contextEnd + RUNTIME_CONTEXT_CLOSE.length).trim();
  if (!request.startsWith("<user_request>")) return request;

  const body = request.slice("<user_request>".length);
  return (body.endsWith("</user_request>")
    ? body.slice(0, -"</user_request>".length)
    : body).trim();
}
