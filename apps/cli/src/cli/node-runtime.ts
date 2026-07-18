const OPENPOND_NODE_MAJOR = 24;
const OPENPOND_NODE_MIN_MINOR = 18;
const OPENPOND_NODE_MIN_VERSION = `${OPENPOND_NODE_MAJOR}.${OPENPOND_NODE_MIN_MINOR}.0`;

export function openPondTuiNodeRuntimeMessage(
  version = process.versions.node,
): string | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  const major = match ? Number(match[1]) : Number.NaN;
  const minor = match ? Number(match[2]) : Number.NaN;
  if (major === OPENPOND_NODE_MAJOR && minor >= OPENPOND_NODE_MIN_MINOR) return null;

  return [
    `OpenPond TUI requires Node.js ${OPENPOND_NODE_MIN_VERSION} or newer in the Node ${OPENPOND_NODE_MAJOR} release line; detected Node.js ${version}.`,
    `Switch Node versions and retry (with nvm: \`nvm install ${OPENPOND_NODE_MIN_VERSION} && nvm use ${OPENPOND_NODE_MIN_VERSION}\`).`,
  ].join("\n");
}
