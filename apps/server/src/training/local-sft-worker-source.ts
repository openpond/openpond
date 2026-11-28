export const localSftPythonCommon = String.raw`
import hashlib
import json
import math
import sys
from contextlib import contextmanager, redirect_stdout


class CheckFailed(Exception):
    def __init__(self, status, **details):
        self.report = {"status": status, **details}


@contextmanager
def reserve_device(lock):
    import fcntl
    with open(lock, "a") as lease:
        try:
            fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise CheckFailed("device_busy") from error
        yield


def tokenize_approved_rows(inputs, tokenizer, model_config):
    template = tokenizer.chat_template
    if not isinstance(template, str) or hashlib.sha256(template.encode()).hexdigest() != inputs["chatTemplateHash"]:
        raise CheckFailed("checkpoint_mismatch")
    if not tokenizer.is_fast:
        raise CheckFailed("tokenizer_incompatible")
    training_data = inputs["trainingData"]
    if hashlib.sha256(training_data.encode()).hexdigest() != inputs["trainingDataHash"]:
        raise CheckFailed("probe_failed")
    rows = [json.loads(line) for line in training_data.rstrip("\n").split("\n")]
    if len(rows) != inputs["rowCount"]:
        raise CheckFailed("probe_failed")

    limit = inputs["recipe"]["dataset"]["maxSequenceLength"]
    for ceiling in (getattr(model_config, "max_position_embeddings", None), tokenizer.model_max_length):
        if isinstance(ceiling, int) and ceiling > 0:
            limit = min(limit, ceiling)
    marker = "OPENPOND_TARGET_" + inputs["trainingDataHash"]
    token_hash = hashlib.sha256()
    encoded = []
    completion_tokens = 0
    for row in rows:
        question = row["input"]["prompt"]
        target = row["expectedOutput"]["text"]
        try:
            prefix, rendered = render_completion(tokenizer, question, target, marker)
            tokens = tokenizer(rendered, add_special_tokens=False, truncation=False, return_offsets_mapping=True)
        except Exception as error:
            raise CheckFailed("tokenizer_incompatible", rowId=row["id"]) from error
        ids = tokens["input_ids"]
        if len(ids) > limit:
            raise CheckFailed("example_too_long", rowId=row["id"])
        boundary = len(prefix)
        offsets = tokens["offset_mapping"]
        # Tokenizers can merge the template's space before an answer into its
        # first token. A crossing token that contains any preceding text is unusable.
        if len(ids) != len(offsets) or any(start < boundary < end and not rendered[start:boundary].isspace()
                                            for start, end in offsets):
            raise CheckFailed("tokenizer_incompatible", rowId=row["id"])
        labels = [token if end > boundary and end > start else -100
                  for token, (start, end) in zip(ids, offsets)]
        count = sum(label != -100 for label in labels[1:])
        if not count or labels[0] != -100:
            raise CheckFailed("tokenizer_incompatible", rowId=row["id"])
        encoded.append((ids, labels))
        completion_tokens += count
        token_hash.update(json.dumps([row["id"], ids, labels], separators=(",", ":")).encode())
        token_hash.update(b"\n")
    return encoded, {
        "rowCount": len(encoded),
        "maximumTokens": max(len(ids) for ids, _ in encoded),
        "completionTokens": completion_tokens,
        "tokenizationHash": token_hash.hexdigest(),
    }


def render_completion(tokenizer, question, target, marker):
    messages = [{"role": "user", "content": question}, {"role": "assistant", "content": marker}]
    probe = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=False)
    if probe.count(marker) != 1:
        raise ValueError("The chat template did not preserve the assistant content.")
    prefix, suffix = probe.split(marker)
    messages[1]["content"] = target
    rendered = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=False)
    if rendered != prefix + target + suffix and rendered != prefix + target.strip() + suffix:
        raise ValueError("The chat template changed the expected assistant boundary.")
    return prefix, rendered


def load_tokenizer(inputs):
    from transformers import AutoConfig, AutoTokenizer
    directory = inputs["modelDirectory"]
    try:
        config = AutoConfig.from_pretrained(directory, local_files_only=True, trust_remote_code=False)
        tokenizer = AutoTokenizer.from_pretrained(directory, local_files_only=True, trust_remote_code=False, use_fast=True)
    except (ValueError, OSError, TypeError) as error:
        raise CheckFailed("tokenizer_incompatible") from error
    return tokenizer, config


def load_trainable_model(inputs, device, dtype):
    import torch
    from peft import LoraConfig, TaskType, get_peft_model
    from transformers import AutoModelForCausalLM

    model, loading = AutoModelForCausalLM.from_pretrained(
        inputs["modelDirectory"], local_files_only=True, trust_remote_code=False,
        use_safetensors=True, torch_dtype=dtype, output_loading_info=True, device_map={"": str(device)},
    )
    if any(loading.get(key) for key in ("missing_keys", "mismatched_keys", "unexpected_keys", "error_msgs")):
        raise CheckFailed("checkpoint_mismatch")
    model.config.use_cache = False
    adapter = inputs["recipe"]["lora"]
    targets = adapter["targetModules"]
    if len(set(targets)) != len(targets) or not all(name.isidentifier() for name in targets):
        raise CheckFailed("lora_incompatible")
    matched = set()
    for name, module in model.named_modules():
        last = name.rsplit(".", 1)[-1]
        if last in targets:
            if not isinstance(module, torch.nn.Linear) or adapter["rank"] > min(module.in_features, module.out_features):
                raise CheckFailed("lora_incompatible")
            matched.add(last)
    if matched != set(targets):
        raise CheckFailed("lora_incompatible")
    return get_peft_model(model, LoraConfig(
        task_type=TaskType.CAUSAL_LM, target_modules=targets, r=adapter["rank"],
        lora_alpha=adapter["alpha"], lora_dropout=adapter["dropout"], bias="none",
    ))


def optimizer_for(model, recipe):
    import torch
    return torch.optim.AdamW((param for param in model.parameters() if param.requires_grad), lr=recipe["optimizer"]["learningRate"])


def backward_once(model, ids, labels, attention_mask, weight=1):
    import torch
    loss = model(input_ids=ids, labels=labels, attention_mask=attention_mask).loss
    value = loss.item()
    if not math.isfinite(value):
        raise CheckFailed("nonfinite_loss")
    (loss * weight).backward()
    if any(param.grad is not None and not torch.isfinite(param.grad).all().item() for param in model.parameters()):
        raise CheckFailed("nonfinite_loss")
    return value


def prepare_inputs(inputs):
    try:
        import torch
        import peft
        import accelerate
        import safetensors
        import transformers
    except Exception:
        raise CheckFailed("dependencies_missing")
    recipe = inputs["recipe"]
    torch.set_num_threads(recipe["resourceLimits"]["cpuThreads"])
    tokenizer, config = load_tokenizer(inputs)
    rows, token_report = tokenize_approved_rows(inputs, tokenizer, config)
    return tokenizer, rows, token_report


def select_cuda(inputs, token_report):
    import torch

    if not torch.version.cuda or not torch.cuda.is_available():
        raise CheckFailed("cuda_unavailable", tokens=token_report)
    ordinal, (free, capacity) = max(
        ((index, torch.cuda.mem_get_info(index)) for index in range(torch.cuda.device_count())),
        key=lambda item: item[1][0],
    )
    budget = min(free, inputs["recipe"]["resourceLimits"]["memoryBytes"])
    if budget <= 0:
        raise CheckFailed("insufficient_memory", tokens=token_report)
    device = torch.device("cuda", ordinal)
    torch.cuda.set_device(device)
    torch.cuda.set_per_process_memory_fraction(budget / capacity, device)
    torch.cuda.reset_peak_memory_stats(device)
    return device, {
        "ordinal": ordinal, "name": torch.cuda.get_device_name(device),
        "capacityBytes": capacity, "freeBytes": free, "budgetBytes": budget,
    }


def observe_cuda(device, capacity):
    import torch

    torch.cuda.synchronize(device)
    used = max(torch.cuda.max_memory_reserved(device), capacity["freeBytes"] - torch.cuda.mem_get_info(device)[0])
    if used > capacity["budgetBytes"]:
        raise CheckFailed("insufficient_memory")
    return {**capacity, "usedBytes": used}


def exercise(inputs, rows, token_report, device, capacity):
    import torch

    recipe = inputs["recipe"]
    try:
        torch.manual_seed(recipe["optimizer"]["seed"])
        model = load_trainable_model(inputs, device, torch.float16)
        model.train()
        optimizer = optimizer_for(model, recipe)
        # Every row uses its full tokenization. Repeating the longest one
        # exercises the largest padded batch and allocates the AdamW states.
        longest_ids, longest_labels = max(rows, key=lambda row: len(row[0]))
        batch_size = min(len(rows), recipe["optimizer"]["batchSize"])
        ids = torch.tensor(longest_ids, dtype=torch.long, device=device).repeat(batch_size, 1)
        labels = torch.tensor(longest_labels, dtype=torch.long, device=device).repeat(batch_size, 1)
        attention_mask = torch.ones_like(ids)
        # Measure again with AdamW state and gradient buffers already resident.
        controls = recipe["optimizer"]
        passes = 2 if controls["maxSteps"] > 1 or controls["gradientAccumulationSteps"] > 1 else 1
        for _ in range(passes):
            optimizer.zero_grad(set_to_none=False)
            backward_once(model, ids, labels, attention_mask)
            optimizer.step()
        report = observe_cuda(device, capacity)
    except torch.OutOfMemoryError as error:
        raise CheckFailed("insufficient_memory", tokens=token_report) from error
    except CheckFailed as error:
        error.report.setdefault("tokens", token_report)
        raise
    return report


def preflight(inputs):
    _, rows, tokens = prepare_inputs(inputs)
    device, capacity = select_cuda(inputs, tokens)
    return {"status": "ready", "tokens": tokens, "device": exercise(inputs, rows, tokens, device, capacity)}
`;


export const localSftWorkerSource = localSftPythonCommon + String.raw`
if __name__ == "__main__":
    with redirect_stdout(sys.stderr):
        try:
            inputs = json.load(sys.stdin)
            with reserve_device(inputs["deviceLock"]):
                report = preflight(inputs)
        except CheckFailed as error:
            report = error.report
        except Exception:
            report = {"status": "probe_failed"}
    print(json.dumps(report))
`;
