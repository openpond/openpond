# Use OpenPond in your product


Configure one application-owned server client. Bind aliases to exact callable
Model IDs from your OpenPond workspace:

```ts
import { createOpenPondClient } from "openpond-sdk";

export const openpond = createOpenPondClient({
  apiKey: process.env.OPENPOND_API_KEY!,
  teamId: process.env.OPENPOND_TEAM_ID!,
  datasetId: process.env.OPENPOND_DATASET_ID!,
  models: { support: process.env.OPENPOND_MODEL_ID! },
});

const answer = await openpond.models.support.generate({ prompt: "How do I rotate a token?" });
console.log(answer.text, answer.requestId, answer.usage);
```

The SDK connects to OpenPond with your API key for task submission and personalized
inference. Use a key authorized for the selected Dataset and Model. A Dataset-only
producer key cannot invoke inference. Bind the exact callable Model ID; no
catalogue default or substitute Model is selected. Naming a Model never activates serving, approves a
candidate, starts training, or automatically captures inference as a task.
Decision scorers use their separate typed scoring APIs.

`generate` accepts either `prompt` or text `messages`, plus optional `temperature`,
`maxTokens` and `signal`. Results include `text`, `requestId`, requested `modelId`,
server-reported `resolvedModelId`, `finishReason`, nullable `usage`, and nullable
`systemFingerprint`, plus retained server `evidence` when supplied. Evidence
presence is not client-side verification. Core handles are text APIs; tools need
the supported integration and explicit capabilities. The current personalized API
rejects multimodal and structured-output modes. Aliases are typed TypeScript
properties; multiple clients remain independent.

```ts
for await (const event of openpond.models.support.stream({ prompt: "Explain token rotation" })) {
  if (event.type === "text") process.stdout.write(event.text);
  else console.log(event.result.usage);
}
```

Breaking the iteration cancels the response. An interrupted stream raises
`ProductModelError` and never emits a successful `finish`. It may already have
incurred usage; inference is never automatically replayed. `serving.timeoutMs`
defaults to 60 seconds and accepts at most 300 seconds. Supply a caller abort
signal to cancel an individual request. Text requests are bounded to 1 MiB and
results to 8 MiB; individual stream frames to 1 MiB.

Await task delivery separately with `openpond.addTask(...)`. If inference succeeds
and optional task delivery fails, preserve both outcomes rather than discarding
the delivery error or pretending the answer failed. See [task ingestion](TASK_INGESTION.md).

## Python sync and async

```python
from ponder_sdk import AsyncClient

async with AsyncClient(
    api_key=api_key, team_id=team_id,
    dataset_id=dataset_id,
    model_aliases={"support": model_id},
) as openpond:
    answer = await openpond.models.support.generate(prompt="How do I rotate a token?")
    print(answer.text, answer.request_id, answer.usage)
    await openpond.add_task({"id": event_id, "name": "Token rotation", "input": {"question": question}})
    async for event in openpond.models.support.stream(prompt="Explain the steps"):
        if event.type == "text":
            print(event.text, end="")
```

`Client` has the same configuration and synchronous calls/iteration. Named aliases
augment existing Model administration methods; choose aliases that don't collide
with those methods. Bracket access (`openpond.models["support"]`) is also available.
Inference shares the existing client's HTTP pool and timeout. Close partially
consumed iterators (or use `contextlib.closing`/`aclosing`) to release streams
promptly. Native async cancellation propagates. No SDK queues or flush calls exist.

## Optional Vercel AI SDK 7 integration

Install `ai@^7.0.165` and `@ai-sdk/openai-compatible@^3.0.87` alongside OpenPond.
Only the `openpond-sdk/ai-sdk` entry point imports the optional provider; task
submission has no Vercel dependency. This adapter targets LanguageModelV4 and is
not an upgrade of an application's existing AI SDK 4/5/6 installation.

```ts
import { generateText, streamText } from "ai";
import { toAIModel } from "openpond-sdk/ai-sdk";
import { openpond } from "./openpond.server.js";

const model = toAIModel(openpond.models.support);
const answer = await generateText({ model, prompt: "Explain token rotation", maxRetries: 0 });

// Inside an authenticated product backend route:
export async function POST(request: Request) {
  // Authenticate the product user and validate/limit this payload first.
  const { prompt } = await request.json();
  const result = streamText({ model, prompt, abortSignal: request.signal, maxRetries: 0 });
  return result.toUIMessageStreamResponse();
}
```

Use the AI SDK 7 React `useChat`/transport recipe against your own authenticated
backend. Never place the OpenPond client or secrets in browser code. AI SDK's UI
stream response is different from raw OpenAI SSE; use
`toUIMessageStreamResponse()` rather than forwarding raw SSE into `useChat`.

The official compatible provider handles content/usage conversion, tool deltas and
stream cancellation. OpenPond gates features against the selected binding:

```ts
models: {
  support: {
    id: process.env.OPENPOND_MODEL_ID!,
    capabilities: { streaming: true, tools: true },
  },
}
```

Only enable tools after checking that exact deployment.
Defaults are streaming enabled and tools disabled. Structured-output and multimodal
inputs are rejected. Failed provider calls are surfaced as non-retryable SDK
errors to prevent implicit replay of billed requests. Explicit `maxRetries: 0`
also makes that intent visible in application code.
