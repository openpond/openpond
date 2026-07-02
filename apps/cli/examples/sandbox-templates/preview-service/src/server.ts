Bun.serve({
  host: "0.0.0.0",
  port: 3000,
  fetch() {
    return Response.json({
      ok: true,
      example: "preview-service",
      service: "web",
    });
  },
});

console.log("preview-service listening on http://0.0.0.0:3000");

