"""Portable price approval and saved-version identity for usage-based serving."""
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any
from .errors import ProtocolError
from .wire import canonical_sha256, validate


def verify_serverless_review(review: dict[str, Any], team_id: str, model_id: str,
                             version_hash: str, artifact: dict[str, Any] | None) -> None:
    if (review['contentHash'] != canonical_sha256({key: value for key, value in review.items() if key != 'contentHash'})
            or review['teamId'] != team_id or review['modelProjectId'] != model_id
            or review['versionHash'] != version_hash or review['artifact'] != artifact):
        raise ProtocolError('serverless_serving_review_mismatch')


def create_serverless_serving_approval(raw: dict[str, Any], spending_limit: str | None = None) -> dict[str, Any]:
    review = validate('ServerlessServingReviewSchema', raw)
    verify_serverless_review(review, review['teamId'], review['modelProjectId'], review['versionHash'], review['artifact'])
    if (review['schemaVersion'] != 'openpond.serverlessServingReview.v2'
            or datetime.fromisoformat(review['expiresAt'].replace('Z', '+00:00')) <= datetime.now(timezone.utc)):
        raise ProtocolError('serverless_serving_review_expired')
    cap = None
    if spending_limit is not None and spending_limit.strip():
        try:
            amount = Decimal(spending_limit.strip())
            if (not amount.is_finite() or amount <= 0 or amount > Decimal('9007199254.740991')
                    or amount != amount.quantize(Decimal('0.000001'))):
                raise InvalidOperation()
            cap = format(amount, '.6f')
        except (InvalidOperation, ValueError):
            raise ProtocolError('serverless_serving_cap_invalid') from None
    return validate('ServerlessServingApprovalSchema', {'schemaVersion': 'openpond.serverlessServingApproval.v1',
        'reviewHash': review['contentHash'], 'customerCapUsd': cap})


def serverless_approval_matches(request: dict[str, Any], control: dict[str, Any]) -> bool:
    if request['action'] == 'stop':
        return True
    approval, snapshot = request.get('serverlessApproval'), control.get('serverless')
    if approval is None:
        return snapshot is None
    if snapshot is None or request.get('usageApproval') is not None or control.get('usage') is not None:
        return False
    review = snapshot['review']
    verify_serverless_review(review, request['teamId'], control['modelProjectId'], request['versionHash'], request['artifact'])
    return (approval['reviewHash'] == review['contentHash'] and approval['customerCapUsd'] == snapshot['customerCapUsd']
            and control['idleTimeoutSeconds'] == review['workerIdleTimeoutSeconds'])
