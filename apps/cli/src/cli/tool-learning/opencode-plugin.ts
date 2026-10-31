/** Generated local observer: original arguments, results and permissions stay untouched.
 * Only typed tool/lifecycle hooks cross stdin to the scoped OpenPond CLI. */
export function opencodeCapturePlugin(launcher: string[]) {
  return `import { spawn } from "node:child_process";
const launcher = ${JSON.stringify(launcher)};
export const OpenPondToolCapture = async ({ directory, client }) => {
  async function capture(value) {
    try {
      const body = JSON.stringify({ cwd: directory, ...value });
      if (Buffer.byteLength(body) > 1048576) return;
      await new Promise((resolve, reject) => {
        const child = spawn(launcher[0], launcher.slice(1), { stdio: ["pipe", "ignore", "ignore"], timeout: 7000 });
        child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(new Error("capture_unavailable")));
        child.stdin.on("error", () => {}); child.stdin.end(body);
      });
    } catch {
      await client.app.log({ body: { service: "openpond-capture", level: "warn", message: "Capture unavailable; run openpond tool-learning doctor." } }).catch(() => {});
    }
  }
  return {
    "tool.execute.before": async (input, output) => capture({ event: "attempt", sessionId: input.sessionID, callId: input.callID, tool: input.tool, arguments: output.args }),
    "tool.execute.after": async (input, output) => capture({ event: "observation", sessionId: input.sessionID, callId: input.callID, tool: input.tool, text: output.output, exitCode: Number.isInteger(output.metadata?.exit) ? output.metadata.exit : null }),
    event: async ({ event }) => {
      if (event.type === "session.created") await capture({ event: "start", sessionId: event.properties.info.id });
      if (event.type === "session.compacted") await capture({ event: "compact", sessionId: event.properties.sessionID });
      if (event.type === "session.idle") await capture({ event: "idle", sessionId: event.properties.sessionID });
      const part = event.type === "message.part.updated" ? event.properties.part : null;
      if (part?.type === "tool" && part.state?.status === "error") await capture({ event: "failure", sessionId: part.sessionID, callId: part.callID, tool: part.tool, text: part.state.error });
    },
  };
};
`;
}
