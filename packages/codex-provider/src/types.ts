export type JsonRpcId = string | number;

export type CodexNotification = {
  method: string;
  params?: unknown;
};

export type CodexServerRequest = {
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type CodexServerRequestResult =
  | { result: unknown }
  | { error: { code: number; message: string; data?: unknown } };

export type CodexClientOptions = {
  binaryPath?: string;
  clientName?: string;
  clientTitle?: string;
  clientVersion?: string;
  onNotification?: (notification: CodexNotification) => void;
  onServerRequest?: (request: CodexServerRequest) => Promise<CodexServerRequestResult>;
  stderr?: (chunk: string) => void;
};

export type CodexProbeStatus = {
  available: boolean;
  binaryPath: string | null;
  version: string | null;
  authHealth: "unknown" | "signed_in" | "signed_out" | "auth_error";
  account: CodexAccountStatus | null;
  error: string | null;
};

export type CodexAccountStatus = {
  type: string;
  email: string | null;
  planType: string | null;
  label: string | null;
};

export type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  method: string;
};

export type TurnWaiter = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};
