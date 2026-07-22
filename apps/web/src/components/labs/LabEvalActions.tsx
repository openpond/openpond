import { useEffect, useMemo, useState } from "react";
import type { OpenPondProfileEval } from "@openpond/contracts";

import { DropdownSelect } from "../DropdownSelect";
import { Plus } from "../icons";

export function LabAgentEvalActions({
  agentId,
  evals,
  onAttach,
  onCreate,
}: {
  agentId: string;
  evals: OpenPondProfileEval[];
  onAttach: (evalRef: string) => void;
  onCreate: () => void;
}) {
  const available = useMemo(
    () => evals.filter((item) => item.agentId === null || item.agentId === agentId),
    [agentId, evals],
  );
  const [selectedEvalRef, setSelectedEvalRef] = useState(available[0]?.id ?? "");

  useEffect(() => {
    if (available.some((item) => item.id === selectedEvalRef)) return;
    setSelectedEvalRef(available[0]?.id ?? "");
  }, [available, selectedEvalRef]);

  return (
    <div className="labs-eval-actions">
      <button className="training-button secondary" type="button" onClick={onCreate}>
        <Plus size={13} />
        Create Eval
      </button>
      {available.length ? (
        <>
          <DropdownSelect
            compact
            searchable
            label="Existing Eval"
            options={available.map((item) => ({
              value: item.id,
              label: item.name,
              shortLabel: item.name,
              description: item.path,
            }))}
            value={selectedEvalRef}
            onChange={setSelectedEvalRef}
          />
          <button
            className="training-button secondary"
            disabled={!selectedEvalRef}
            type="button"
            onClick={() => onAttach(selectedEvalRef)}
          >
            Add Eval
          </button>
        </>
      ) : null}
    </div>
  );
}
