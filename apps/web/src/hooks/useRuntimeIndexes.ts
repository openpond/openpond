import { useMemo, useRef } from "react";
import type { Approval, RuntimeEvent } from "@openpond/contracts";
import {
  buildRuntimeIndexesWithReuse,
  type RuntimeIndexes,
  type RuntimeIndexReuseState,
} from "../lib/runtime-indexes";

export function useRuntimeIndexes(events: RuntimeEvent[], approvals: Approval[]): RuntimeIndexes {
  const previousRef = useRef<RuntimeIndexReuseState | null>(null);
  return useMemo(() => {
    const indexes = buildRuntimeIndexesWithReuse(events, approvals, previousRef.current);
    previousRef.current = { events, indexes };
    return indexes;
  }, [approvals, events]);
}
