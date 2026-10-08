import { LearnedPreferenceRewardBindingSchema } from "@openpond/contracts";

/**
 * V2 learned scorers are reusable only when their Sandbox execution receipt is
 * present. Older local rows may contain a qualification label but no execution
 * receipt. Those bindings cannot be upgraded truthfully, so the one-way schema
 * migration unbinds them and leaves the immutable Reward Model history intact.
 */
export function sanitizeUnverifiableLearnedPreferenceBindings(
  value: unknown,
): { value: unknown; changed: boolean; } {
  if (Array.isArray(value)) {
    let changed = false;
    const entries = value.map((entry) => {
      const normalized = sanitizeUnverifiableLearnedPreferenceBindings(entry);
      changed ||= normalized.changed;
      return normalized.value;
    });
    return { value: changed ? entries : value, changed };
  }
  if (!isRecord(value)) return { value, changed: false };

  let changed = false;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "learnedPreference" && entry !== null) {
      const candidate = isRecord(entry)
        ? Object.fromEntries(
          Object.entries(entry).filter(([name]) => name !== "qualificationKind"),
        )
        : entry;
      const parsed = LearnedPreferenceRewardBindingSchema.safeParse(candidate);
      output[key] = parsed.success ? parsed.data : null;
      changed ||= !parsed.success || candidate !== entry;
      continue;
    }
    const normalized = sanitizeUnverifiableLearnedPreferenceBindings(entry);
    output[key] = normalized.value;
    changed ||= normalized.changed;
  }
  return { value: changed ? output : value, changed };
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
