import {
  CROSS_SYSTEM_BOOTSTRAP_SYSTEM_PROMPT,
  CROSS_SYSTEM_TOOL_DEFINITIONS,
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  DATASET_NO_TOOLS_CONTRACT_HASH,
  type DatasetSelectionStrategy,
  type RftRecipe,
  type Taskset,
} from "@openpond/contracts";
import { sha256 } from "@openpond/taskset-sdk";

export type FireworksChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
};

export type FireworksChatTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type FireworksSftDataset = {
  bytes: Buffer;
  contentHash: string;
  exampleCount: number;
  estimatedTokens: number;
  taskIds: string[];
};

export type FireworksRftDataset = {
  bytes: Buffer;
  contentHash: string;
  exampleCount: number;
  estimatedTokens: number;
  taskIds: string[];
};

export type FireworksTrainingRecord = {
  id: string;
  input: Record<string, unknown>;
  expectedOutput?: Record<string, unknown> | null;
  tags: string[];
};

export type FireworksTrainingSelection = {
  records: FireworksTrainingRecord[];
  eligibleRows: number;
  selectionSeed: number;
  selectionStrategy: DatasetSelectionStrategy;
  taskIdsHash: string;
  sourceContentHash: string;
  sourceSizeBytes: number;
};

export function renderFireworksSftDataset(
  taskset: Taskset,
  selection?: FireworksTrainingSelection,
): FireworksSftDataset {
  const approvedTaskIds = new Set(
    taskset.learningSignals.demonstrations.flatMap((signal) =>
      signal.approved && signal.taskId ? [signal.taskId] : []),
  );
  const sourceRecords: FireworksTrainingRecord[] = selection?.records
    ?? taskset.tasks
      .filter((task) => task.split === "train")
      .map((task) => ({
        id: task.id,
        input: task.input,
        expectedOutput: task.expectedOutput,
        tags: task.tags,
      }));
  const records = sourceRecords.flatMap((task) => {
    if (
      !task.expectedOutput ||
      (!selection && !approvedTaskIds.has(task.id))
    ) {
      return [];
    }
    return [{
      taskId: task.id,
      value: {
        ...(usesCrossSystemToolContract(taskset)
          ? { tools: fireworksCrossSystemTools() }
          : {}),
        messages: trainingMessages(task.input, task.expectedOutput),
      },
    }];
  });
  if (records.length === 0) {
    throw new Error("Fireworks SFT requires at least one approved train-split demonstration.");
  }
  const text = `${records.map((record) => JSON.stringify(record.value)).join("\n")}\n`;
  const bytes = Buffer.from(text, "utf8");
  return {
    bytes,
    contentHash: sha256(bytes),
    exampleCount: records.length,
    estimatedTokens: Math.max(1, Math.ceil(bytes.byteLength / 4)),
    taskIds: records.map((record) => record.taskId),
  };
}

export function renderFireworksRftDataset(
  taskset: Taskset,
  recipe?: RftRecipe,
  selection?: FireworksTrainingSelection,
): FireworksRftDataset {
  const sourceRecords: FireworksTrainingRecord[] = selection?.records
    ?? taskset.tasks
      .filter((task) => task.split === "train")
      .map((task) => ({
        id: task.id,
        input: task.input,
        expectedOutput: null,
        tags: task.tags,
      }));
  const crossSystem = recipe
    ? recipe.reward.environmentId === "cross-system-operations"
    : usesCrossSystemToolContract(taskset);
  const toolContractHash = recipe?.reward.toolContractHash
    ?? (crossSystem
      ? CROSS_SYSTEM_TOOL_CONTRACT_HASH
      : DATASET_NO_TOOLS_CONTRACT_HASH);
  const records = sourceRecords
    .map((task) => {
      const messages = crossSystem
        ? [
            {
              role: "system" as const,
              content: CROSS_SYSTEM_BOOTSTRAP_SYSTEM_PROMPT,
            },
            {
              role: "user" as const,
              content: requiredPrompt(task.input),
            },
          ]
        : policyMessages(task.input);
      return {
        taskId: task.id,
        value: {
          messages,
          input_metadata: {
            row_id: task.id,
            dataset_info: {
              taskset_id: taskset.id,
              taskset_hash: taskset.contentHash,
              task_id: task.id,
              tool_contract_hash: toolContractHash,
            },
          },
        },
      };
    });
  if (!records.length) {
    throw new Error("Fireworks RFT requires at least one approved train-split prompt.");
  }
  const text = `${records.map((record) => JSON.stringify(record.value)).join("\n")}\n`;
  const bytes = Buffer.from(text, "utf8");
  const forbidden = [
    '"expectedOutput"',
    '"expectedAnswer"',
    '"privilegedContextRef"',
    '"grader"',
    '"frozen_eval"',
  ];
  const leaked = forbidden.find((token) => text.includes(token));
  if (leaked) throw new Error(`Fireworks RFT policy dataset contains forbidden private material ${leaked}.`);
  return {
    bytes,
    contentHash: sha256(bytes),
    exampleCount: records.length,
    estimatedTokens: Math.max(1, Math.ceil(bytes.byteLength / 4)),
    taskIds: records.map((record) => record.taskId),
  };
}

