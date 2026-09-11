import { z } from "zod";

const ExpectedFixtureScoreSchema = z.number().finite().min(0).max(1).nullable().optional();

/** Authored expectations never replace the score produced by the grader. */
export function parseExpectedFixtureScore(value: unknown): number | null | undefined {
  return ExpectedFixtureScoreSchema.parse(value);
}

export function fixtureScoreMatches(expected: number | null | undefined, actual: number | null): boolean {
  return expected === undefined || expected === actual ||
    (typeof expected === "number" && actual !== null && Math.abs(expected - actual) <= 1e-12);
}
