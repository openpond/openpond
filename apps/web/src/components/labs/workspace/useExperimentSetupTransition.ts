import { useEffect, useRef } from "react";
import type { useDraftNavigation } from "../useDraftNavigation";
import { useEvaluationSetup } from "./EvaluationSetupState";

/** Dataset entry uses the active form's existing discard/recovery decision. */
export function useExperimentSetupTransition(guard: ReturnType<typeof useDraftNavigation>, active: boolean) {
  const { registerTransitionGuard } = useEvaluationSetup();
  const current = useRef(guard);
  current.current = guard;
  useEffect(() => active
    ? registerTransitionGuard(action => current.current.requestLeave(action))
    : undefined, [active, registerTransitionGuard]);
}
