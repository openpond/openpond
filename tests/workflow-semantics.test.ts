import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";

const ci = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

describe("CI workflow contracts", () => {
  test("integration runs both application and Python suites", () => {
    const integration = job("integration", "contract");
    expect(integration).toContain("pnpm run test:integration");
    expect(integration).toContain("pnpm run test:python");
  });

  test("the aggregate Checks job requires every protected lane", () => {
    const checks = job("checks");
    expect(checks).toContain("needs: [quality, unit, integration, contract, release_smoke]");
    for (const result of ["QUALITY", "UNIT", "INTEGRATION", "CONTRACT", "RELEASE_SMOKE"]) {
      expect(checks).toContain(`\${${result}}`);
    }
  });

  test("quality enforces repository, dependency, structure, and workflow gates", () => {
    const quality = job("quality", "unit");
    for (const command of [
      "structure:check",
      "reachability:check",
      "dependencies:check",
      "hygiene:check",
      "workflows:check",
    ]) {
      expect(quality).toContain(`pnpm run ${command}`);
    }
  });
});

function job(name: string, next?: string): string {
  const start = ci.indexOf(`  ${name}:`);
  if (start === -1) throw new Error(`missing CI job ${name}`);
  const end = next ? ci.indexOf(`  ${next}:`, start + 1) : ci.length;
  if (end === -1) throw new Error(`missing CI job after ${name}: ${next}`);
  return ci.slice(start, end);
}
