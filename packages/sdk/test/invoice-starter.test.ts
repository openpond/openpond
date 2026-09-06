import { expect, it } from "vitest";
import { executeJavaScriptVerifier } from "@openpond/evals/javascript-verifier";
import { createInvoiceStarterPackage, INVOICE_VERIFIER_SOURCE } from "../../../examples/training/invoice-extraction/package.js";

// The shipped verifier must reject corrupted extractions and invented missing
// values in the real isolated evaluator, across every authored customer family.
it("executes invoice checks against correct, corrupted and unsupported outputs", async () => {
  const first = createInvoiceStarterPackage();
  expect(createInvoiceStarterPackage()).toEqual(first);
  expect(first.taskset.tasks).toHaveLength(80);
  expect(first.starter.evidence).toEqual({ verifierFixtures: null, baseline: null, training: null, evaluation: null });
  for (const task of first.taskset.tasks) {
    const expected = task.expectedOutput!;
    const input = { input: task.input, expectedOutput: expected, evaluatorContext: null };
    const grade = (output: Record<string, unknown>) => executeJavaScriptVerifier({ source: INVOICE_VERIFIER_SOURCE, exportName: "verify", timeoutMs: 1_000, value: { ...input, output } });
    expect(await grade(expected)).toMatchObject({ passed: true, score: 1 });
    expect(await grade({ ...expected, invoiceNumber: "UNSUPPORTED-INVOICE" })).toMatchObject({ passed: false, score: 0 });
    if (expected.total === null) expect(await grade({ ...expected, total: Number(expected.subtotal) + Number(expected.tax) })).toMatchObject({ passed: false, score: 0 });
    expect(task.input).not.toHaveProperty("expectedOutput");
  }
  const task = first.taskset.tasks[0]!;
  expect(task.expectedOutput).toMatchObject({ supplier: "Cedar Office", invoiceNumber: "INV-1-001", subtotal: 9, tax: 0.45, total: 9.45 });
  expect(first.taskset.tasks[3]!.expectedOutput?.total).toBeNull();
  expect(String(first.taskset.tasks[3]!.input.document)).not.toContain("\nTotal:");
}, 30_000);
