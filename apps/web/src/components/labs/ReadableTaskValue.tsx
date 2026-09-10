export function ReadableTaskValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span>Not provided</span>;
  if (typeof value !== "object") return <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{String(value)}</span>;
  if (Array.isArray(value)) return value.length ? <ul>{value.map((entry, index) => <li key={index}><ReadableTaskValue value={entry} /></li>)}</ul> : <span>None</span>;
  const entries = Object.entries(value);
  return entries.length ? <dl className="training-configuration-list">{entries.map(([key, entry]) => <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd><ReadableTaskValue value={entry} /></dd></div>)}</dl> : <span>None</span>;
}
