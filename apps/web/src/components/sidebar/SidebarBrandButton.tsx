export function SidebarBrandButton({ onOpenHome }: { onOpenHome: () => void }) {
  return (
    <button
      type="button"
      className="sidebar-wordmark-button"
      aria-label="OpenPond home"
      onClick={onOpenHome}
    >
      <img className="sidebar-wordmark" src="/openpond-wordlogo-white.png" alt="" />
    </button>
  );
}
