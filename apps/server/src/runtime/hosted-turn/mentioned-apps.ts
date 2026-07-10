import type { OpenPondApp } from "@openpond/contracts";

export async function resolveMentionedAppsForTurn(
  appIds: string[] | undefined,
  findApp: (appId: string) => Promise<OpenPondApp>,
): Promise<OpenPondApp[]> {
  const uniqueIds = Array.from(new Set((appIds ?? []).map((appId) => appId.trim()).filter(Boolean)));
  if (uniqueIds.length === 0) return [];
  const apps = await Promise.all(uniqueIds.map((appId) => findApp(appId).catch(() => null)));
  return apps.filter((app): app is OpenPondApp => Boolean(app));
}
