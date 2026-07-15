import { OPENPOND_WORDMARK_WHITE_URL } from "../../lib/public-assets";

export function SidebarBrandButton({ onOpenHome }: { onOpenHome: () => void }) {
  return (
    <button
      type="button"
      className="sidebar-wordmark-button"
      aria-label="OpenPond home"
      onClick={onOpenHome}
    >
      <img className="sidebar-wordmark" src={OPENPOND_WORDMARK_WHITE_URL} alt="" />
    </button>
  );
}