function policyMessages(input: Record<string, unknown>): FireworksChatMessage[] {
  const messages = parseMessages(input.messages);
  if (messages.length) return messages;
  return [{ role: "user", content: requiredPrompt(input) }];
}

function requiredPrompt(input: Record<string, unknown>): string {
  const prompt = typeof input.prompt === "string" && input.prompt.trim()
    ? input.prompt
    : parseMessages(input.messages)
      .filter((message) => message.role === "user")
      .at(-1)?.content;
  return requiredText(prompt, "Task input prompt");
}

function trainingMessages(
  input: Record<string, unknown>,
  expectedOutput: Record<string, unknown>,
): FireworksChatMessage[] {
  const inputMessages = parseMessages(input.messages);
  const outputMessages = parseMessages(expectedOutput.messages);
  const messages = inputMessages.length
    ? [...inputMessages, ...outputMessages]
    : [
        {
          role: "user" as const,
          content: requiredText(input.prompt, "Task input prompt"),
        },
        {
          role: "assistant" as const,
          content: requiredText(expectedOutput.text, "Task expected output"),
        },
      ];
  if (!messages.some((message) => message.role === "assistant")) {
    messages.push({
      role: "assistant",
      content: requiredText(expectedOutput.text, "Task expected output"),
    });
  }
  if (messages.at(-1)?.role !== "assistant") {
    throw new Error("Fireworks SFT examples must end with an assistant target.");
  }
  return messages;
}

function parseMessages(value: unknown): FireworksChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const message = item as Record<string, unknown>;
    const role = message.role;
    if (
      role !== "system" &&
      role !== "user" &&
      role !== "assistant" &&
      role !== "tool"
    ) {
      return [];
    }
    // Fireworks' dataset ingestion converts null-valued fields through its API
    // representation before applying the base model's Jinja chat template. A
    // null assistant tool-call content can therefore arrive at Qwen as a
    // missing `content` key. Keep the OpenAI-compatible field present as a
    // string for every message.
    const content = typeof message.content === "string" ? message.content : "";
    const parsed: FireworksChatMessage = { role, content };
    if (typeof message.tool_call_id === "string" && message.tool_call_id) {
      parsed.tool_call_id = message.tool_call_id;
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      parsed.tool_calls = message.tool_calls;
    }
    return [parsed];
  });
}

function usesCrossSystemToolContract(taskset: Taskset): boolean {
  return taskset.metadata.toolContractHash === CROSS_SYSTEM_TOOL_CONTRACT_HASH
    || taskset.environment.metadata.toolContractHash === CROSS_SYSTEM_TOOL_CONTRACT_HASH;
}

function fireworksCrossSystemTools(): FireworksChatTool[] {
  return CROSS_SYSTEM_TOOL_DEFINITIONS.map((definition) => ({
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: structuredClone(definition.parameters) as Record<string, unknown>,
    },
  }));
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required for Fireworks SFT.`);
  }
  return value;
}
