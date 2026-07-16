export type OpenPondSqliteParameter =
  | null
  | number
  | bigint
  | string
  | NodeJS.ArrayBufferView;

export interface OpenPondSqliteConnection {
  exec(sql: string): void;
  run(sql: string, params?: readonly unknown[]): void;
  all<T>(sql: string, params?: readonly unknown[]): T[];
  get<T>(sql: string, params?: readonly unknown[]): T | null;
  close(): void;
}

export type SupportedNodeRuntime = {
  major: number;
  minor: number;
  patch: number;
};

export function assertSupportedNodeSqliteRuntime(
  version = process.versions.node,
): SupportedNodeRuntime {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  const runtime = match
    ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
    : null;
  if (
    !runtime
    || runtime.major !== 24
    || runtime.minor < 18
  ) {
    throw new Error(
      `OpenPond requires Node.js 24.18.0 or newer within the Node 24 release line; received ${version}.`,
    );
  }
  return runtime;
}
