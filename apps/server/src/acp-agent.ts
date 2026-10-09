import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { OpenPondAcpAgent, type AcpAgentOptions } from "./acp-agent/adapter.js";

export { OpenPondAcpAgent, type AcpAgentOptions } from "./acp-agent/adapter.js";
export { AcpAccount } from "./acp-agent/identity.js";

export async function runOpenPondAcpAgent(options: AcpAgentOptions): Promise<void> {
  const agent = new OpenPondAcpAgent(options);
  const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
  const connection = agent.connect(stream);
  const stop = () => connection.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try { await connection.closed; }
  finally {
    await agent.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
