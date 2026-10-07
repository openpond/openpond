import { parseArgs } from "node:util";
import { configSchema } from "./config.js";
import { probeRuntime } from "./runtime.js";
import { createExampleServer } from "./server.js";
import { startEmbeddedModel } from "./local-model/runtime.js";

async function main() {
  const { values } = parseArgs({ options: {
    "config-json": { type: "string" }, "probe": { type: "boolean", default: false },
  } });
  if (!values["config-json"]) throw new Error("Public --config-json configuration is required");
  const config = configSchema.parse(JSON.parse(values["config-json"]));
  const model = config.mode === "embedded" ? await startEmbeddedModel(config) : undefined;
  try {
    await probeRuntime(config, model);
    if (values.probe) {
      await model?.close();
      console.log(JSON.stringify({ status: "ok", appServer: true, sqlite: true, embeddedModel: Boolean(model) })); return;
    }
    const app = createExampleServer(config, model);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
      const deadline = setTimeout(() => process.exit(1), 10_000).unref();
      void app.close().finally(() => model?.close()).then(() => { clearTimeout(deadline); process.exit(0); });
    });
    await new Promise<void>((resolve, reject) => {
      app.server.once("error", reject);
      app.server.listen(config.port, config.host, resolve);
    });
    const address = app.server.address();
    console.log(JSON.stringify({ status: "listening", port: typeof address === "object" ? address?.port : config.port }));
  } catch (error) { await model?.close(); throw error; }
}

void main().catch(() => {
  // Configuration may contain accidentally supplied credentials; don't print parser issues.
  console.error("Turnkey example startup failed. Check public configuration and packaged runtime assets.");
  process.exitCode = 1;
});
