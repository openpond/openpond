import { useEffect, useMemo, useRef, useState } from "react";
import { Boxes, ChartColumnStacked, Check, ChevronRight, Settings, UserRound } from "../icons";
import type { AccountState, AccountWorkspace } from "@openpond/contracts";

type UserAuthFooterProps = {
  account: AccountState | null;
  onOpenActivity?: () => void;
  onSelectWorkspace: (input: {
    workspaceId: string;
    workspaceType: "personal" | "team";
  }) => Promise<void>;
  onOpenSettings: () => void;
};

type UserAuthIdentity = {
  label: string;
  image: string | null;
};

function firstPresentText(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export function userAuthIdentity(account: AccountState | null): UserAuthIdentity {
  const activeAccount = account?.accounts.find((candidate) => candidate.isActive) ?? null;
  const profile = account?.profile ?? null;
  const activeHandle = account?.activeProfile?.handle ?? null;
  const signedIn = account?.state === "signed_in";
  const label = signedIn
    ? firstPresentText(
        account?.label,
        profile?.handle,
        profile?.name,
        profile?.email,
        activeAccount?.displayLabel,
        activeAccount?.handle,
        activeHandle,
        account?.email,
        "Signed in",
      )
    : account?.state === "loading" || account?.state === "switching"
      ? "Loading account"
      : "Sign in";

  return {
    label: label ?? "Account",
    image: account?.avatarUrl ?? profile?.image ?? activeAccount?.avatarUrl ?? null,
  };
}

function accountWorkspaces(account: AccountState | null): AccountWorkspace[] {
  if (!account?.workspaces) return [];
  return [account.workspaces.personal, account.workspaces.team].filter(
    (workspace): workspace is AccountWorkspace => Boolean(workspace)
  );
}

export function UserAuthFooter({
  account,
  onOpenActivity,
  onSelectWorkspace,
  onOpenSettings,
}: UserAuthFooterProps) {
  const [open, setOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const identity = useMemo(() => userAuthIdentity(account), [account]);
  const workspaces = useMemo(() => accountWorkspaces(account), [account]);
  const activeWorkspace = account?.workspaces?.activeWorkspace ?? null;
  const teamWorkspace = account?.workspaces?.team ?? null;
  const activeTeam = teamWorkspace?.id === activeWorkspace?.id ? teamWorkspace : null;
  const initial = identity.label.trim().slice(0, 1).toUpperCase();

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setWorkspaceOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        setWorkspaceOpen(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="user-auth-footer" ref={menuRef}>
      <button
        type="button"
        className={`user-auth-trigger ${open ? "active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${identity.label} account menu`}
        onClick={() => {
          setOpen((current) => !current);
          setWorkspaceOpen(false);
        }}
      >
        <span className="user-auth-avatar" aria-hidden="true">
          {identity.image ? <img src={identity.image} alt="" /> : initial ? <span>{initial}</span> : <UserRound size={16} />}
        </span>
        <span className="user-auth-identity">
          <span className="user-auth-name">{identity.label}</span>
          {activeTeam ? <span className="user-auth-team-badge">{activeTeam.displayName}</span> : null}
        </span>
      </button>

      {open ? (
        <div className="user-auth-menu" role="menu" aria-label="Account">
          {onOpenActivity ? (
            <a
              href="/settings/usage"
              className="user-auth-menu-link"
              role="menuitem"
              onClick={(event) => {
                event.preventDefault();
                setOpen(false);
                onOpenActivity();
              }}
            >
              <ChartColumnStacked size={15} />
              <span>Activity</span>
            </a>
          ) : null}
          {workspaces.length > 0 ? (
            <div
              className="user-auth-workspace-row"
              onPointerEnter={() => setWorkspaceOpen(true)}
              onPointerLeave={() => setWorkspaceOpen(false)}
            >
              <button
                type="button"
                className="user-auth-menu-link"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={workspaceOpen}
                onClick={() => setWorkspaceOpen((current) => !current)}
              >
                <Boxes size={15} />
                <span>Workspace</span>
                <ChevronRight className="user-auth-menu-chevron" size={14} />
              </button>
              {workspaceOpen ? (
                <div className="user-auth-workspace-menu" role="menu" aria-label="Workspace">
                  {workspaces.map((workspace) => {
                    const selected = workspace.id === activeWorkspace?.id;
                    return (
                      <button
                        type="button"
                        className="user-auth-menu-link"
                        role="menuitemradio"
                        aria-checked={selected}
                        disabled={workspaceBusy}
                        key={workspace.id}
                        onClick={() => {
                          if (selected || workspaceBusy) return;
                          setWorkspaceBusy(true);
                          void onSelectWorkspace({
                            workspaceId: workspace.id,
                            workspaceType: workspace.type,
                          }).then(
                            () => {
                              setOpen(false);
                              setWorkspaceOpen(false);
                              setWorkspaceBusy(false);
                            },
                            () => setWorkspaceBusy(false)
                          );
                        }}
                      >
                        <span>{workspace.displayName}</span>
                        {selected ? <Check className="user-auth-workspace-check" size={14} /> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
          <a
            href="/settings"
            className="user-auth-menu-link"
            role="menuitem"
            onClick={(event) => {
              event.preventDefault();
              setOpen(false);
              onOpenSettings();
            }}
          >
            <Settings size={15} />
            <span>Settings</span>
          </a>
        </div>
      ) : null}
    </div>
  );
}
