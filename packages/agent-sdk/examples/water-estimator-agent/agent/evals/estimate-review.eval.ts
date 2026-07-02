import { defineEval } from "openpond-agent-sdk";

export default defineEval({
  name: "history-and-proposal-routes-to-estimate-review",
  description: "History spreadsheets and a proposal should route to the estimate-review workflow.",
  async run(t) {
    await t.send({
      prompt: "Review this proposal against our historical water estimates.",
      channel: "openpond_chat",
      files: [
        { ref: "fixtures/history.csv", name: "history.csv" },
        { ref: "fixtures/proposal.pdf", name: "proposal.pdf" },
      ],
    });
    t.expectIntent("generate_estimate_review");
    t.expectArtifact("artifacts/example-estimate.xlsx");
    t.expectArtifact("artifacts/proposal-review.json");
  },
});
