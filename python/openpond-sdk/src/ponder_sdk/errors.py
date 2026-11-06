"""Safe public errors: remote bodies, credentials and transport URLs stay private."""
from __future__ import annotations

class PonderError(Exception):
    def __init__(self, code: str, *, status: int | None = None, outcome_unknown: bool = False, operation_id: str | None = None):
        self.code = code
        self.status = status
        self.outcome_unknown = outcome_unknown
        self.operation_id = operation_id
        super().__init__(f"OpenPond request failed ({code}{', HTTP '+str(status) if status else ''}).")

class ProtocolError(PonderError):
    pass
