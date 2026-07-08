import type { ReactNode } from "react";
import { ArrowUpRight, CheckCircle2, CircleDashed, FileText, GitBranch, Workflow, XCircle } from "../icons";
import type { ActionRunRef, ActionRunSummary } from "../../lib/app-models";
import { isGenericChatLabel, shortProfileAgentLabel } from "../../lib/profile-agent-labels";
import { normalizeChatFilePath } from "../../lib/chat-file-links";

export function ActionRunCard({
  actionRun,
  onOpenBrowserLink,
  onOpenFileInSidebar,
  workspaceRootPath = null,
}: {
  actionRun: ActionRunSummary;
  onOpenBrowserLink?: (href: string, options?: { explicitFile?: boolean; newTab?: boolean }) => void;
  onOpenFileInSidebar?: (path: string) => void;
  workspaceRootPath?: string | null;
}) {
  const StatusIcon = actionRunStatusIcon(actionRun.status);
  const meta = actionRunMeta(actionRun);
  return (
    <div className={`action-run-card ${actionRun.status}`}>
      <div className="action-run-header">
        <span className="action-run-status" title={actionRun.status}>
          <StatusIcon size={15} />
        </span>
        <div className="action-run-title">
          <strong>{actionRun.title}</strong>
          <span>{actionRun.actionName}</span>
        </div>
      </div>
      {meta.length > 0 && (
        <div className="action-run-meta" aria-label="Action run metadata">
          {meta.map((item) => (
            <span className="action-run-chip" key={item.label}>
              {item.icon}
              <span>{item.label}</span>
              <code>{item.value}</code>
            </span>
          ))}
        </div>
      )}
      {actionRun.responseText && (
        <p className="action-run-response">{actionRun.responseText}</p>
      )}
      {actionRun.refs.length > 0 && (
        <div className="action-run-ref-list" aria-label="Action run references">
          {actionRun.refs.slice(0, 8).map((ref) => (
            <ActionRunRefRow
              key={ref.id}
              refItem={ref}
              onOpenBrowserLink={onOpenBrowserLink}
              onOpenFileInSidebar={onOpenFileInSidebar}
              workspaceRootPath={workspaceRootPath}
            />
          ))}
        </div>
      )}
      {actionRun.childCalls.length > 0 && (
        <div className="action-run-child-list" aria-label="Child implementation calls">
          {actionRun.childCalls.map((call) => (
            <div className={`action-run-child ${call.status}`} key={call.id}>
              <span>{call.label}</span>
              <small>{call.status}</small>
              {call.detail && <code>{call.detail}</code>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function isProfileActionRun(actionRun: ActionRunSummary): boolean {
  return actionRun.implementationType === "openpond-profile-action";
}

export function profileActionAgentLabel(actionRun: ActionRunSummary): string {
  const agentName = actionRun.agentName ?? actionRun.agentId;
  if (actionRun.actionName.endsWith(".chat")) {
    return shortProfileAgentLabel({
      actionId: actionRun.actionName,
      label: actionRun.title,
      name: agentName,
    });
  }
  if (agentName) {
    return shortProfileAgentLabel({ actionId: actionRun.actionName, name: agentName });
  }
  if (actionRun.title && !isGenericChatLabel(actionRun.title)) {
    return shortProfileAgentLabel({ actionId: actionRun.actionName, label: actionRun.title });
  }
  return shortProfileAgentLabel({ actionId: actionRun.actionName });
}

export function profileActionFallbackText(actionRun: ActionRunSummary): string {
  if (actionRun.status === "failed") return `${actionRun.title} failed.`;
  if (actionRun.status === "completed") return `${actionRun.title} completed.`;
  if (actionRun.status === "pending") return `${actionRun.title} is pending.`;
  return `${actionRun.title} is running...`;
}

function ActionRunRefRow({
  refItem,
  onOpenBrowserLink,
  onOpenFileInSidebar,
  workspaceRootPath,
}: {
  refItem: ActionRunRef;
  onOpenBrowserLink?: (href: string, options?: { explicitFile?: boolean; newTab?: boolean }) => void;
  onOpenFileInSidebar?: (path: string) => void;
  workspaceRootPath?: string | null;
}) {
  const normalizedFile = onOpenFileInSidebar
    ? normalizeChatFilePath(refItem.target, { workspaceRootPath })
    : null;
  const canOpenBrowser = isHttpUrl(refItem.target) && onOpenBrowserLink;
  const canOpenFile = Boolean(normalizedFile && onOpenFileInSidebar);
  return (
    <div className={`action-run-ref ${refItem.kind}`}>
      <span>{refItem.label}</span>
      <code>{refItem.target}</code>
      {canOpenBrowser && (
        <button
          type="button"
          title={`Open ${refItem.target}`}
          aria-label={`Open ${refItem.label}`}
          onClick={() => onOpenBrowserLink(refItem.target, { newTab: true })}
        >
          <ArrowUpRight size={13} />
        </button>
      )}
      {canOpenFile && (
        <button
          type="button"
          title={`Open ${refItem.target}`}
          aria-label={`Open ${refItem.label}`}
          onClick={() => {
            if (normalizedFile && onOpenFileInSidebar) onOpenFileInSidebar(normalizedFile.path);
          }}
        >
          <ArrowUpRight size={13} />
        </button>
      )}
    </div>
  );
}

function actionRunStatusIcon(status: ActionRunSummary["status"]) {
  if (status === "completed") return CheckCircle2;
  if (status === "failed") return XCircle;
  return CircleDashed;
}

function actionRunMeta(actionRun: ActionRunSummary): Array<{
  label: string;
  value: string;
  icon: ReactNode;
}> {
  const items: Array<{ label: string; value: string; icon: ReactNode }> = [];
  if (actionRun.implementationType) {
    items.push({
      label: "Type",
      value: actionRun.implementationType,
      icon: <Workflow size={12} />,
    });
  }
  if (actionRun.runId) {
    items.push({ label: "Run", value: actionRun.runId, icon: <FileText size={12} /> });
  }
  if (actionRun.sandboxId) {
    items.push({ label: "Sandbox", value: actionRun.sandboxId, icon: <FileText size={12} /> });
  }
  if (actionRun.sourceRef) {
    items.push({ label: "Source", value: actionRun.sourceRef, icon: <GitBranch size={12} /> });
  }
  if (actionRun.manifestHash) {
    items.push({ label: "Manifest", value: actionRun.manifestHash, icon: <FileText size={12} /> });
  }
  return items;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
