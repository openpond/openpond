"""Dataset import receipts cannot substitute workspace, source or example inventory."""
from typing import Any
from .errors import ProtocolError
from .wire import canonical_sha256


def verify_dataset_review(value: dict[str, Any], request: dict[str, Any], team_id: str) -> None:
    content = {key: item for key, item in value.items() if key != 'contentHash'}
    if (value['contentHash'] != canonical_sha256(content)
            or value['id'] != 'dataset-review-'+canonical_sha256([value['teamId'], value['actorId'], value['operationId']])
            or value['requestHash'] != canonical_sha256(request)
            or value['teamId'] != team_id or request['teamId'] != team_id
            or value['operationId'] != request['operationId']
            or value['dataset'] != request['dataset'] or value['packageHash'] != request['packageHash']
            or value['purpose'] != request['purpose'] or value['shareWithWorkspace'] is not True):
        raise ProtocolError('dataset_training_review_mismatch')
    evidence, proposals = value['evidence'], value['proposals']
    if (len({ref['id'] for ref in evidence}) != len(evidence)
            or len({ref['id'] for ref in proposals}) != len(proposals)
            or len(proposals) > len(evidence)
            or request.get('taskIds') is not None and len(evidence) != len(request['taskIds'])):
        raise ProtocolError('dataset_training_review_inventory_mismatch')
