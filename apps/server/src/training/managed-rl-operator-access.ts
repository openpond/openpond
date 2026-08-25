import { readFile, stat } from "node:fs/promises";

export type ManagedRlOperatorAccess = {
  apiBaseUrl: string;
  token: string;
  teamId: string;
};

export async function managedRlOperatorAccess(
  env: NodeJS.ProcessEnv,
): Promise<ManagedRlOperatorAccess | null> {
  const apiBaseUrl = env.OPENPOND_MANAGED_RL_API_URL?.trim().replace(/\/+$/, "");
  const credentialFile = env.OPENPOND_MANAGED_RL_CREDENTIAL_FILE?.trim();
  const teamId = env.OPENPOND_MANAGED_RL_TEAM_ID?.trim();
  if (!apiBaseUrl && !credentialFile && !teamId) return null;
  if (!apiBaseUrl || !credentialFile || !teamId) {
    throw new Error(
      "OPENPOND_MANAGED_RL_API_URL, OPENPOND_MANAGED_RL_CREDENTIAL_FILE, and OPENPOND_MANAGED_RL_TEAM_ID must be configured together.",
    );
  }
  const url = new URL(apiBaseUrl);
  const loopback = url.protocol === "http:"
    && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !loopback)
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error("OPENPOND_MANAGED_RL_API_URL must be an HTTPS origin or loopback HTTP origin.");
  }
  if (!/^[A-Za-z0-9_-]{3,191}$/.test(teamId)) {
    throw new Error("OPENPOND_MANAGED_RL_TEAM_ID is invalid.");
  }
  const info = await stat(credentialFile);
  if (!info.isFile() || (info.mode & 0o077) !== 0) {
    throw new Error("OPENPOND_MANAGED_RL_CREDENTIAL_FILE must be a private regular file.");
  }
  const credential = JSON.parse(await readFile(credentialFile, "utf8")) as {
    apiKey?: unknown;
    teamId?: unknown;
  };
  const token = typeof credential.apiKey === "string" ? credential.apiKey.trim() : "";
  if (!token.startsWith("opk_") || credential.teamId !== teamId) {
    throw new Error("Managed RL operator credential does not match the selected team.");
  }
  return { apiBaseUrl, token, teamId };
}
