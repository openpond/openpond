const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const resourcesPath = path.join(context.appOutDir, appName, "Contents", "Resources");
  const prebuildsPath = path.join(resourcesPath, "server", "node_modules", "node-pty", "prebuilds");
  if (!fs.existsSync(prebuildsPath)) return;

  for (const entry of fs.readdirSync(prebuildsPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("darwin-")) continue;
    const helperPath = path.join(prebuildsPath, entry.name, "spawn-helper");
    if (!fs.existsSync(helperPath)) continue;
    fs.chmodSync(helperPath, 0o755);
  }
};
