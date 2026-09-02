import fixtureManifest from "../../../../examples/tau3-retail-continual-v1/continual-bench.json";

export const dynamic = "force-static";

export function GET() {
  return Response.json(fixtureManifest, {
    headers: {
      "Content-Disposition": "inline; filename=continual-bench.json",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
