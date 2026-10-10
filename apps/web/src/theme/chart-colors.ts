export const CHART_COLORS = Array.from({ length: 10 }, (_, index) => `var(--chart-${index + 1})`);

export function chartColor(index: number): string {
  if (index < CHART_COLORS.length) return CHART_COLORS[index]!;
  const hue = Math.round((205 + (index - CHART_COLORS.length) * 137.508) % 360);
  return `hsl(${hue} var(--chart-saturation) var(--chart-lightness))`;
}
