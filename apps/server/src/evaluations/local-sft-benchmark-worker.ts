import { localSftPythonCommon } from "../training/local-sft-worker-source.js";

export const localSftBenchmarkWorker = localSftPythonCommon + String.raw`
import fcntl
import os
from pathlib import Path

def generate(inputs):
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM

    for filename, expected in inputs["files"].items():
        artifact = Path(inputs["adapterDirectory"]) / filename
        digest = hashlib.sha256()
        with artifact.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected:
            raise CheckFailed("artifact_changed")

    torch.set_num_threads(2)
    tokenizer, config = load_tokenizer(inputs)
    if not isinstance(tokenizer.chat_template, str) or hashlib.sha256(tokenizer.chat_template.encode()).hexdigest() != inputs["chatTemplateHash"]:
        raise CheckFailed("checkpoint_mismatch")
    ids = tokenizer.apply_chat_template(inputs["messages"], tokenize=True, add_generation_prompt=True, return_tensors="pt", return_dict=False)
    window = min(tokenizer.model_max_length, getattr(config, "max_position_embeddings", 8192))
    if ids.shape[-1] + inputs["maxOutputTokens"] > window:
        raise CheckFailed("context_limit")
    if inputs["device"] == "cuda":
        if not torch.version.cuda or not torch.cuda.is_available():
            raise CheckFailed("cuda_unavailable")
        ordinal = max(range(torch.cuda.device_count()), key=lambda index: torch.cuda.mem_get_info(index)[0])
        device = torch.device("cuda", ordinal)
        free, total = torch.cuda.mem_get_info(device)
        if free < inputs["baseSizeBytes"] * 2:
            raise CheckFailed("insufficient_memory")
        torch.cuda.set_per_process_memory_fraction(free / total, device)
        dtype = torch.float16
    else:
        device = torch.device("cpu")
        dtype = torch.float32
        available = os.sysconf("SC_AVPHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
        if available < inputs["baseSizeBytes"] * 4:
            raise CheckFailed("insufficient_memory")

    model, loading = AutoModelForCausalLM.from_pretrained(
        inputs["modelDirectory"], local_files_only=True, trust_remote_code=False,
        use_safetensors=True, torch_dtype=dtype, output_loading_info=True, device_map={"": str(device)},
    )
    if any(loading.get(key) for key in ("missing_keys", "mismatched_keys", "unexpected_keys", "error_msgs")):
        raise CheckFailed("checkpoint_mismatch")
    adapter = PeftModel.from_pretrained(model, inputs["adapterDirectory"], local_files_only=True).eval()
    # PEFT can report undefined adapter tensors as a warning. Verify every
    # installed tensor against the saved adapter before generating.
    from peft import get_peft_model_state_dict
    from safetensors.torch import load_file
    expected = load_file(str(Path(inputs["adapterDirectory"]) / "adapter_model.safetensors"))
    loaded = get_peft_model_state_dict(adapter)
    if loaded.keys() != expected.keys() or any(not torch.equal(tensor.cpu(), expected[name].to(tensor.dtype)) for name, tensor in loaded.items()):
        raise CheckFailed("adapter_mismatch")
    tensor = ids.to(device)
    pad = tokenizer.pad_token_id if tokenizer.pad_token_id is not None else tokenizer.eos_token_id
    with torch.inference_mode():
        output = adapter.generate(tensor, attention_mask=torch.ones_like(tensor),
            max_new_tokens=inputs["maxOutputTokens"], do_sample=False, num_beams=1,
            temperature=None, top_p=None, top_k=None, pad_token_id=pad)
    completion = output[0, ids.shape[-1]:].tolist()
    return {"status": "completed", "text": tokenizer.decode(completion, skip_special_tokens=True),
            "promptTokens": ids.shape[-1], "completionTokens": len(completion)}

with redirect_stdout(sys.stderr):
    try:
        inputs = json.load(sys.stdin)
        with open(inputs["deviceLock"], "a") as lease:
            fcntl.flock(lease, fcntl.LOCK_EX)
            result = generate(inputs)
    except CheckFailed as error:
        result = error.report
    except Exception:
        result = {"status": "runtime_failed"}
print(json.dumps(result))
`;
