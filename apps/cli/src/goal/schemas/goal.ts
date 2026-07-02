export const goalRunConfigSchema = {
  type: "object",
  required: ["goal", "mode"],
  properties: {
    goal: { type: "object" },
    apiUrl: { type: ["string", "null"] },
    mode: { enum: ["local", "hosted"] },
    workspace: { type: ["string", "null"] },
    storageRoot: { type: ["string", "null"] },
  },
} as const;
