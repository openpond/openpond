export function verify({ task, output }) {
  const expected = task?.expectedOutput ?? {};
  const text = typeof output === "string" ? output : JSON.stringify(output ?? {});
  const requiredOutputs = Array.isArray(output?.requiredOutputs)
    ? output.requiredOutputs
    : [];
  const failures = [];

  if (!text.trim()) failures.push("empty_output");
  if (
    expected.deliverable === "pdf" &&
    !requiredOutputs.some(
      (item) => item.mediaType === "application/pdf" && item.passed === true,
    )
  ) {
    failures.push("pdf_missing");
  }
  if (
    expected.deliverable === "spreadsheet" &&
    !requiredOutputs.some(
      (item) =>
        item.passed === true &&
        [
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "text/csv",
        ].includes(item.mediaType),
    )
  ) {
    failures.push("spreadsheet_missing");
  }
  for (const required of expected.validation ?? []) {
    if (
      !requiredOutputs.some(
        (item) => item.passed === true && item.validationKinds?.includes(required),
      )
    ) {
      failures.push(`validation_missing:${required}`);
    }
  }

  return {
    passed: failures.length === 0,
    score: failures.length === 0 ? 1 : 0,
    rewardEligible: failures.length === 0,
    failures,
  };
}
