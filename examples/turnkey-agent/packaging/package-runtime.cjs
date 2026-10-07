const { realpathSync, readFileSync } = require("node:fs");
const { dirname, resolve } = require("node:path");
const { createRequire } = require("node:module");

// pkg's runtime calls os.homedir() before the application entrypoint. QuorumOS
// has neither HOME nor /etc/passwd. Set HOME in the embedded prelude itself.
// Keep this adaptation scoped to this build; never modify the package cache.
const packageRequire = createRequire(realpathSync(process.argv[2]));
const pkgRoot = dirname(packageRequire.resolve("@yao-pkg/pkg/package.json"));
const metadata = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf8"));
if (metadata.name !== "@yao-pkg/pkg" || metadata.version !== "6.23.0") {
  throw new Error("The TVC bootstrap adapter requires @yao-pkg/pkg 6.23.0");
}
const packer = require(resolve(pkgRoot, "lib-es5/packer.js"));
const originalPack = packer.default;
packer.default = (...args) => {
  const result = originalPack(...args);
  if (!result.prelude.startsWith("return (function (REQUIRE_COMMON,")) {
    throw new Error("Unexpected pkg prelude; review the bootstrap adapter");
  }
  result.prelude = "process.env.HOME = '/tmp';\n" + result.prelude;
  return result;
};

require(resolve(pkgRoot, metadata.main)).exec([
  "dist/turnkey-agent/app.cjs",
  "--targets", "node24.20.0-linuxstatic-x64",
  "--output", "dist/turnkey-agent/openpond-tvc",
  "--no-bytecode", "--public", "--public-packages", "*",
  "--no-native-build", "--options", "max-old-space-size=512",
]).catch((error) => { console.error(error); process.exitCode = 1; });
