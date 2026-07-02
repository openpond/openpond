import { volume } from "openpond-agent-sdk";

export const waterEstimatorVolumes = [
  volume("drawing-plans", "/workspace/volumes/drawing-plans", {
    description: "Input drawings, rendered pages, and extraction intermediates.",
    storageGb: 8,
    deleteOnSandboxDelete: false,
    provisioning: {
      mode: "select-or-create",
      scope: "project",
      selector: {
        kind: "project-volume",
        name: "drawing-plans",
        labels: {
          "openpond.agent": "cloud-water-estimator-example",
          "openpond.volumeRole": "drawing-inputs",
        },
      },
      create: {
        storageGb: 8,
        retention: "retain",
      },
      ui: {
        label: "Drawing plan volume",
        description: "Select an existing drawing workspace or create a new one for uploaded plan PDFs.",
        allowUpload: true,
        required: true,
      },
    },
    state: {
      engine: "filesystem",
    },
    usedBy: [
      "generate-task-plan",
      "render-drawings",
      "extract-sheet-index",
      "extract-page-tasks",
    ],
  }),
  volume("water-history", "/workspace/volumes/water-history", {
    description: "Durable task-plan history, ledgers, and proposal review state.",
    storageGb: 8,
    deleteOnSandboxDelete: false,
    provisioning: {
      mode: "select-or-create",
      scope: "project",
      selector: {
        kind: "project-volume",
        name: "water-history",
        labels: {
          "openpond.agent": "cloud-water-estimator-example",
          "openpond.volumeRole": "history",
        },
      },
      create: {
        storageGb: 8,
        retention: "retain",
      },
      ui: {
        label: "Water estimator history",
        description: "Select the saved estimating history volume or create one for this project.",
        required: true,
      },
    },
    state: {
      engine: "sqlite",
      files: [
        "history/task-plans.sqlite",
        "proposals/task-plans.sqlite",
      ],
      concurrency: "single-writer-per-agent-run",
    },
    usedBy: [
      "generate-estimate",
      "task-plan-history",
      "revise-task-plan",
    ],
  }),
];
