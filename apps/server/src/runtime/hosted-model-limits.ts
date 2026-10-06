/** The embedding host supplies catalog limits for its exact admitted model.
 * These are runtime bounds, never client model preferences or spend authority.
 */
export function admittedHostedModelLimits(input: {
  provider: string;
  model: string;
  environment?: NodeJS.ProcessEnv;
}): { contextWindow: number | null; outputLimit: number | null } | null {
  const environment = input.environment ?? process.env;
  if (
    input.provider !== "openpond" ||
    input.model !== environment.OPENPOND_HOSTED_MODEL_ID?.trim()
  ) return null;
  const context = environment.OPENPOND_HOSTED_MODEL_CONTEXT_WINDOW;
  const output = environment.OPENPOND_HOSTED_MODEL_OUTPUT_LIMIT;
  if (context === undefined && output === undefined) return null;
  const parse = (value: string | undefined): number | null => {
    if (value === undefined) return null;
    const limit = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("Hosted admitted model limit is invalid.");
    }
    return limit;
  };
  return { contextWindow: parse(context), outputLimit: parse(output) };
}
