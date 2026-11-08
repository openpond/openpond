"""Application-owned aliases augment generated Model administration resources."""
from __future__ import annotations
from .product_models import ProductModel, AsyncProductModel, ModelBinding
from .errors import ProtocolError

class ModelAliases:
    def configure_aliases(self, aliases: dict[str, str | ModelBinding], base_url: str | None, api_key: str) -> None:
        self._aliases = {}
        for name, binding in aliases.items():
            if not name.isidentifier() or name.startswith('_') or hasattr(type(self),name) or name in self.__dict__:
                raise ProtocolError('invalid_model_alias')
            if not base_url: raise ProtocolError('serving_base_url_required')
            self._aliases[name] = ProductModel(self._transport,binding,base_url,api_key)
    def __getattr__(self, name: str) -> ProductModel:
        aliases = self.__dict__.get('_aliases', {})
        if name not in aliases: raise AttributeError(name)
        return aliases[name]
    def __getitem__(self, name: str) -> ProductModel:
        return self._aliases[name]

class AsyncModelAliases:
    def configure_aliases(self, aliases: dict[str, str | ModelBinding], base_url: str | None, api_key: str) -> None:
        self._aliases = {}
        for name, binding in aliases.items():
            if not name.isidentifier() or name.startswith('_') or hasattr(type(self),name) or name in self.__dict__:
                raise ProtocolError('invalid_model_alias')
            if not base_url: raise ProtocolError('serving_base_url_required')
            self._aliases[name] = AsyncProductModel(self._transport,binding,base_url,api_key)
    def __getattr__(self, name: str) -> AsyncProductModel:
        aliases = self.__dict__.get('_aliases', {})
        if name not in aliases: raise AttributeError(name)
        return aliases[name]
    def __getitem__(self, name: str) -> AsyncProductModel:
        return self._aliases[name]
