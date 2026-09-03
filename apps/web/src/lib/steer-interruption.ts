export const STEER_INTERRUPTION_REASON = "Steered by user";

export function isSteerInterruptionReason(
  reason: string | null | undefined,
): boolean {
  return reason?.trim().toLowerCase() === STEER_INTERRUPTION_REASON.toLowerCase();
}
