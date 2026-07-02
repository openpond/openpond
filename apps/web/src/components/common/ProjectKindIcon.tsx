import type { SidebarProjectKind } from "../../lib/app-models";

type ProjectKindIconProps = {
  kind: SidebarProjectKind;
  agentSdk?: boolean;
  open?: boolean;
  className?: string;
  baseSize?: number;
};

export function ProjectKindIcon({
  kind,
  agentSdk = false,
  open = false,
  className,
  baseSize = 15,
}: ProjectKindIconProps) {
  const iconName = kind === "cloud" ? "cloud" : open ? "folder-open" : "folder";
  return (
    <span
      className={[
        "project-kind-icon",
        kind,
        agentSdk ? "agent-sdk" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-hidden="true"
    >
      <svg
        className={`lucide lucide-${iconName} project-kind-icon-svg`}
        xmlns="http://www.w3.org/2000/svg"
        width={baseSize}
        height={baseSize}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {kind === "cloud" ? <CloudShape /> : open ? <FolderOpenShape /> : <FolderShape />}
        {agentSdk ? <AgentSdkBotGlyph kind={kind} /> : null}
      </svg>
    </span>
  );
}

function FolderShape() {
  return (
    <path
      className="project-kind-icon-base"
      d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
    />
  );
}

function FolderOpenShape() {
  return (
    <path
      className="project-kind-icon-base"
      d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"
    />
  );
}

function CloudShape() {
  return (
    <path
      className="project-kind-icon-base"
      d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"
    />
  );
}

function AgentSdkBotGlyph({ kind }: { kind: SidebarProjectKind }) {
  if (kind === "cloud") {
    return (
      <g className="project-kind-icon-agent">
        <path d="M12 10.4V8.8h-1.6" />
        <rect width="8.8" height="6.4" x="7.6" y="10.4" rx="1.4" />
        <path d="M6.6 13.6h1" />
        <path d="M16.4 13.6h1" />
        <path d="M10.4 13v1.2" />
        <path d="M13.6 13v1.2" />
      </g>
    );
  }

  return (
    <g className="project-kind-icon-agent">
      <path d="M12 10.2V8.4H10" />
      <rect width="9.6" height="6.8" x="7.2" y="10.2" rx="1.5" />
      <path d="M6.2 13.8h1" />
      <path d="M16.8 13.8h1" />
      <path d="M10.2 13.1v1.2" />
      <path d="M13.8 13.1v1.2" />
    </g>
  );
}
