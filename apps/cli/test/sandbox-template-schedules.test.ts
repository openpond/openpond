import { describe, expect, test } from "vitest";

import { validateSandboxTemplateYaml } from "../src/sandbox-template/manifest";

const baseManifest = `
schemaVersion: 1
name: scheduled-template
version: 0.1.0
useCase: test
description: Scheduled template.
runtime:
  base: node
validation:
  commands:
    - echo ok
start:
  command: echo start
actions:
  - name: report
    command: echo report
services:
  - name: web
    command: pnpm dev -- --host 0.0.0.0 --port 3000
    ports:
      - port: 3000
`;

describe("sandbox template schedules", () => {
  test("accepts start, action, service, and command schedule targets", () => {
    const result = validateSandboxTemplateYaml(`${baseManifest}
schedules:
  - name: start-daily
    rate: 24 hours
    target:
      kind: start
  - name: report-daily
    cron: "0 8 * * *"
    target:
      kind: action
      name: report
  - name: web-once
    once: "2026-05-22T13:00:00"
    target:
      kind: service
      name: web
  - name: raw-command
    rate: 1 day
    target:
      kind: command
      command: echo scheduled
`);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.manifest.schedules.map((schedule) => schedule.name)
      ).toEqual(["start-daily", "report-daily", "web-once", "raw-command"]);
    }
  });

  test("rejects missing service schedule targets", () => {
    const result = validateSandboxTemplateYaml(`${baseManifest}
schedules:
  - name: bad-service
    rate: 1 day
    target:
      kind: service
      name: api
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]?.message).toContain(
        "schedule service target does not exist: api"
      );
    }
  });
});
