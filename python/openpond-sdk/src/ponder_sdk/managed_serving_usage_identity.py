"""Accepted deployment terms stay bound to the saved Model and original cap."""
from typing import Any
from decimal import Decimal
from datetime import datetime
from .errors import ProtocolError
from .wire import canonical_sha256, validate


def _money(value: str, *, positive: bool = False) -> None:
    amount = Decimal(value)
    if amount > Decimal('9007199254.740991') or amount < 0 or positive and amount == 0:
        raise ProtocolError('managed_serving_usage_mismatch')


def _usage_amounts(usage: dict[str, Any] | None) -> None:
    if usage is None:
        return
    _money(usage['price']['hourlyUsd'], positive=True)
    _money(usage['chargedUsd'])
    if usage['customerCapUsd'] is not None:
        _money(usage['customerCapUsd'])


def approval_matches(request: dict[str, Any], control: dict[str, Any]) -> bool:
    if request['action'] == 'stop':
        return True
    approval, usage = request.get('usageApproval'), control.get('usage')
    _usage_amounts(usage)
    if approval is not None and approval['customerCapUsd'] is not None:
        _money(approval['customerCapUsd'], positive=True)
    if approval is None:
        return usage is None
    return (usage is not None and usage['reviewHash'] == approval['reviewHash']
            and usage['customerCapUsd'] == approval['customerCapUsd'])


def verify_usage_billing(value: dict[str, Any], team_id: str, model_id: str,
                         version_hash: str, method: str) -> None:
    raw = value.get('usageBilling')
    if raw is None:
        return
    billing = validate('ManagedServingUsageReviewResultSchema', raw)
    review, usage = billing['review'], billing['usage']
    _usage_amounts(usage)
    if ((billing['availability'] == 'reviewable') != (review is not None)
            or (billing['availability'] == 'reviewable') != (billing['reason'] is None)
            or usage != (value.get('control') or {}).get('usage')):
        raise ProtocolError('managed_serving_usage_mismatch')
    if review is None:
        return
    _money(review['price']['hourlyUsd'], positive=True)
    if (review['contentHash'] != canonical_sha256({k: v for k, v in review.items() if k != 'contentHash'})
            or review['teamId'] != team_id or review['modelProjectId'] != model_id
            or review['versionHash'] != version_hash or review['method'] != method
            or datetime.fromisoformat(review['expiresAt'].replace('Z', '+00:00')) > datetime.fromisoformat(review['workDeadlineAt'].replace('Z', '+00:00'))
            or usage is not None and (usage['reviewHash'] != review['contentHash'] or usage['price'] != review['price'])):
        raise ProtocolError('managed_serving_usage_mismatch')
