import { executeJavaScriptIsolate, type JavaScriptIsolateInput } from "./javascript-isolate.js";

// Only this bundled, trusted program runs in Node. Authored source is interpreter data.
const owner = globalThis as typeof globalThis & { __openpondIsolateInput?: JavaScriptIsolateInput };
const input = owner.__openpondIsolateInput;
delete owner.__openpondIsolateInput;
if (!input) throw new Error("JavaScript process requires its execution owner.");
void executeJavaScriptIsolate(input).then(
  (result) => process.stdout.write(JSON.stringify({ ok: true, result })),
  (error: unknown) => process.stdout.write(JSON.stringify({ ok: false, error: (error instanceof Error ? error.message : "JavaScript execution failed.").slice(0, 8_192) })),
);
