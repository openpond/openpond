"""Funding reads are advisory; response bindings must survive native HTTP transport."""
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit
import re
from .errors import ProtocolError
from .wire import canonical_sha256


def verify_funding(value: dict[str, Any], request: dict[str, Any], team_id: str) -> None:
    try:
        checked = datetime.fromisoformat(value['checkedAt'].replace('Z', '+00:00'))
        expires = datetime.fromisoformat(value['expiresAt'].replace('Z', '+00:00'))
        if (value['teamId'] != team_id or request['teamId'] != team_id
                or value['maximumSpendUsd'] != request['maximumSpendUsd']
                or value['draft'] != request.get('draft')
                or value['requestHash'] != canonical_sha256(request)
                or expires <= checked or expires <= datetime.now(timezone.utc)):
            raise ProtocolError('training_funding_scope_mismatch')
        if value['schemaVersion'] == 'openpond.trainingFunding.v1':
            if not value['canViewBalance'] and (value['availableUsageUsd'] is not None or value['prepaidCreditUsd'] is not None):
                raise ProtocolError('training_funding_balance_forbidden')
        else:
            url = value['billingUrl']
            if bool(url) != value['canPurchase']:
                raise ProtocolError('training_funding_handoff_forbidden')
            if url:
                parsed = urlsplit(url)
                _ = parsed.port
                if (not parsed.hostname or parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1', '::1'))
                        or parsed.username or parsed.password or parsed.query or parsed.fragment
                        or not re.fullmatch(r'/entry/[A-Za-z0-9_-]{40,4096}', parsed.path)):
                    raise ProtocolError('training_funding_handoff_invalid')
    except (ValueError, TypeError) as error:
        raise ProtocolError('training_funding_scope_mismatch') from error
