"""Hardware metadata never authorizes placement or substitutes live stock."""
from .errors import ProtocolError
from .wire import canonical_sha256
from datetime import datetime


def verify_catalog(catalog):
    inventory=catalog['inventory']
    content={k:v for k,v in inventory.items() if k not in ('version','observedAt','refreshAfter')}
    ids=[item['id'] for item in inventory['hardware']]
    eligible=[item['gpuTypeId'] for item in catalog['eligibility']]
    if inventory['version']!=canonical_sha256(content) or len(set(ids))!=len(ids):
        raise ProtocolError('training_hardware_inventory_mismatch')
    if datetime.fromisoformat(inventory['refreshAfter'].replace('Z','+00:00'))<=datetime.fromisoformat(inventory['observedAt'].replace('Z','+00:00')):
        raise ProtocolError('training_hardware_inventory_mismatch')
    if len(eligible)!=len(ids) or len(set(eligible))!=len(ids) or set(eligible)!=set(ids) or any(
        (item['status']=='requires_live_workload_check')!=(item['reason']=='candidate_for_current_runtime') for item in catalog['eligibility']):
        raise ProtocolError('training_hardware_catalog_mismatch')


def verify_gpu_catalog(catalog,query):
    from datetime import timezone
    observed=datetime.fromisoformat(catalog['observedAt'].replace('Z','+00:00'))
    expires=datetime.fromisoformat(catalog['expiresAt'].replace('Z','+00:00'))
    if expires<=observed or expires<=datetime.now(timezone.utc):
        raise ProtocolError('training_gpu_catalog_expired')
    if not query:
        if catalog.get('scope') is not None:raise ProtocolError('training_gpu_catalog_scope_mismatch')
        return
    scope=catalog.get('scope')
    if scope is None or scope['query']!=query or scope['requestHash']!=canonical_sha256(query):
        raise ProtocolError('training_gpu_catalog_scope_mismatch')
    unsupported=scope['qualification']=='unsupported'
    if unsupported!=(scope['reason'] is not None):
        raise ProtocolError('training_gpu_catalog_scope_mismatch')
    if unsupported:
        if scope['provider'] is not None or catalog['offerings']:
            raise ProtocolError('training_gpu_catalog_scope_mismatch')
    elif scope['provider'] is None:
        raise ProtocolError('training_gpu_catalog_scope_mismatch')
    if len({item['provider'] for item in catalog['offerings']})>1 or any(item['gpuCount']!=query['gpuCount'] or item['dataCenterId']!=scope['provider']['dataCenterId'] for item in catalog['offerings']):
        raise ProtocolError('training_gpu_catalog_scope_mismatch')
    ids=[item['availabilityId'] for item in catalog['offerings']]
    if len(ids)!=len(set(ids)):raise ProtocolError('training_gpu_catalog_scope_mismatch')
