/** Optional chat projection after a successful hosted operation. Ordinary hosted
 * CLI usage neither starts nor depends on a desktop server. */
export async function attachHostedTrainingToChat(
  input: {jobId:string;teamId:string;apiOrigin:string},
  dependencies: {request?:typeof fetch;warn?:(message:string)=>void} = {},
): Promise<void> {
  const invocationToken = process.env.OPENPOND_CHAT_INVOCATION;
  if (!invocationToken) return;
  try {
    const baseUrl = process.env.OPENPOND_LOCAL_API_URL;
    if (!baseUrl) throw new Error("The chat executor did not supply its local API URL.");
    const local = new URL(baseUrl);
    if (local.protocol !== "http:" || !["127.0.0.1","localhost","[::1]"].includes(local.hostname) || local.username || local.password) {
      throw new Error("Chat attachment requires the app's loopback API origin.");
    }
    const request = dependencies.request ?? await (await import("./training")).createLocalAuthenticatedRequest(baseUrl,{timeoutMs:15_000});
    const response = await request(new URL("/v1/chat-experiments",local),{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({action:"attach_training",invocationToken,payload:{location:"cloud",...input}}),
      signal:AbortSignal.timeout(15_000),redirect:"error"});
    if (!response.ok) throw new Error(`Chat attachment returned HTTP ${response.status}.`);
  } catch (error) {
    (dependencies.warn ?? console.error)(`Hosted operation succeeded, but chat attachment failed: ${error instanceof Error ? error.message : String(error)}. Inspect the saved job to retry attachment; do not submit it again.`);
  }
}
