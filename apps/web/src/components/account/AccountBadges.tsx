export function AccountAvatar({ handle, image }: { handle: string | null | undefined; image: string | null | undefined }) {
  const initial = handle?.trim().slice(0, 1).toUpperCase() || "+";
  return (
    <div className="account-avatar">
      {image ? <img src={image} alt="" /> : <span>{initial}</span>}
    </div>
  );
}

export function AccountStateBadge({ state, label }: { state: string; label?: string }) {
  return <span className={`account-state ${state}`}>{label ?? state.replace("_", " ")}</span>;
}
