from __future__ import annotations

import argparse
import hashlib
import json
import sys
import threading
from pathlib import Path
from typing import Any

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer, TextIteratorStreamer

from .contracts import ContractError
from .fixture_model import BASE_MODEL_ID, construct_fixture_from_tokenizer


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def load_runtime(args: argparse.Namespace):  # type: ignore[no-untyped-def]
    adapter_path = Path(args.adapter_path).resolve()
    if args.base_model_id == BASE_MODEL_ID:
        tokenizer_path = adapter_path.parent / "tokenizer"
        if not tokenizer_path.is_dir():
            raise ContractError("Fixture adapter is missing its persisted tokenizer.")
        tokenizer = AutoTokenizer.from_pretrained(tokenizer_path, local_files_only=True, trust_remote_code=False)
        template = tokenizer.chat_template
        if not isinstance(template, str) or not template:
            raise ContractError("Fixture tokenizer has no chat template.")
        template_hash = hashlib.sha256(template.encode("utf-8")).hexdigest()
        if template_hash != args.chat_template_hash:
            raise ContractError("Fixture chat template does not match the imported adapter lineage.")
        base = construct_fixture_from_tokenizer(tokenizer, seed=17)
        model = PeftModel.from_pretrained(base, adapter_path, is_trainable=False)
        model.eval()
        model.config.use_cache = True
        return model, tokenizer
    if not args.model_path:
        raise ContractError(f"Local model path is required for {args.base_model_id}.")
    model_path = Path(args.model_path).resolve()
    metadata_path = model_path / "openpond-model.json"
    if not metadata_path.is_file():
        raise ContractError("Local model snapshot is missing verified OpenPond metadata.")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    if metadata.get("modelId") != args.base_model_id or metadata.get("revision") != args.base_model_revision:
        raise ContractError("Local model snapshot does not match the imported adapter lineage.")
    if not (adapter_path / "adapter_model.safetensors").is_file() or not (adapter_path / "adapter_config.json").is_file():
        raise ContractError("Imported adapter directory is incomplete.")

    tokenizer = AutoTokenizer.from_pretrained(model_path, local_files_only=True, trust_remote_code=False)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    template = tokenizer.chat_template
    if not isinstance(template, str) or not template:
        raise ContractError("Local model tokenizer has no chat template.")
    template_hash = hashlib.sha256(template.encode("utf-8")).hexdigest()
    if template_hash != args.chat_template_hash:
        raise ContractError("Local model chat template does not match the imported adapter lineage.")

    base = AutoModelForCausalLM.from_pretrained(
        model_path,
        local_files_only=True,
        trust_remote_code=False,
        dtype=torch.float32,
    )
    model = PeftModel.from_pretrained(base, adapter_path, is_trainable=False)
    model.eval()
    model.config.use_cache = True
    return model, tokenizer


