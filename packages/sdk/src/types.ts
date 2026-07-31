export type OpenPondClientOptions = {
  /** OpenPond server API key. Keep this value on the server. */
  apiKey: string;
  /** API origin, such as https://api.openpond.ai or the staging API origin. */
  baseUrl?: string;
  /** Optional full sandbox API URL. Overrides the URL derived from baseUrl. */
  sandboxApiUrl?: string;
  /** Optional OpChat API base ending in /opchat/v1. */
  chatApiUrl?: string;
};
