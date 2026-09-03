import { useEffect, useMemo, useRef, useState } from "react";
import { ChartColumnStacked, Power, Settings, Shapes, UserRound } from "../icons";
import type { AccountState } from "@openpond/contracts";
import type { OpenPondOrganization } from "../../lib/organization-types";

type UserAuthFooterProps = {
  account: AccountState | null;
  open: boolean;
  organizations: readonly OpenPondOrganization[];
  selectedTeamId: string | null;
  onOpenChange: (open: boolean) => void;
  onOpenActivity?: () => void;
  onOpenSettings: () => void;
  onSelectTeam?: (teamId: string) => Promise<void>;
  onLogOut?: () => Promise<void>;
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

export function UserAuthFooter({
  account,
  open,
  organizations,
  selectedTeamId,
  onOpenActivity,
  onOpenChange,
  onOpenSettings,
  onSelectTeam,
  onLogOut,
}: UserAuthFooterProps) {
  const [switchingTeamId, setSwitchingTeamId] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const identity = useMemo(() => userAuthIdentity(account), [account]);
  const initial = identity.label.trim().slice(0, 1).toUpperCase();
  const activeOrganization =
    organizations.find((organization) => organization.teamId === selectedTeamId) ??
    organizations[0] ??
    null;
  const planLabel = accountPlanLabel(account, activeOrganization);
  const teamPlanLabel = [activeOrganization?.displayName, planLabel]
    .filter(Boolean)
    .join(" · ");

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) onOpenChange(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onOpenChange(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onOpenChange, open]);

  return (
    <div className="user-auth-footer" ref={menuRef}>
      <button
        type="button"
        className={`user-auth-trigger ${open ? "active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${identity.label} account menu`}
        onClick={() => onOpenChange(!open)}
      >
        <span className="user-auth-avatar" aria-hidden="true">
          {identity.image ? <img src={identity.image} alt="" /> : initial ? <span>{initial}</span> : <UserRound size={16} />}
        </span>
        <span className="user-auth-name">{identity.label}</span>
      </button>

      {open ? (
        <div className="user-auth-menu" role="menu" aria-label="Account">
          <div className="user-auth-menu-header">
            <span className="user-auth-menu-avatar" aria-hidden="true">
              {identity.image ? (
                <img src={identity.image} alt="" />
              ) : initial ? (
                <span>{initial}</span>
              ) : (
                <UserRound size={17} />
              )}
            </span>
            <span className="user-auth-menu-identity">
              <strong>{identity.label}</strong>
              <span>{teamPlanLabel || "Personal workspace"}</span>
            </span>
          </div>
          {organizations.length > 0 && onSelectTeam ? (
            <label className="user-auth-team-picker">
              <Shapes size={15} aria-hidden="true" />
              <span className="user-auth-team-picker-label">Team</span>
              <select
                aria-label="Active team"
                disabled={switchingTeamId !== null}
                value={activeOrganization?.teamId ?? ""}
                onChange={async (event) => {
                  const teamId = event.currentTarget.value;
                  setSwitchingTeamId(teamId);
                  try {
                    await onSelectTeam(teamId);
                  } catch {
                    // The app-level handler reports the failure without closing the menu.
                  } finally {
                    setSwitchingTeamId(null);
                  }
                }}
              >
                {organizations.map((organization) => (
                  <option key={organization.teamId} value={organization.teamId}>
                    {organization.displayName}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="user-auth-menu-divider" />
          {onOpenActivity ? (
            <button
              type="button"
              className="user-auth-menu-link"
              role="menuitem"
              onClick={() => {
                onOpenChange(false);
                onOpenActivity();
              }}
            >
              <ChartColumnStacked size={15} />
              <span>Activity</span>
            </button>
          ) : null}
          <button
            type="button"
            className="user-auth-menu-link"
            role="menuitem"
            onClick={() => {
              onOpenChange(false);
              onOpenSettings();
            }}
          >
            <Settings size={15} />
            <span>Settings</span>
          </button>
          {account?.state === "signed_in" && onLogOut ? (
            <button
              type="button"
              className="user-auth-menu-link"
              role="menuitem"
              disabled={loggingOut}
              onClick={async () => {
                setLoggingOut(true);
                try {
                  await onLogOut();
                  onOpenChange(false);
                } catch {
                  // The app-level handler reports the failure and keeps the menu open.
                } finally {
                  setLoggingOut(false);
                }
              }}
            >
              <Power size={15} />
              <span>{loggingOut ? "Logging out…" : "Log out"}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function accountPlanLabel(
  account: AccountState | null,
  organization: OpenPondOrganization | null,
): string | null {
  const plan = organization?.planKey?.trim();
  if (plan) return titleCasePlan(plan);
  const product = account?.products.find(
    (candidate) => candidate.isActive !== false && candidate.status !== "inactive",
  );
  return firstPresentText(product?.name, product?.type);
}

function titleCasePlan(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
