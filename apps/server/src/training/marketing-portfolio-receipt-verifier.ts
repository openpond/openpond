export function marketingPortfolioReceiptVerifierSource(input: {
  benchmarkId: string;
  agentReleaseHash: string;
  scorerImplementationHash: string;
}): string {
  const benchmarkId = JSON.stringify(input.benchmarkId);
  const agentReleaseHash = JSON.stringify(input.agentReleaseHash);
  const scorerImplementationHash = JSON.stringify(
    input.scorerImplementationHash,
  );
  return `export function verifyMarketingPortfolioReceipt(value) {
  const output = value && typeof value === "object" ? value.output : null;
  const receipt =
    output && typeof output === "object" && !Array.isArray(output)
      ? output.harnessGrade
      : null;
  const components =
    receipt && typeof receipt === "object" && !Array.isArray(receipt)
      ? receipt.components
      : null;
  const componentValues =
    components && typeof components === "object" && !Array.isArray(components)
      ? [
          components.constraints,
          components.portfolioValue,
          components.riskControls,
          components.rationale
        ]
      : [];
  const reward =
    receipt && typeof receipt === "object" && !Array.isArray(receipt)
      ? receipt.reward
      : null;
  const hashPattern = /^[a-f0-9]{64}$/;
  const valid =
    receipt &&
    typeof receipt === "object" &&
    !Array.isArray(receipt) &&
    receipt.schemaVersion === "openpond.marketingPortfolioGrade.v1" &&
    receipt.benchmarkId === ${benchmarkId} &&
    receipt.agentReleaseHash === ${agentReleaseHash} &&
    receipt.scorerImplementationHash === ${scorerImplementationHash} &&
    receipt.terminalActionId === "submit-budget-decision" &&
    typeof receipt.decisionAccepted === "boolean" &&
    typeof reward === "number" &&
    Number.isFinite(reward) &&
    reward >= 0 &&
    reward <= 1 &&
    typeof receipt.caseRef === "string" &&
    hashPattern.test(receipt.caseRef) &&
    typeof receipt.traceHash === "string" &&
    hashPattern.test(receipt.traceHash) &&
    componentValues.length === 4 &&
    componentValues.every(
      (component) =>
        typeof component === "number" &&
        Number.isFinite(component) &&
        component >= 0 &&
        component <= 1
    );
  return {
    score: valid ? reward : 0,
    passed: Boolean(valid),
    feedback: valid
      ? "Pinned Harness grade receipt verified."
      : "Invalid Harness grade receipt.",
    evidenceRefs:
      valid && typeof receipt.traceHash === "string"
        ? ["trace_" + receipt.traceHash]
        : []
  };
}
`;
}
