import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const countPath = "volumes/app-state/ingest-count.txt";

createServer(async (_request, response) => {
    let ingestCount = "0";
    try {
      ingestCount = (await readFile(countPath, "utf8")).trim() || "0";
    } catch {
      ingestCount = "0";
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      ok: true,
      example: "service-with-actions",
      service: "web",
      ingestCount: Number(ingestCount),
    }));
}).listen(3000, "0.0.0.0");

console.log("service-with-actions listening on http://0.0.0.0:3000");
