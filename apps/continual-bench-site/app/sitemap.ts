import type { MetadataRoute } from "next";

export const dynamic = "force-static";

const routes = ["", "/convert-a-test-set/", "/run-continual-evaluation/", "/read-the-scorecard/"];

export default function sitemap(): MetadataRoute.Sitemap {
  return routes.map((route) => ({ url: `https://continual.openpond.ai${route}`, changeFrequency: "monthly", priority: route ? 0.8 : 1 }));
}
