import { describe, expect, test } from "vitest";

import {
  defineSandboxTemplate,
  sandboxTemplateDurableVolume,
  sandboxTemplateFileInput,
  sandboxTemplatePreviewPort,
  sandboxTemplateResources,
  validateSandboxTemplateManifest,
} from "../src/sandbox-template/manifest";

describe("sandbox template helpers", () => {
  test("build common resource, volume, file input, and preview port fragments", () => {
    const manifest = defineSandboxTemplate({
      schemaVersion: 1,
      name: "helper-template",
      version: "0.1.0",
      useCase: "helper-test",
      description: "Helper generated manifest.",
      runtime: { base: "node" },
      resources: sandboxTemplateResources({ cpu: 1, memoryGb: 2, diskGb: 8 }),
      validation: { commands: ["echo ok"], probes: [] },
      start: {
        command: "pnpm process",
        ports: [],
      },
      services: [
        {
          name: "web",
          command: "pnpm dev --host 0.0.0.0 --port 3000",
          ports: [sandboxTemplatePreviewPort(3000, { label: "web" })],
        },
      ],
      volumes: [
        sandboxTemplateDurableVolume({
          name: "uploads",
          mountPath: "/workspace/volumes/uploads",
          storageGb: 8,
        }),
      ],
      inputs: {
        schema: {
          type: "object",
          required: ["proposal"],
          properties: {
            proposal: sandboxTemplateFileInput({
              title: "Proposal",
              targetPath: "volumes/uploads/proposals",
              accept: [".pdf"],
            }),
            history: sandboxTemplateFileInput({
              title: "History",
              targetPath: "volumes/uploads/history",
              accept: [".xlsx", ".csv"],
              multiple: true,
            }),
          },
        },
        env: [],
      },
      actions: [],
      schedules: [],
      mcp: { endpoints: [] },
      integrations: { requiredLeases: [] },
      permissions: {
        opchat: {
          models: ["openpond-chat"],
          scopes: ["opchat:model:read", "opchat:chat:create"],
        },
      },
      artifacts: { paths: [] },
      network: { egress: "restricted" },
      setup: { commands: [] },
    });

    const result = validateSandboxTemplateManifest(manifest);

    expect(result.ok).toBe(true);
    expect(manifest.volumes[0]?.deleteOnSandboxDelete).toBe(false);
    expect(manifest.services[0]?.ports[0]).toMatchObject({
      port: 3000,
      access: "private",
      path: "/",
    });
    expect(result.ok ? result.manifest.permissions.opchat : null).toMatchObject({
      models: ["openpond-chat"],
      scopes: ["opchat:model:read", "opchat:chat:create"],
    });
  });

  test("uses the validator for invalid helper fragments", () => {
    expect(() => sandboxTemplatePreviewPort(2999)).toThrow();
    expect(() =>
      sandboxTemplateFileInput({ targetPath: "../outside" })
    ).toThrow();
  });

  test("validates Docker image and Dockerfile workload sources", () => {
    const base = {
      schemaVersion: 1,
      name: "docker-runtime-template",
      version: "0.1.0",
      useCase: "docker-runtime-test",
      description: "Docker runtime manifest.",
      resources: { cpu: 1, memoryGb: 2, diskGb: 8 },
      validation: { commands: ["python --version"], probes: [] },
      start: {
        command: "python app.py",
        ports: [],
      },
      actions: [],
      services: [],
      schedules: [],
    };

    expect(
      validateSandboxTemplateManifest({
        ...base,
        runtime: {
          image: {
            ref: "python:3.12-slim-bookworm",
            workspaceRoot: "/workspace/project",
          },
        },
      }).ok
    ).toBe(true);
    expect(
      validateSandboxTemplateManifest({
        ...base,
        runtime: {
          dockerfile: {
            context: ".",
            path: "Dockerfile",
            buildArgs: { NODE_VERSION: "20" },
          },
        },
      }).ok
    ).toBe(true);

    const invalid = validateSandboxTemplateManifest({
      ...base,
      runtime: {
        base: "node-bun-workspace",
        image: { ref: "python:3.12-slim-bookworm" },
      },
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.ok ? "" : invalid.diagnostics[0]?.message).toContain(
      "exactly one of base, snapshot, image, or dockerfile"
    );
  });
});
