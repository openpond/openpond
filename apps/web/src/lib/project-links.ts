import type { LocalProject, LocalProjectOpenPondLink, OpenPondApp } from "@openpond/contracts";

export function currentOpenPondAppIds(apps: readonly OpenPondApp[]): ReadonlySet<string> {
  return new Set(apps.map((app) => app.id));
}

export function currentOpenPondProjectLink(
  project: LocalProject | null | undefined,
  appIds: ReadonlySet<string>
): LocalProjectOpenPondLink | null {
  const link = project?.linkedOpenPondApp ?? null;
  return link?.appId && appIds.has(link.appId) ? link : null;
}

export function isLinkedToCurrentOpenPondApp(project: LocalProject, appIds: ReadonlySet<string>): boolean {
  return Boolean(currentOpenPondProjectLink(project, appIds));
}
