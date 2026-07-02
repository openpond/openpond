import { useEffect, useMemo, useRef, useState } from "react";
import { Settings, UserRound } from "../icons";
import type { AccountState } from "@openpond/contracts";

type UserAuthFooterProps = {
  account: AccountState | null;
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

export function UserAuthFooter({ account, onOpenSettings }: UserAuthFooterProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const identity = useMemo(() => userAuthIdentity(account), [account]);
  const initial = identity.label.trim().slice(0, 1).toUpperCase();

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
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
        onClick={() => setOpen((current) => !current)}
      >
        <span className="user-auth-avatar" aria-hidden="true">
          {identity.image ? <img src={identity.image} alt="" /> : initial ? <span>{initial}</span> : <UserRound size={16} />}
        </span>
        <span className="user-auth-name">{identity.label}</span>
      </button>

      {open ? (
        <div className="user-auth-menu" role="menu" aria-label="Account">
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
