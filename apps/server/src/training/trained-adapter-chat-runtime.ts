import type {
  HostedChatMessage,
  HostedChatTool,
  HostedChatToolChoice,
} from "@openpond/cloud";
import type { LocalAdapterChatDelta } from "./local-adapter-chat-runtime.js";

type AdapterStreamInput = {
  modelId: string | null | undefined;
  messages: HostedChatMessage[];
  requestId: string;
  signal: AbortSignal;
  maxNewTokens?: number;
  temperature?: number;
  tools?: HostedChatTool[];
  toolChoice?: HostedChatToolChoice;
};

type AdapterStream = (
  input: AdapterStreamInput,
) => AsyncGenerator<LocalAdapterChatDelta, void, unknown>;

export function createTrainedAdapterChatRuntime(dependencies: {
  managed: {
    appliesTo(modelId: string | null | undefined): Promise<boolean>;
    stream: AdapterStream;
  };
  fireworks: {
    appliesTo(modelId: string | null | undefined): Promise<boolean>;
    stream: AdapterStream;
  };
  local: {
    stream: AdapterStream;
    close(): Promise<void>;
  };
}) {
  async function* stream(input: AdapterStreamInput) {
    if (await dependencies.managed.appliesTo(input.modelId)) {
      yield* dependencies.managed.stream(input);
      return;
    }
    if (await dependencies.fireworks.appliesTo(input.modelId)) {
      yield* dependencies.fireworks.stream(input);
      return;
    }
    yield* dependencies.local.stream(input);
  }

  return {
    stream,
    close: dependencies.local.close,
  };
}
