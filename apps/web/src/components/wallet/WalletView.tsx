import type { BootstrapPayload } from "@openpond/contracts";
import { Copy, CreditCard } from "../icons";
import { AccountStateBadge } from "../account/AccountBadges";
import { copyToClipboard } from "../../lib/clipboard";
import { TOKEN_ICON_URLS } from "../../lib/public-assets";

export function WalletView({
  payload,
}: {
  payload: BootstrapPayload | null;
}) {
  const account = payload?.account ?? null;
  const profile = account?.profile ?? null;
  const products = account?.products ?? [];
  const assetRows = account?.balance?.breakdown ?? [];
  const accountLabel =
    account?.state === "signed_in"
      ? (account?.label ?? account?.activeProfile?.handle ?? "OpenPond account")
      : "Not signed in";
  const operatingWalletAddress = profile?.turnkeyOperatingWalletAddress ?? null;
  const productSummary = products.length > 0 ? products.map((product) => product.name).join(", ") : "None";
  const walletRows = [
    { label: "Personal wallet", address: profile?.turnkeyWalletAddress ?? null },
    { label: "Operating wallet", address: operatingWalletAddress },
  ];
  const accountState = account?.state ?? "loading";
  const accountStateLabel = accountState === "signed_in" ? "active" : undefined;

  return (
    <section className="wallet-view" aria-label="Wallet">
      <div className="wallet-credit-card">
        <div className="wallet-card-top">
          <div className="wallet-card-brand">
            <CreditCard size={18} />
            <span>OpenPond</span>
          </div>
          <AccountStateBadge state={accountState} label={accountStateLabel} />
        </div>
        <div className="wallet-card-balance">
          <span>Balance</span>
          <strong>{account?.balanceLabel ?? "$0.00"}</strong>
          <WalletCardAddress address={operatingWalletAddress} />
        </div>
        <div className="wallet-card-bottom">
          <div>
            <span>Account</span>
            <strong>{accountLabel}</strong>
          </div>
          <div className="wallet-card-products">
            <span>Products</span>
            <strong title={productSummary}>{productSummary}</strong>
          </div>
        </div>
      </div>

      <div className="wallet-content-grid">
        <section className="wallet-panel">
          <div className="wallet-panel-header">
            <div>
              <span>Assets</span>
            </div>
          </div>
          <div className="wallet-asset-list">
            {assetRows.length > 0 ? (
              assetRows.map((asset) => <WalletAssetRow key={`${asset.wallet}-${asset.chain}-${asset.asset}`} asset={asset} />)
            ) : (
              <div className="wallet-asset-row empty">
                <div>
                  <strong>No assets found</strong>
                  <span>Refresh after funding the operating wallet.</span>
                </div>
              </div>
            )}
          </div>
        </section>

        <div className="wallet-side-stack">
          <section className="wallet-panel">
            <div className="wallet-panel-header">
              <div>
                <span>Wallets</span>
              </div>
            </div>
            <div className="wallet-address-list">
              {walletRows.map((wallet) => (
                <WalletAddressRow key={wallet.label} label={wallet.label} address={wallet.address} />
              ))}
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}

function WalletCardAddress({ address }: { address: string | null }) {
  const normalizedAddress = address?.trim() || null;
  return (
    <div className={`wallet-card-address ${normalizedAddress ? "" : "empty"}`}>
      <span>Operating wallet</span>
      <div>
        <code>{normalizedAddress ?? "Not available"}</code>
        <button
          type="button"
          className="wallet-copy-button ghost"
          title="Copy operating wallet"
          aria-label="Copy operating wallet"
          disabled={!normalizedAddress}
          onClick={() => {
            if (normalizedAddress) void copyToClipboard(normalizedAddress);
          }}
        >
          <Copy size={12} />
        </button>
      </div>
    </div>
  );
}

function WalletAddressRow({ label, address }: { label: string; address: string | null }) {
  const normalizedAddress = address?.trim() || null;
  return (
    <div className={`wallet-address-row ${normalizedAddress ? "" : "empty"}`}>
      <div>
        <span>{label}</span>
        <div className="wallet-address-line">
          <code>{normalizedAddress ?? "Not available"}</code>
          <button
            type="button"
            className="wallet-copy-button ghost"
            title={`Copy ${label}`}
            aria-label={`Copy ${label}`}
            disabled={!normalizedAddress}
            onClick={() => {
              if (normalizedAddress) void copyToClipboard(normalizedAddress);
            }}
          >
            <Copy size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}

type WalletAsset = NonNullable<NonNullable<BootstrapPayload["account"]["balance"]>["breakdown"]>[number];

function WalletAssetRow({ asset }: { asset: WalletAsset }) {
  const amountLabel = formatAssetAmount(asset.amount, asset.asset);
  const valueLabel = formatUsdValue(asset.usdValue);
  const iconSrc = tokenIconSrc(asset.asset);

  return (
    <div className="wallet-asset-row">
      <div className="wallet-asset-identity">
        {iconSrc ? <img src={iconSrc} alt="" /> : <span className="wallet-token-fallback">{asset.asset.slice(0, 1)}</span>}
        <strong>{asset.asset}</strong>
        <span>{asset.chain}</span>
      </div>
      <div className="wallet-asset-values">
        <strong>{amountLabel}</strong>
        <span>{valueLabel}</span>
      </div>
    </div>
  );
}

function tokenIconSrc(asset: string): string | null {
  switch (asset.trim().toUpperCase()) {
    case "ETH":
      return TOKEN_ICON_URLS.ETH;
    case "USDC":
      return TOKEN_ICON_URLS.USDC;
    default:
      return null;
  }
}

function formatAssetAmount(amount: string | null, asset: string): string {
  if (!amount) return `0 ${asset}`;
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return `${amount} ${asset}`;
  const formatted = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: numeric >= 1 ? 4 : 8,
  }).format(numeric);
  return `${formatted} ${asset}`;
}

function formatUsdValue(value: string | number | null): string {
  if (value === null) return "$0.00";
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numeric);
}
