export type AnalyticsSummary = {
  businessId: string;
  activeMoves: number;
  bookedRevenueUsd: number;
};

const summaries: Record<string, AnalyticsSummary> = {
  relocation: {
    businessId: "relocation",
    activeMoves: 42,
    bookedRevenueUsd: 128_500,
  },
};

export function getAnalyticsSummary(businessId: string): AnalyticsSummary {
  return summaries[businessId] ?? {
    businessId,
    activeMoves: 0,
    bookedRevenueUsd: 0,
  };
}
