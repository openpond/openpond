"""Complete Job prices are immutable preparation data, not a new reservation."""
from decimal import Decimal
from datetime import datetime
from .errors import ProtocolError
from .wire import canonical_sha256


def verify_training_usage_snapshot(job):
    usage = job.get('usage')
    if usage is None:
        return
    if [item['component'] for item in usage['components']] != ['gpu', 'guest', 'storage', 'judge']:
        raise ProtocolError('training_usage_snapshot_mismatch')
    values = [usage[key] for key in ('customerCapUsd', 'chargedUsd', 'committedUsd', 'outstandingUsd',
                                     'remainingCapUsd', 'availableCreditUsd')]
    for component in usage['components']:
        values.extend(component[key] for key in ('chargedUsd', 'committedUsd', 'outstandingUsd'))
    if any(Decimal(value) > Decimal('9007199254.740991') for value in values if value is not None):
        raise ProtocolError('training_usage_snapshot_mismatch')


def verify_training_usage_quote(plan):
    request = plan['request']
    funding, quote = request.get('usageFunding'), plan.get('usageQuote')
    if (funding is None) != (quote is None):
        raise ProtocolError('training_usage_quote_mismatch')
    if quote is None:
        return
    if (quote['contentHash'] != canonical_sha256({k: v for k, v in quote.items() if k not in ('contentHash', 'signature')})
            or quote['teamId'] != request['teamId'] or quote['actorUserId'] != plan['creatorUserId']
            or quote['preparationId'] != plan['id'] or quote['submissionHash'] != plan['submissionHash']
            or quote['customerCapUsd'] != funding['customerCapUsd']
            or datetime.fromisoformat(quote['expiresAt'].replace('Z', '+00:00')) <= datetime.fromisoformat(quote['issuedAt'].replace('Z', '+00:00'))
            or len({guest['profileHash'] for guest in quote['guests']}) != len(quote['guests'])
            or any(guest['profileHash'] != guest['price']['profileHash'] for guest in quote['guests'])):
        raise ProtocolError('training_usage_quote_mismatch')
    amounts = [price['hourlyUsd'] for price in [quote['gpu'], quote['storage']['price'], *[guest['price'] for guest in quote['guests']]]]
    if quote['customerCapUsd'] is not None:
        amounts.append(quote['customerCapUsd'])
    if any(Decimal(amount) <= 0 or Decimal(amount) > Decimal('9007199254.740991') for amount in amounts):
        raise ProtocolError('training_usage_quote_mismatch')
    judges = quote['judges']
    hashes = judges['acceptedPricingHashes']
    price_hashes = [price['acceptedPricingHash'] for price in judges['prices']]
    if len(set(hashes)) != len(hashes) or len(set(price_hashes)) != len(price_hashes) or set(hashes) != set(price_hashes):
        raise ProtocolError('training_usage_quote_mismatch')
    for price in judges['prices']:
        rates = [price[key] for key in ('inputUsdPerMillionTokens', 'cachedInputUsdPerMillionTokens',
                                       'outputUsdPerMillionTokens', 'cacheWriteUsdPerMillionTokens',
                                       'cacheWriteOneHourUsdPerMillionTokens')]
        if price['longContext'] is not None:
            rates.extend(price['longContext'].values())
        if any(Decimal(rate) > Decimal('9007199254.740991') for rate in rates if rate is not None):
            raise ProtocolError('training_usage_quote_mismatch')
