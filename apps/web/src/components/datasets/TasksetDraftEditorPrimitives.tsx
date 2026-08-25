import { useEffect, useState, type ReactNode } from "react";

export function EditorSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="taskset-draft-section">
      <header>
        <div><h2>{title}</h2><p>{description}</p></div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="taskset-draft-field"><span>{label}</span>{children}</label>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="taskset-draft-empty">{children}</div>;
}

export function JsonObjectFileImport({
  disabled,
  label,
  onImport,
}: {
  disabled: boolean;
  label: string;
  onImport: (value: Record<string, unknown>) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="taskset-json-file-import-row">
      <label className="training-button secondary taskset-json-file-import">
        {label}
        <input
          accept="application/json,.json"
          disabled={disabled}
          type="file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            void file.text().then((text) => {
              const parsed: unknown = JSON.parse(text);
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("The selected JSON file must contain an object.");
              }
              onImport(parsed as Record<string, unknown>);
              setError(null);
            }).catch((caught) => {
              setError(caught instanceof Error ? caught.message : String(caught));
            }).finally(() => {
              event.target.value = "";
            });
          }}
        />
      </label>
      {error ? <small className="taskset-draft-json-error">{error}</small> : null}
    </span>
  );
}

export function JsonObjectField({
  label,
  value,
  disabled,
  nullable = false,
  onChange,
}: {
  label: string;
  value: Record<string, unknown> | null;
  disabled: boolean;
  nullable?: boolean;
  onChange: (value: Record<string, unknown> | null) => void;
}) {
  return (
    <JsonField
      disabled={disabled}
      label={label}
      value={value}
      onApply={(text) => {
        if (nullable && text.trim() === "null") return onChange(null);
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Enter a JSON object.");
        }
        onChange(parsed as Record<string, unknown>);
      }}
    />
  );
}

export function JsonArrayField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: unknown[];
  disabled: boolean;
  onChange: (value: unknown[]) => void;
}) {
  return (
    <JsonField
      disabled={disabled}
      label={label}
      value={value}
      onApply={(text) => {
        const parsed: unknown = JSON.parse(text);
        if (!Array.isArray(parsed)) throw new Error("Enter a JSON array.");
        onChange(parsed);
      }}
    />
  );
}

function JsonField({
  label,
  value,
  disabled,
  onApply,
}: {
  label: string;
  value: unknown;
  disabled: boolean;
  onApply: (text: string) => void;
}) {
  const serialized = JSON.stringify(value, null, 2);
  const [text, setText] = useState(serialized);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(serialized), [serialized]);
  return (
    <Field label={label}>
      <textarea disabled={disabled} rows={7} value={text} onChange={(event) => setText(event.target.value)} />
      <span className="taskset-draft-json-actions">
        {error ? <small className="taskset-draft-json-error">{error}</small> : <small>JSON is applied explicitly.</small>}
        <button
          className="training-text-button"
          disabled={disabled || text === serialized}
          type="button"
          onClick={() => {
            try {
              onApply(text);
              setError(null);
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : String(caught));
            }
          }}
        >
          Apply JSON
        </button>
      </span>
    </Field>
  );
}
