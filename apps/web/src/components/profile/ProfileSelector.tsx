import type {
  BootstrapPayload,
  OpenPondProfileCatalogEntry,
} from "@openpond/contracts";
import type { ReactNode } from "react";
import {
  openPondProfileRefFromKey,
  openPondProfileRefKey,
  openPondProfileRefsEqual,
} from "../../lib/profile-selection";
import { ChevronDown } from "../icons";

export function ProfileSelector({
  actions,
  busy,
  library,
  onSelect,
}: {
  actions: ReactNode;
  busy: boolean;
  library: BootstrapPayload["profileLibrary"];
  onSelect: (entry: OpenPondProfileCatalogEntry) => void;
}) {
  const selectedEntry = library.profiles.find((entry) =>
    openPondProfileRefsEqual(entry.ref, library.lastUsed)
  ) ?? library.profiles[0] ?? null;
  const selectedValue = selectedEntry
    ? openPondProfileRefKey(selectedEntry.ref)
    : "";

  return (
    <div className="profile-selector-bar">
      <label className="profile-selector-control">
        <select
          aria-label="Active profile"
          disabled={busy || library.profiles.length === 0}
          value={selectedValue}
          onChange={(event) => {
            const ref = openPondProfileRefFromKey(
              library,
              event.currentTarget.value,
            );
            const entry = library.profiles.find((candidate) =>
              openPondProfileRefsEqual(candidate.ref, ref)
            );
            if (entry) onSelect(entry);
          }}
        >
          {library.profiles.length ? library.profiles.map((entry) => (
            <option
              key={openPondProfileRefKey(entry.ref)}
              value={openPondProfileRefKey(entry.ref)}
            >
              {entry.name}
            </option>
          )) : (
            <option value="">No profiles</option>
          )}
        </select>
        <ChevronDown aria-hidden="true" size={14} />
      </label>
      {actions}
    </div>
  );
}
