const countPath = "volumes/app-state/ingest-count.txt";

Bun.serve({
  host: "0.0.0.0",
  port: 3000,
  async fetch() {
    let ingestCount = "0";
    try {
      ingestCount = (await Bun.file(countPath).text()).trim() || "0";
    } catch {
      ingestCount = "0";
    }
    return Response.json({
      ok: true,
      example: "service-with-actions",
      service: "web",
      ingestCount: Number(ingestCount),
    });
  },
});

console.log("service-with-actions listening on http://0.0.0.0:3000");

