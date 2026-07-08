import { desktopScenario } from "../../../scripts/desktop-harness/scenario";

export default desktopScenario({
  name: "fixture-pass",
  mode: "none",
  async run(harness) {
    harness.recordEvent("turn.started");
    harness.recordAssertion("parentChatVisible", true);
    harness.recordMetadata({
      parentSessionId: "session_fixture_parent",
    });
  },
});
