import { expect, test } from "vitest";
import { updateCorrectedOutput } from "./updateCorrectedOutput";

// A correction must not train on contradictory copies of the same answer or mutate retained evidence.
test("corrected normalized answers preserve evidence and unrelated message content", () => {
  const input = { response: "pond", messages: [{ role: "user", content: "pond" }, { role: "assistant", content: "pond", id: "final" }] };
  const updated = updateCorrectedOutput(input, "response", "marsh");
  expect(updated).toEqual({ response: "marsh", messages: [{ role: "user", content: "pond" }, { role: "assistant", content: "marsh", id: "final" }] });
  expect(input.messages[1]?.content).toBe("pond");
  expect(input.response).toBe("pond");
  const unrelated = { ...input, messages: [{ role: "assistant", content: "Different retained context" }] };
  expect(updateCorrectedOutput(unrelated, "response", "marsh").messages).toBe(unrelated.messages);
  expect(updateCorrectedOutput(input, "annotation", "Reviewed").messages).toBe(input.messages);
});

