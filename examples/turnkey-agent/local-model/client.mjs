// Only the caller token is required; inference never uses an upstream API key.
const [endpoint, prompt = "What is 7 plus 5? Answer briefly."] = process.argv.slice(2);
try {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) throw new Error();
  if (url.username || url.password || url.search || url.hash || !process.env.TVC_AUTH_TOKEN) throw new Error();
  const response = await fetch(new URL("/chat", url), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(310_000),
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.TVC_AUTH_TOKEN}` },
    body: JSON.stringify({ prompt }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const result = await response.json();
  if (typeof result.answer !== "string" || !result.answer || result.tools?.length !== 0) throw new Error();
  console.log(JSON.stringify(result, null, 2));
} catch {
  console.error("Embedded chat failed. Check endpoint, caller token and the 1024-byte prompt limit; no retry was attempted.");
  process.exitCode = 1;
}
