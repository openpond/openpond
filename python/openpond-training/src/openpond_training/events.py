from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TextIO


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass
class EventWriter:
    job_id: str
    output: TextIO
    event_file: Path
    sequence: int = 0

    def emit(self, event_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        event = {
            "schemaVersion": "openpond.trainingJobEvent.v1",
            "id": f"{self.job_id}_event_{self.sequence}",
            "jobId": self.job_id,
            "sequence": self.sequence,
            "type": event_type,
            "timestamp": utc_now(),
            "payload": payload or {},
        }
        self.sequence += 1
        line = json.dumps(event, sort_keys=True)
        self.output.write(line + "\n")
        self.output.flush()
        self.event_file.parent.mkdir(parents=True, exist_ok=True)
        with self.event_file.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
        return event
