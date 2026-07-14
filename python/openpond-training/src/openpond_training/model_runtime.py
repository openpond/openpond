from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

from .contracts import ContractError
from .fixture_model import BASE_MODEL_ID, construct_fixture, reload_adapter as reload_fixture


def load_base_model(recipe: dict[str, Any], records: list[dict[str, Any]], seed: int, model_path: str | None):  # type: ignore[no-untyped-def]
    expected = recipe["baseModel"]
    if expected["id"] == BASE_MODEL_ID:
        model, tokenizer, template_hash = construct_fixture(records, seed)
        return model, tokenizer, template_hash
    if not model_path:
        raise ContractError(f"Local model path is required for {expected['id']}.")
    directory = Path(model_path).resolve()
    metadata_path = directory / "openpond-model.json"
    if not metadata_path.is_file():
        raise ContractError("Local model snapshot is missing verified OpenPond metadata.")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    if metadata.get("modelId") != expected["id"] or metadata.get("revision") != expected["revision"]:
        raise ContractError("Local model snapshot does not match the pinned recipe revision.")
    tokenizer = AutoTokenizer.from_pretrained(directory, local_files_only=True, trust_remote_code=False)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    template = tokenizer.chat_template
    if not isinstance(template, str) or not template:
        raise ContractError("Local model tokenizer has no chat template.")
    template_hash = hashlib.sha256(template.encode("utf-8")).hexdigest()
    if template_hash != expected["chatTemplateHash"]:
        raise ContractError("Local model chat template does not match the pinned recipe.")
    model = AutoModelForCausalLM.from_pretrained(directory, local_files_only=True, trust_remote_code=False, torch_dtype=torch.float32)
    model.config.use_cache = False
    return model, tokenizer, template_hash


def reload_adapter(adapter_directory: Path, recipe: dict[str, Any], records: list[dict[str, Any]], seed: int, model_path: str | None):  # type: ignore[no-untyped-def]
    if recipe["baseModel"]["id"] == BASE_MODEL_ID:
        return reload_fixture(adapter_directory, records, seed)
    base, tokenizer, template_hash = load_base_model(recipe, records, seed, model_path)
    return PeftModel.from_pretrained(base, adapter_directory), tokenizer, template_hash


def render_training_record(record: dict[str, Any], tokenizer) -> str:  # type: ignore[no-untyped-def]
    structured = structured_training_messages(record)
    if structured:
        if getattr(tokenizer, "chat_template", None):
            return str(tokenizer.apply_chat_template(structured, tokenize=False, add_generation_prompt=False))
        return "".join(f"<{message['role']}> {message['content']} <eos>" for message in structured)
    prompt = input_text(record.get("input", {}))
    expected = output_text(record.get("expectedOutput", {}))
    if getattr(tokenizer, "chat_template", None):
        return str(tokenizer.apply_chat_template([{"role": "user", "content": prompt}, {"role": "assistant", "content": expected}], tokenize=False, add_generation_prompt=False))
    return f"<user> {prompt} <eos> <assistant> {expected} <eos>"


def structured_training_messages(record: dict[str, Any]) -> list[dict[str, str]]:
    input_value = record.get("input")
    expected_value = record.get("expectedOutput")
    candidates: list[Any] = []
    if isinstance(input_value, dict) and isinstance(input_value.get("messages"), list):
        candidates.extend(input_value["messages"])
    if isinstance(expected_value, dict) and isinstance(expected_value.get("messages"), list):
        candidates.extend(expected_value["messages"])
    if not candidates:
        return []
    # Use the same typed-message projection as inference so training and chat share one protocol.
    from .inference import normalized_messages
    return normalized_messages(candidates)


def render_evaluation_prompt(task_input: Any, tokenizer) -> str:  # type: ignore[no-untyped-def]
    prompt = input_text(task_input)
    if getattr(tokenizer, "chat_template", None):
        return str(tokenizer.apply_chat_template([{"role": "user", "content": prompt}], tokenize=False, add_generation_prompt=True))
    return f"<user> {prompt} <eos> <assistant>"


def input_text(value: Any) -> str:
    if isinstance(value, dict) and isinstance(value.get("prompt"), str):
        return value["prompt"]
    return json.dumps(value, sort_keys=True, ensure_ascii=False) if not isinstance(value, str) else value


def output_text(value: Any) -> str:
    if isinstance(value, dict) and isinstance(value.get("text"), str):
        return value["text"]
    return json.dumps(value, sort_keys=True, ensure_ascii=False) if not isinstance(value, str) else value
