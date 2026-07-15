const PUBLIC_ASSET_PREFIX = "./";

export function publicAssetUrl(path: string): string {
  return `${PUBLIC_ASSET_PREFIX}${path.replace(/^\.?\//, "")}`;
}

export const OPENPOND_ICON_URL = publicAssetUrl("openpond-icon.png");
export const OPENPOND_WORDMARK_WHITE_URL = publicAssetUrl("openpond-wordlogo-white.png");

const CONNECTED_APP_ICON_URLS = {
  github: publicAssetUrl("connected-apps/github.svg"),
  google: publicAssetUrl("connected-apps/google.svg"),
  microsoft_teams: publicAssetUrl("connected-apps/microsoft.svg"),
  mcp: publicAssetUrl("connected-apps/openpond-mcp.svg"),
  slack: publicAssetUrl("connected-apps/slack.svg"),
  x: publicAssetUrl("connected-apps/x.svg"),
} as const;

export function connectedAppIconUrl(appId: string): string {
  return CONNECTED_APP_ICON_URLS[appId as keyof typeof CONNECTED_APP_ICON_URLS]
    ?? CONNECTED_APP_ICON_URLS.mcp;
}

export const TOKEN_ICON_URLS = {
  ETH: publicAssetUrl("tokens/eth.svg"),
  USDC: publicAssetUrl("tokens/usdc.svg"),
} as const;
