export function verify({ task, output }) {
  const expected = task?.expectedOutput ?? {};
  const text = typeof output === "string" ? output : JSON.stringify(output ?? {});
  const visibleText = typeof output?.text === "string" ? output.text : text;
  const normalizedText = visibleText.normalize("NFKC").toLowerCase();
  const contract = expected.deterministicContract ?? {};
  const requiredOutputs = Array.isArray(output?.requiredOutputs)
    ? output.requiredOutputs
    : [];
  const failures = [];

  if (!text.trim()) failures.push("empty_output");
  for (const required of contract.requiredText ?? []) {
    if (!normalizedText.includes(String(required).toLowerCase())) {
      failures.push(`required_text_missing:${required}`);
    }
  }
  for (const group of contract.requiredAny ?? []) {
    if (!group.some((value) => normalizedText.includes(String(value).toLowerCase()))) {
      failures.push(`required_text_group_missing:${group.join("|")}`);
    }
  }
  for (const forbidden of contract.forbiddenText ?? []) {
    if (normalizedText.includes(String(forbidden).toLowerCase())) {
      failures.push(`forbidden_text_present:${forbidden}`);
    }
  }
  const wordCount = visibleText.trim() ? visibleText.trim().split(/\s+/).length : 0;
  if (Number.isFinite(contract.maxWords) && wordCount > contract.maxWords) {
    failures.push(`word_limit_exceeded:${wordCount}/${contract.maxWords}`);
  }
  const linkCount = (visibleText.match(/https?:\/\/[^\s)\]}]+/g) ?? []).length;
  if (Number.isFinite(contract.minLinks) && linkCount < contract.minLinks) {
    failures.push(`link_count_below_minimum:${linkCount}/${contract.minLinks}`);
  }
  if (
    contract.requireMessageBody === true
    && (
      wordCount < 20
      || (/checklist:/i.test(visibleText) && /(?:\/workspace\/|saved to|file path)/i.test(visibleText))
    )
  ) {
    failures.push("message_body_missing");
  }
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
    feedback: failures.length === 0
      ? "The deterministic output contract passed."
      : `Deterministic output contract failed: ${failures.join(", ")}.`,
    failures,
  };
}
