// Credentials stay in the environment/request body, never argv or console output.
import { createHash } from "node:crypto";
const [endpoint, text = "OpenPond TVC synthetic example"] = process.argv.slice(2);
try {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) throw new Error();
  if (url.username || url.password || url.search || url.hash) throw new Error();
  const required = name => { const value = process.env[name]; if (!value) throw new Error(); return value; };
  const response = await fetch(new URL("/chat", url), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(310_000),
    headers: { "content-type": "application/json", authorization: `Bearer ${required("TVC_AUTH_TOKEN")}` },
    body: JSON.stringify({ prompt: `Use sandbox_sha256 to compute SHA-256 of the exact UTF-8 text ${JSON.stringify(text)}. Report the tool's hash.`,
      credentials: { modelApiKey: required("OPENAI_API_KEY"), sandboxApiKey: required("OPENPOND_API_KEY") } }),
  });
  if (!response.ok) { console.error(`Example request failed (HTTP ${response.status}); it was not retried.`); process.exitCode = 1; }
  else {
    const result = await response.json();
    const expected = createHash("sha256").update(text).digest("hex");
    const proof = result.tools?.find(tool => tool.sha256 === expected);
    if (!proof?.commandId || !result.answer?.includes(expected)) throw new Error();
    console.log(JSON.stringify({ status: "passed", requestId: result.requestId, threadId: result.threadId,
      turnId: result.turnId, sandboxId: proof.sandboxId, commandId: proof.commandId, sha256: expected }, null, 2));
  }
} catch { console.error("Example request or evidence validation failed. Check endpoint and required credentials; no retry was attempted."); process.exitCode = 1; }
