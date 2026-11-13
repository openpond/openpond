import type { CSSProperties } from "react";
import type { Session } from "@openpond/contracts";
import { Bot, Workflow } from "../icons";

export type SidebarThreadGroup = { id: string; title: string; role: "parent" | "child" };

export function sidebarThreadGroups(
  sessions: readonly Session[],
  childrenByParentId: Record<string, Session[]>,
): Map<string, SidebarThreadGroup> {
  const byId = new Map(
    [...sessions, ...Object.values(childrenByParentId).flat()].map((session) => [
      session.id,
      session,
    ]),
  );
  const result = new Map<string, SidebarThreadGroup>();
  for (const [parentId, children] of Object.entries(childrenByParentId)) {
    if (!children.length) continue;
    let rootId = parentId;
    const seen = new Set<string>();
    while (!seen.has(rootId)) {
      seen.add(rootId);
      const ancestor = byId.get(rootId)?.parentSessionId;
      if (!ancestor || !byId.has(ancestor)) break;
      rootId = ancestor;
    }
    const group = { id: rootId, title: byId.get(rootId)?.title || "Related conversations" };
    result.set(parentId, { ...group, role: parentId === rootId ? "parent" : "child" });
    for (const child of children) result.set(child.id, { ...group, role: "child" });
  }
  return result;
}

export function SidebarThreadGroupIndicator({
  group,
  inbox,
}: {
  group: SidebarThreadGroup;
  inbox: boolean;
}) {
  let hash = 0;
  for (const character of group.id) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  const style = { color: `var(--sidebar-thread-group-${(hash % 8) + 1})` } as CSSProperties;
  const label = `${group.role === "parent" ? "Parent conversation" : "Subagent conversation"} · ${group.title}`;
  const Icon = inbox && group.role === "parent" ? Workflow : Bot;
  return (
    <span
      className="sidebar-thread-group-indicator"
      style={style}
      aria-label={label}
      role="img"
      data-tooltip={label}
    >
      <Icon size={inbox ? 12 : 13} aria-hidden="true" />
    </span>
  );
}