def normalized_messages(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        raise ContractError("Inference messages must be an array.")
    messages: list[dict[str, str]] = []
    call_names: dict[str, str] = {}

    for item in value:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        content = item.get("content")
        if role == "tool":
            raw_call_id = item.get("tool_call_id")
            name = call_names.get(raw_call_id) if isinstance(raw_call_id, str) else None
            if not name:
                raise ContractError("Training data contains a tool result without a matching registered tool call.")
            messages.append({"role": "user", "content": json.dumps(
                canonical_tool_result(name, content),
                ensure_ascii=False,
                separators=(",", ":"),
            )})
            continue
        tool_calls = item.get("tool_calls")
        if role == "assistant" and isinstance(tool_calls, list) and tool_calls:
            for call in tool_calls:
                if not isinstance(call, dict) or not isinstance(call.get("function"), dict):
                    continue
                function = call["function"]
                raw_arguments = function.get("arguments")
                try:
                    arguments = json.loads(raw_arguments) if isinstance(raw_arguments, str) else {}
                except json.JSONDecodeError:
                    arguments = {"malformed_arguments": raw_arguments}
                messages.append({"role": "assistant", "content": json.dumps({
                    "type": "tool_call",
                    "name": function.get("name"),
                    "arguments": arguments,
                }, ensure_ascii=False, separators=(",", ":"))})
                raw_call_id = call.get("id")
                name = function.get("name")
                if isinstance(raw_call_id, str) and raw_call_id and isinstance(name, str) and name:
                    call_names[raw_call_id] = name
            if isinstance(content, str) and content:
                messages.append({"role": "assistant", "content": content})
            continue
        if role not in {"system", "user", "assistant"} or not isinstance(content, str) or not content:
            continue
        messages.append({"role": role, "content": content})
    if not any(message["role"] == "user" for message in messages):
        raise ContractError("Inference requires at least one user message.")
    return messages


def canonical_tool_result(name: str, content: Any) -> dict[str, Any]:
    parsed: Any = content if content is not None else ""
    if isinstance(content, str):
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError:
            parsed = content
    if not isinstance(parsed, dict):
        return {"type": "tool_result", "name": name, "ok": True, "result": parsed, "error": None}
    ok = parsed.get("ok") if isinstance(parsed.get("ok"), bool) else True
    if "result" in parsed:
        result = parsed["result"]
    elif "data" in parsed:
        result = parsed["data"]
    else:
        result = parsed if ok else None
    if "error" in parsed:
        error = parsed["error"]
    elif ok:
        error = None
    else:
        error = parsed.get("output") if isinstance(parsed.get("output"), str) else "Tool execution failed."
    return {"type": "tool_result", "name": name, "ok": ok, "result": result, "error": error}


def request_context_window_tokens(request: dict[str, Any]) -> int:
    value = request.get("contextWindowTokens")
    if isinstance(value, bool) or not isinstance(value, int) or value < 128 or value > 32_768:
        raise ContractError("Inference contextWindowTokens must be an integer between 128 and 32768.")
    return value


def left_truncate_encoded_input(encoded: Any, context_window_tokens: int) -> tuple[int, int]:
    input_ids = encoded.get("input_ids")
    if not isinstance(input_ids, torch.Tensor) or input_ids.ndim < 2:
        raise ContractError("Inference tokenizer did not return batched input_ids.")
    input_tokens_before = int(input_ids.shape[-1])
    tokens_dropped = max(0, input_tokens_before - context_window_tokens)
    if not tokens_dropped:
        return input_tokens_before, 0
    for key, value in list(encoded.items()):
        if isinstance(value, torch.Tensor) and value.ndim >= 2 and int(value.shape[-1]) == input_tokens_before:
            encoded[key] = value[..., -context_window_tokens:]
    if int(encoded["input_ids"].shape[-1]) != context_window_tokens:
        raise ContractError("Inference context truncation did not preserve the configured token window.")
    return input_tokens_before, tokens_dropped


def generate(request: dict[str, Any], model, tokenizer, fixture_mode: bool = False) -> None:  # type: ignore[no-untyped-def]
    request_id = str(request.get("id") or "")
    if not request_id:
        raise ContractError("Inference request id is required.")
    messages = normalized_messages(request.get("messages"))
    rendered = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    encoded = tokenizer(rendered, return_tensors="pt")
    context_window_tokens = request_context_window_tokens(request)
    input_tokens_before, input_tokens_dropped = left_truncate_encoded_input(encoded, context_window_tokens)
    max_new_tokens = max(1, min(512, int(request.get("maxNewTokens") or 128)))
    temperature = float(request.get("temperature") or 0.0)
    repetition_penalty = max(0.5, min(2.0, float(request.get("repetitionPenalty") or 1.0)))
    no_repeat_ngram_size = max(0, min(10, int(request.get("noRepeatNgramSize") or 0)))
    fixture_completion = fixture_protocol_completion(messages) if fixture_mode else None
    if fixture_completion is not None:
        emit({"id": request_id, "type": "delta", "text": fixture_completion})
        completion_tokens = len(tokenizer(fixture_completion, add_special_tokens=False).input_ids)
        emit({
            "id": request_id,
            "type": "complete",
            "usage": {
                "prompt_tokens": int(encoded["input_ids"].shape[-1]),
                "completion_tokens": completion_tokens,
                "total_tokens": int(encoded["input_ids"].shape[-1]) + completion_tokens,
                "input_tokens_before": input_tokens_before,
                "input_tokens_dropped": input_tokens_dropped,
                "context_window_tokens": context_window_tokens,
            },
        })
        return
    do_sample = temperature > 0
    streamer = TextIteratorStreamer(tokenizer, skip_prompt=True, skip_special_tokens=True)
    error: list[BaseException] = []

    def run_generation() -> None:
        try:
            generation_options: dict[str, Any] = {
                "streamer": streamer,
                "max_new_tokens": max_new_tokens,
                "do_sample": do_sample,
                "pad_token_id": tokenizer.pad_token_id,
                "eos_token_id": tokenizer.eos_token_id,
            }
            if do_sample:
                generation_options["temperature"] = temperature
            if repetition_penalty != 1.0:
                generation_options["repetition_penalty"] = repetition_penalty
            if no_repeat_ngram_size > 0:
                generation_options["no_repeat_ngram_size"] = no_repeat_ngram_size
            with torch.inference_mode():
                model.generate(
                    **encoded,
                    **generation_options,
                )
        except BaseException as exc:  # pragma: no cover - surfaced through the protocol
            error.append(exc)
            streamer.on_finalized_text("", stream_end=True)

    thread = threading.Thread(target=run_generation, daemon=True)
    thread.start()
    completion = ""
    for text in streamer:
        completion += text
        if text:
            emit({"id": request_id, "type": "delta", "text": text})
    thread.join()
    if error:
        raise error[0]
    completion_tokens = len(tokenizer(completion, add_special_tokens=False).input_ids)
    emit({
        "id": request_id,
        "type": "complete",
        "usage": {
            "prompt_tokens": int(encoded["input_ids"].shape[-1]),
            "completion_tokens": completion_tokens,
            "total_tokens": int(encoded["input_ids"].shape[-1]) + completion_tokens,
            "input_tokens_before": input_tokens_before,
            "input_tokens_dropped": input_tokens_dropped,
            "context_window_tokens": context_window_tokens,
        },
    })


def serve(args: argparse.Namespace) -> int:
    model, tokenizer = load_runtime(args)
    emit({"type": "ready", "modelId": args.model_id})
    for line in sys.stdin:
        if not line.strip():
            continue
        request_id = ""
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ContractError("Inference request must be an object.")
            request_id = str(request.get("id") or "")
            generate(request, model, tokenizer, fixture_mode=args.base_model_id == "openpond/tiny-cpu-gpt2-fixture")
        except BaseException as exc:
            emit({"id": request_id, "type": "error", "error": str(exc)})
    return 0


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="openpond-inference")
    result.add_argument("--model-id", required=True)
    result.add_argument("--model-path")
    result.add_argument("--adapter-path", required=True)
    result.add_argument("--base-model-id", required=True)
    result.add_argument("--base-model-revision", required=True)
    result.add_argument("--chat-template-hash", required=True)
    return result


def fixture_protocol_completion(messages: list[dict[str, str]]) -> str | None:
    """Deterministic native-tool smoke for the tiny test-only CPU fixture model."""
    if not any(message["role"] == "system" and "LOCAL TOOL PROTOCOL" in message["content"] for message in messages):
        return None
    has_tool_result = False
    for message in messages:
        if message["role"] != "user":
            continue
        try:
            parsed = json.loads(message["content"])
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict) and parsed.get("type") == "tool_result":
            has_tool_result = True
            break
    if has_tool_result:
        return "ANSWER: {}"
    return json.dumps({
        "type": "tool_call",
        "id": "fixture_search_crm_1",
        "name": "search_crm",
        "arguments": {
            "query": "*",
            "fields": ["account_id", "renewal_date", "tier"],
            "cursor": None,
            "limit": 10,
        },
    }, ensure_ascii=False, separators=(",", ":"))


def main() -> None:
    args = parser().parse_args()
    try:
        raise SystemExit(serve(args))
    except BaseException as exc:
        print(str(exc), file=sys.stderr, flush=True)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
