import { desktopScenario } from "../../../scripts/desktop-harness/scenario";

export default desktopScenario({
  name: "fixture-fail",
  mode: "none",
  async run(harness) {
    harness.recordEvent("turn.started");
    harness.recordAssertion("parentChatVisible", false);
    throw new Error("intentional fixture failure");
  },
});
