import type { ReactNode } from "react";
import { useErrorToast } from "../../app/AppToastContext";

/** Notify through the shell while keeping recovery controls in their original view. */
export function ErrorToast({ error, prefix, children }: {
  error: unknown;
  prefix?: string;
  children?: ReactNode;
}) {
  useErrorToast(error, { prefix });
  return error ? children ?? null : null;
}
