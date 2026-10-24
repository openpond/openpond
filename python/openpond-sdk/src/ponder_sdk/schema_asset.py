"""Strict lossless storage decoder, before any JSON Schema interpretation.

All source objects live in a child-first table. A tag can therefore never be
confused with an original dictionary containing the same key. References expand
into independent dictionaries; JSON Schema's own local $refs stay untouched.
"""
from __future__ import annotations
import json
import math
from typing import Any

class SchemaAssetError(ValueError):
    def __init__(self)->None:super().__init__('invalid_schema_asset')

def decode_schema_asset(raw: bytes) -> dict[str,Any]:
    if not isinstance(raw,bytes) or len(raw)>4*1024*1024:raise SchemaAssetError()
    def pairs(items):
        result={}
        for key,value in items:
            if key in result:raise SchemaAssetError()
            result[key]=value
        return result
    try:envelope=json.loads(raw,object_pairs_hook=pairs)
    except (ValueError,UnicodeError,RecursionError):raise SchemaAssetError() from None
    if not isinstance(envelope,dict) or set(envelope)!={'schemaVersion','root','objects'} or envelope['schemaVersion']!='openpond.internedJson.v1':raise SchemaAssetError()
    table=envelope['objects']
    if not isinstance(table,list) or not 1<=len(table)<=100000 or any(not isinstance(body,dict) for body in table):raise SchemaAssetError()
    visits=0;volume=0
    def account(value,depth):
        nonlocal visits,volume
        visits+=1
        if depth>256 or visits>2000000:raise SchemaAssetError()
        volume+=len(value.encode('utf-8','surrogatepass')) if isinstance(value,str) else 8
        if volume>32*1024*1024:raise SchemaAssetError()
    def reference(value,limit):
        if not isinstance(value,dict) or set(value)!={'$object'} or type(value['$object']) is not int or not 0<=value['$object']<limit:raise SchemaAssetError()
        return value['$object']
    def validate(value,limit,depth):
        account(value,depth)
        if isinstance(value,dict):reference(value,limit)
        elif isinstance(value,list):
            for item in value:validate(item,limit,depth+1)
        elif value is not None and type(value) not in (str,int,float,bool):raise SchemaAssetError()
        elif isinstance(value,float) and not math.isfinite(value):raise SchemaAssetError()
    for index,body in enumerate(table):
        for key,value in body.items():
            account(key,0);validate(value,index,1)
    if reference(envelope['root'],len(table))!=len(table)-1:raise SchemaAssetError()
    reachable=set();visits=0;volume=0
    def expand(value,depth):
        account(value,depth)
        if isinstance(value,dict):
            index=reference(value,len(table));reachable.add(index)
            result={}
            for key,child in table[index].items():
                account(key,depth);result[key]=expand(child,depth+1)
            return result
        if isinstance(value,list):return [expand(item,depth+1) for item in value]
        return value
    result=expand(envelope['root'],0)
    if len(reachable)!=len(table):raise SchemaAssetError()
    return result
