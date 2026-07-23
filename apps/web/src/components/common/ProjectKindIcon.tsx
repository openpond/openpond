import type { SidebarProjectKind } from "../../lib/app-models";

type ProjectKindIconProps = {
  kind: SidebarProjectKind;
  linkedCloud?: boolean;
  open?: boolean;
  className?: string;
  baseSize?: number;
};

export function ProjectKindIcon({
  kind,
  linkedCloud = false,
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
        linkedCloud ? "linked-cloud" : "",
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
        {linkedCloud && kind === "local" ? <LinkedCloudBadge /> : null}
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

function LinkedCloudBadge() {
  return (
    <g className="project-kind-icon-cloud-badge">
      <circle cx="18" cy="17" r="5" />
      <path d="M20.4 18.6h-4.2a2.2 2.2 0 1 1 2.08-2.9h.88a1.45 1.45 0 1 1 1.24 2.9Z" />
    </g>
  );
}
