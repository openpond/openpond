export function verify({ task, output }) {
  const text = typeof output?.text === "string" ? output.text.trim() : "";
  const criteria = Array.isArray(task?.evaluationCriteria)
    ? task.evaluationCriteria
    : [];
  const requiredOutputs = Array.isArray(output?.requiredOutputs)
    ? output.requiredOutputs
    : [];
  const maxWords = Number(task?.policyVisibleContext?.visibleConstraints?.maxWords);
  const wordCount = text ? text.split(/\s+/).length : 0;
  const scores = [];

  for (const criterion of criteria) {
    if (!Array.isArray(criterion?.scorerIds) || !criterion.scorerIds.includes("task-visible-contract")) continue;
    let passed = true;
    let feedback = "Visible output constraints passed.";
    if (criterion.kind === "artifact_structure") {
      const required = Array.isArray(task?.requiredOutputs) ? task.requiredOutputs : [];
      passed = required.every((contract) => requiredOutputs.some((item) =>
        item?.passed === true
        && item?.mediaType === contract?.mediaType
        && (item?.requiredOutputPath === contract?.path || item?.path === contract?.path)
      ));
      feedback = passed
        ? "Declared artifact and validation receipts passed."
        : "A declared artifact or validation receipt is missing or invalid.";
    } else {
      passed = Boolean(text) && (!Number.isFinite(maxWords) || wordCount <= maxWords);
      feedback = !text
        ? "The response is empty."
        : Number.isFinite(maxWords) && wordCount > maxWords
          ? `The visible ${maxWords}-word limit was exceeded (${wordCount}).`
          : "The response satisfies visible output-shape constraints.";
    }
    scores.push({
      criterionId: criterion.id,
      score: passed ? 1 : 0,
      passed,
      feedback,
      evidenceRefs: [],
    });
  }

  const score = scores.length
    ? scores.reduce((total, item) => total + item.score, 0) / scores.length
    : 0;
  const passed = scores.length > 0 && scores.every((item) => item.passed);
  return {
    score,
    passed,
    feedback: passed
      ? "Visible deterministic constraints passed."
      : "One or more visible deterministic constraints failed.",
    criterionScores: scores,
    evidenceRefs: [],
  };
}
