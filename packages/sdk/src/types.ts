export type OpenPondClientOptions = {
  /** OpenPond server API key. Keep this value on the server. */
  apiKey?: string;
  /** Omit for hosted OpenPond. An explicit endpoint uses its own runtime key. */
  sandbox?: {
    endpoint: string;
    apiKey: string;
    resources?: { cpu?: number; memoryGb?: number; diskGb?: number };
  };
  /** OpenAI-compatible Chat Completions base URL, independent of sandbox auth. */
  model?: { endpoint: string; apiKey: string; model: string };
  /** API origin, such as https://api.openpond.ai. */
  baseUrl?: string;
  /** Optional full sandbox API URL. Overrides the URL derived from baseUrl. */
  sandboxApiUrl?: string;
  /** Optional OpChat API base ending in /opchat/v1. */
  chatApiUrl?: string;
};
