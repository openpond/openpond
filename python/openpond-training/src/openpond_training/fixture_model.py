from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import torch
from peft import LoraConfig, PeftModel, TaskType
from tokenizers import Tokenizer
from tokenizers.models import WordLevel
from tokenizers.pre_tokenizers import Whitespace
from transformers import GPT2Config, GPT2LMHeadModel, PreTrainedTokenizerBase, PreTrainedTokenizerFast

BASE_MODEL_ID = "openpond/tiny-cpu-gpt2-fixture"
BASE_MODEL_REVISION = "architecture-v2-seed-17-context-512"
TOKENIZER_REVISION = "wordlevel-v1"


def construct_fixture(records: list[dict[str, Any]], seed: int) -> tuple[GPT2LMHeadModel, PreTrainedTokenizerFast, str]:
    torch.manual_seed(seed)
    texts = [render_record(record) for record in records]
    tokens = sorted({token for text in texts for token in text.replace("\n", " ").split()})
    special = ["<pad>", "<bos>", "<eos>", "<unk>", "<user>", "<assistant>"]
    vocab = {token: index for index, token in enumerate([*special, *[token for token in tokens if token not in special]])}
    backend = Tokenizer(WordLevel(vocab=vocab, unk_token="<unk>"))
    backend.pre_tokenizer = Whitespace()
    tokenizer = PreTrainedTokenizerFast(
        tokenizer_object=backend,
        bos_token="<bos>",
        eos_token="<eos>",
        unk_token="<unk>",
        pad_token="<pad>",
    )
    tokenizer.chat_template = "{% for message in messages %}<{{ message['role'] }}>{{ message['content'] }}<eos>{% endfor %}"
    model = construct_fixture_from_tokenizer(tokenizer, seed)
    template_hash = hashlib.sha256(tokenizer.chat_template.encode("utf-8")).hexdigest()
    return model, tokenizer, template_hash


def construct_fixture_from_tokenizer(tokenizer: PreTrainedTokenizerBase, seed: int) -> GPT2LMHeadModel:
    torch.manual_seed(seed)
    config = GPT2Config(
        vocab_size=len(tokenizer),
        n_positions=512,
        n_ctx=512,
        n_embd=32,
        n_layer=1,
        n_head=1,
        bos_token_id=tokenizer.bos_token_id,
        eos_token_id=tokenizer.eos_token_id,
        pad_token_id=tokenizer.pad_token_id,
        use_cache=False,
    )
    return GPT2LMHeadModel(config)


def lora_config(recipe: dict[str, Any]) -> LoraConfig:
    config = recipe["lora"]
    return LoraConfig(
        task_type=TaskType.CAUSAL_LM,
        r=int(config["rank"]),
        lora_alpha=float(config["alpha"]),
        lora_dropout=float(config["dropout"]),
        target_modules=list(config["targetModules"]),
        bias="none",
    )


def render_record(record: dict[str, Any]) -> str:
    input_value = record.get("input")
    expected_value = record.get("expectedOutput")
    messages: list[Any] = []
    if isinstance(input_value, dict) and isinstance(input_value.get("messages"), list):
        messages.extend(input_value["messages"])
    if isinstance(expected_value, dict) and isinstance(expected_value.get("messages"), list):
        messages.extend(expected_value["messages"])
    if messages:
        from .inference import normalized_messages
        return "".join(f"<{message['role']}> {message['content']} <eos>" for message in normalized_messages(messages))
    prompt = str(record["input"].get("prompt", json.dumps(record["input"], sort_keys=True)))
    expected = str(record["expectedOutput"].get("text", json.dumps(record["expectedOutput"], sort_keys=True)))
    return f"<user> {prompt} <eos> <assistant> {expected} <eos>"


def reload_adapter(adapter_directory: Path, records: list[dict[str, Any]], seed: int) -> tuple[PeftModel, PreTrainedTokenizerFast, str]:
    base, tokenizer, template_hash = construct_fixture(records, seed)
    return PeftModel.from_pretrained(base, adapter_directory), tokenizer, template_hash
