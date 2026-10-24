"""Portable JSON wire rules. The schemas originate in the TypeScript SDK."""
from __future__ import annotations
import copy
import hashlib
import json
import math
from functools import lru_cache
from importlib.resources import files
from typing import Any, TypeAlias, Union
import rfc8785
from jsonschema import Draft202012Validator, FormatChecker
from .errors import ProtocolError

JsonValue: TypeAlias = Union[None, bool, int, float, str, list['JsonValue'], dict[str, 'JsonValue']]
JsonObject: TypeAlias = dict[str, JsonValue]


def canonical_json(value: JsonValue) -> str:
    """Match protocol.ts normalization AND ECMAScript JSON.stringify enumeration.

    Omission is represented by absence of a key; None is an explicit JSON null.
    Python integers must be exactly representable as a JavaScript number.
    """
    if value is None: return 'null'
    if type(value) is bool: return 'true' if value else 'false'
    if type(value) in (int, float):
        try:
            finite=math.isfinite(value);number=float(value)
        except (ValueError,OverflowError):raise ProtocolError('non_json_number') from None
        if not finite: raise ProtocolError('non_json_value')
        if type(value) is int and int(number) != value: raise ProtocolError('non_json_number')
        try: return rfc8785.dumps(number).decode('ascii')
        except (ValueError, OverflowError): raise ProtocolError('non_json_number') from None
    if type(value) is str:
        value=value.encode('utf-16-le','surrogatepass').decode('utf-16-le','surrogatepass')
        text = json.dumps(value, ensure_ascii=False)
        return ''.join(f'\\u{ord(char):04x}' if 0xD800 <= ord(char) <= 0xDFFF else char for char in text)
    if type(value) is list: return '['+','.join(canonical_json(item) for item in value)+']'
    if type(value) is dict and all(type(key) is str for key in value):
        # Object.keys().sort() uses UTF-16. JSON.stringify then emits array-index
        # keys first, regardless of insertion order: do not substitute pure JCS.
        normalized_keys=[key.encode('utf-16-le','surrogatepass').decode('utf-16-le','surrogatepass') for key in value]
        if len(set(normalized_keys))!=len(normalized_keys):raise ProtocolError('non_json_key_collision')
        indices = sorted((key for key in value if key.isascii() and key.isdecimal() and str(int(key)) == key and int(key) < 4294967295), key=int)
        others = sorted((key for key in value if key not in indices), key=lambda key: key.encode('utf-16-be', 'surrogatepass'))
        return '{'+','.join(canonical_json(key)+':'+canonical_json(value[key]) for key in indices+others)+'}'
    raise ProtocolError('non_json_value')


def canonical_sha256(value: JsonValue) -> str:
    return hashlib.sha256(canonical_json(value).encode('utf-8')).hexdigest()


@lru_cache(maxsize=1)
def schemas() -> dict[str, Any]:
    from .schema_asset import decode_schema_asset,SchemaAssetError
    try:return decode_schema_asset(files('ponder_sdk').joinpath('schemas.json').read_bytes())
    except SchemaAssetError:raise ProtocolError('invalid_schema_asset') from None


@lru_cache(maxsize=256)
def validator(name: str, request: bool = False) -> Draft202012Validator:
    group=schemas()['inputSchemas' if request else 'schemas']
    if name not in group: raise ProtocolError('unknown_wire_schema')
    return Draft202012Validator(group[name], format_checker=FormatChecker())


def validate(name: str, value: Any, *, request: bool = False) -> Any:
    value=normalize(validator(name,request).schema,value)
    # Do not echo jsonschema exceptions: their message contains private values.
    if not validator(name,request).is_valid(value): raise ProtocolError('invalid_wire_value')
    return value


_JS_SPACE='\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'

def normalize(schema: dict[str,Any], value: Any, root: dict[str,Any] | None = None, depth: int = 0) -> Any:
    if depth>128:raise ProtocolError('wire_depth_exceeded')
    root=schema if root is None else root
    if '$ref' in schema:
        ref=schema['$ref']
        if not ref.startswith('#/'):raise ProtocolError('external_wire_reference')
        target=root
        for part in ref[2:].split('/'):target=target[part.replace('~1','/').replace('~0','~')]
        return normalize(target,value,root,depth+1)
    for keyword in ('anyOf','oneOf'):
        if keyword in schema:
            for branch in schema[keyword]:
                candidate=normalize(branch,value,root,depth+1)
                # Resolve local refs against this root, not the branch document.
                document={'$defs':root.get('$defs',{}),**branch}
                if Draft202012Validator(document,format_checker=FormatChecker()).is_valid(candidate):return candidate
            return value
    if isinstance(value,str):
        for transform in schema.get('x-openpond-string-transforms',[]):
            if transform=='trim':value=value.strip(_JS_SPACE)
            elif transform=='lowercase':value=value.lower()
            elif transform=='uppercase':value=value.upper()
            else:raise ProtocolError('unknown_wire_transform')
    if isinstance(value,dict):
        result={};properties=schema.get('properties',{})
        for key,item in value.items():
            if key not in properties and schema.get('x-openpond-object-policy')=='strip':continue
            child=properties.get(key,schema.get('additionalProperties',{}))
            result[key]=normalize(child if isinstance(child,dict) else {},item,root,depth+1)
        for key,child in properties.items():
            if key not in result and 'default' in child:result[key]=normalize(child,copy.deepcopy(child['default']),root,depth+1)
        return result
    if isinstance(value,list):return [normalize(schema.get('items',{}),item,root,depth+1) for item in value]
    return value


def verify_preparation(value: Any, team_id: str, preparation_id: str | None = None) -> Any:
    validate('TrainingPreparationReceiptSchema', value)
    plan=value['plan']; request=plan['request']; content={k:v for k,v in plan.items() if k!='contentHash'}
    if canonical_sha256(content)!=plan['contentHash'] or canonical_sha256(request)!=plan['requestHash'] or plan['source']['modelProject']['id']!=request['configuration']['id'] or canonical_sha256(plan['source'].get('origin'))!=canonical_sha256(request.get('origin')):
        raise ProtocolError('training_preparation_mismatch')
    if request['teamId']!=team_id or preparation_id is not None and plan['id']!=preparation_id:
        raise ProtocolError('training_preparation_scope_mismatch')
    if (value['state']=='submitted') != bool(value['jobId']): raise ProtocolError('training_preparation_mismatch')
    return value


def verify_hash(value: dict[str, Any], field: str, *, omit: tuple[str, ...] = ()) -> None:
    if value[field] != canonical_sha256({k:v for k,v in value.items() if k not in (field, *omit)}):
        raise ProtocolError('content_hash_mismatch')
