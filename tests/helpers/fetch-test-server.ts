import { createServer, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";

export type FetchTestServer = {
  port: number;
  url: string;
  stop(): void;
};

export async function startFetchTestServer(
  handler: (request: Request) => Response | Promise<Response>,
): Promise<FetchTestServer> {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const request = await toRequest(incoming);
      const response = await handler(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      if (!response.body) {
        outgoing.end();
        return;
      }
      const body = Readable.fromWeb(response.body as never);
      body.once("error", (error) => outgoing.destroy(error));
      incoming.once("close", () => body.destroy());
      body.pipe(outgoing);
    } catch (error) {
      if (outgoing.headersSent) {
        outgoing.destroy(error as Error);
        return;
      }
      outgoing.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      outgoing.end(error instanceof Error ? error.message : String(error));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");

  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    stop() {
      server.closeAllConnections();
      server.close();
    },
  };
}

async function toRequest(incoming: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const method = incoming.method ?? "GET";
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  return new Request(
    new URL(incoming.url ?? "/", `http://${incoming.headers.host ?? "127.0.0.1"}`),
    {
      method,
      headers,
      ...(method === "GET" || method === "HEAD" || !body ? {} : { body }),
    },
  );
}
