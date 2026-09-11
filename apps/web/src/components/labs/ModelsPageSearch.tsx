export function ModelsPageSearch({ value, onSearch, label }: { value: string; onSearch: (value: string) => void; label: string }) {
  return <form role="search" className="models-page-search" onSubmit={event => { event.preventDefault(); onSearch(String(new FormData(event.currentTarget).get("query") ?? "").trim()); }}>
    <input key={value} name="query" type="search" aria-label={label} placeholder={label} defaultValue={value} maxLength={1_000} onChange={event => { if (!event.target.value) onSearch(""); }} />
  </form>;
}
