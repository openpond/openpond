"""Estimate response bindings shared by native sync and async HTTP clients."""
from datetime import datetime, timezone
from typing import Any
from .errors import ProtocolError
from .wire import canonical_sha256
from .estimate_workload_identity import verify_workload


def verify_estimate(value: dict[str, Any], request: dict[str, Any], team_id: str) -> None:
    verify_workload(value, request)
    source = request['source']
    if source['kind'] == 'submission':
        submitted = source['submission']
        identity = dict(kind='submission', id=submitted['idempotencyKey'], contentHash=submitted['contentHash'], revision=None)
    else:
        identity = dict(kind=source['kind'], id=source['id'],
                        contentHash=source['planHash'] if source['kind'] == 'preparation' else source['expectedEtag'],
                        revision=source['expectedRevision'])
    selection = request.get('gpuSelection')
    if source['kind'] == 'submission':
        selection = source['submission'].get('gpuSelection') or dict(mode='automatic', objective=source['submission']['placementObjective'])
    review = value['review']
    try:
        expires = datetime.fromisoformat(value['expiresAt'].replace('Z', '+00:00'))
        created = datetime.fromisoformat(value['createdAt'].replace('Z', '+00:00'))
        if expires <= datetime.now(timezone.utc) or expires <= created:
            raise ProtocolError('training_estimate_scope_mismatch')
    except (ValueError, TypeError) as error:
        raise ProtocolError('training_estimate_scope_mismatch') from error
    if (value['teamId'] != team_id or value['requestHash'] != canonical_sha256(request)
            or value['source'] != identity or selection is not None and value['gpu']['requested'] != selection
            or any(review[key] != expected for key, expected in dict(estimateId=value['id'], inputHash=value['inputHash'],
                requestHash=value['requestHash'], pricingVersion=value['pricing']['version'], expiresAt=value['expiresAt']).items())):
        raise ProtocolError('training_estimate_scope_mismatch')
    gpu = value['gpu']
    if gpu['resolved'] is not None and (gpu['resolved']['gpuCount'] != gpu['requested'].get('gpuCount', 1)
            or gpu['requested']['mode'] == 'manual' and any(gpu['resolved'][key] != gpu['requested'][key] for key in ('availabilityId', 'gpuType'))):
        raise ProtocolError('training_estimate_scope_mismatch')
    components = value['cost']['components']
    allocation = [component for component in components if component['phase'] == 'gpu_allocation']
    if allocation:
        aggregate, rate = allocation[0], gpu['hourlyUsd']
        expected, seconds = aggregate['expectedUsd'], aggregate['expectedSeconds']
        if (len(allocation) != 1 or aggregate['resource'] != 'gpu'
                or (expected is None) != (seconds is None)
                or expected is not None and (rate is None or aggregate['evidence'] != 'measured'
                    or abs(expected - seconds / 3600 * rate) > 1e-9)
                or aggregate['planningRangeUsd'] is not None and expected is None
                or any(component['resource'] == 'gpu' and component['phase'] != 'gpu_allocation'
                    and any(component[key] is not None for key in ('expectedUsd', 'expectedSeconds', 'planningRangeUsd'))
                    for component in components)):
            raise ProtocolError('training_estimate_scope_mismatch')
    if value['status'] == 'available' and (value['cost']['expectedUsd'] is None or value['executionSeconds']['expected'] is None or value['unknowns']):
        raise ProtocolError('training_estimate_scope_mismatch')
    ranges = [value['executionSeconds']['planningRange'], value['cost']['planningRangeUsd']]
    ranges += [component['planningRangeUsd'] for component in value['cost']['components']]
    if value['queueWaitSeconds'] is not None: ranges.append(value['queueWaitSeconds']['planningRange'])
    if any(span is not None and span['high'] < span['low'] for span in ranges):
        raise ProtocolError('training_estimate_scope_mismatch')
