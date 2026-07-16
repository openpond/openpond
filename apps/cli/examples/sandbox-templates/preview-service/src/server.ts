import { createServer } from "node:http";

createServer((_request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({
    ok: true,
    example: "preview-service",
    service: "web",
  }));
}).listen(3000, "0.0.0.0");

console.log("preview-service listening on http://0.0.0.0:3000");
