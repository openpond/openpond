"""Request-owned absolute token custody. Padding and recomputation are explicit."""
from __future__ import annotations
from dataclasses import dataclass
from .artifacts import require

GROUPS = (('suffix2', 2, False), ('suffix3', 3, False), ('previous3', 3, True))


@dataclass(frozen=True)
class PreparedHistory:
    request_id: str
    token_ids: tuple[int, ...]
    positions: tuple[int, ...]
    attention_mask: tuple[int, ...]
    indices: dict[str, tuple[tuple[int, ...], ...]]
    valid: dict[str, tuple[bool, ...]]
    generation: int


class RequestHistory:
    def __init__(self, request_id: str, *, maximum_tokens=8192, vocab_size=151936):
        require(type(request_id) is str and 0 < len(request_id) <= 240, "request_identity_invalid")
        require(type(maximum_tokens) is int and 1 <= maximum_tokens <= 8192 and type(vocab_size) is int and vocab_size > 0, "history_limit_invalid")
        self.request_id = request_id
        self.maximum_tokens, self.vocab_size = maximum_tokens, vocab_size
        self._tokens: dict[int, int] = {}
        self._generation, self._closed = 0, False
        self._cache = self._adapter_owner = self._policy = None

    def prepare(self, *, request_id, token_ids, attention_mask, positions) -> PreparedHistory:
        require(not self._closed and request_id == self.request_id, "history_owner_mismatch")
        require(type(token_ids) is list and 1 <= len(token_ids) <= self.maximum_tokens
            and type(positions) is list and type(attention_mask) is list and len(token_ids) == len(positions) == len(attention_mask), "history_shape_invalid")
        require(all(type(token) is int and 0 <= token < self.vocab_size for token in token_ids)
            and all(type(position) is int and 0 <= position < self.maximum_tokens for position in positions)
            and all(type(mask) is int and mask in (0, 1) for mask in attention_mask)
            and all(mask == 1 for mask in attention_mask), "history_tokens_invalid")
        visible = [(position, token) for position, token, mask in zip(positions, token_ids, attention_mask) if mask]
        require([p for p, _ in visible] == list(range(visible[0][0], visible[0][0] + len(visible))), "history_positions_invalid")
        proposed = dict(self._tokens)
        for position, token in visible:
            require(position in proposed and proposed[position] == token or position not in proposed and position == len(proposed), "history_recomputation_or_gap")
            proposed[position] = token
        indices, valid = {}, {}
        for name, order, previous in GROUPS:
            buckets, allowed = [], []
            for position, mask in zip(positions, attention_mask):
                end = position - int(previous)
                ready = bool(mask) and end - order + 1 >= 0 and all(index in proposed for index in range(end - order + 1, end + 1))
                allowed.append(ready)
                mixed = sum(proposed[end - j] * (1000003 + 97 * j) for j in range(order)) if ready else 0
                buckets.append(tuple((mixed + 10000 * order + 97 * h + (1000000 if previous else 0)) % 90007 for h in range(4)))
            indices[name], valid[name] = tuple(buckets), tuple(allowed)
        return PreparedHistory(request_id, tuple(token_ids), tuple(positions), tuple(attention_mask), indices, valid, self._generation)

    def commit(self, prepared: PreparedHistory) -> None:
        require(not self._closed and prepared.request_id == self.request_id and prepared.generation == self._generation, "history_commit_fenced")
        for position, token, mask in zip(prepared.positions, prepared.token_ids, prepared.attention_mask):
            if mask:
                require(position in self._tokens and self._tokens[position] == token or position not in self._tokens and position == len(self._tokens), "history_commit_conflict")
                self._tokens[position] = token
        self._generation += 1

    def bind_adapter(self, adapter, *, enabled):
        require(not self._closed and (self._adapter_owner is None or self._adapter_owner is adapter)
            and (self._policy is None or self._policy == enabled), "history_adapter_or_policy_changed")
        self._adapter_owner, self._policy = adapter, enabled

    def verify_cache_input(self, cache, first_position):
        if cache is None:
            require(first_position == 0, "uncached_forward_requires_full_prefix")
        else:
            require(cache is self._cache and callable(getattr(cache, "get_seq_length", None))
                and cache.get_seq_length() == first_position, "history_cache_owner_mismatch")

    def commit_cache(self, cache, expected_length):
        require(not self._closed, "history_cache_closed")
        if cache is not None:
            require(callable(getattr(cache, "get_seq_length", None)) and cache.get_seq_length() == expected_length, "history_cache_length_mismatch")
        self._cache = cache

    def release(self) -> None:
        self._tokens.clear()
        self._cache = self._adapter_owner = self._policy = None
        self._generation += 1
        self._closed = True
