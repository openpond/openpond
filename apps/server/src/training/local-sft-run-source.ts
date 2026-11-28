import { localSftPythonCommon } from "./local-sft-worker-source.js";

export const localSftRunSource = localSftPythonCommon + String.raw`
import itertools
import os
import random
import shutil
import threading
import time
from pathlib import Path


def write_status(directory, data):
    temporary = directory / "status.tmp"
    temporary.write_text(json.dumps(data), encoding="utf-8")
    temporary.replace(directory / "status.json")


def train(inputs, tokenizer, rows, device, dtype, checkpoint, update):
    import torch

    recipe = inputs["recipe"]
    controls = recipe["optimizer"]
    torch.manual_seed(controls["seed"])
    model = load_trainable_model(inputs, device, dtype)
    model.train()
    optimizer = optimizer_for(model, recipe)
    pad = tokenizer.pad_token_id
    if pad is None:
        pad = tokenizer.eos_token_id
    if pad is None:
        raise CheckFailed("tokenizer_incompatible")
    batch_size = min(len(rows), controls["batchSize"])
    accumulation = controls["gradientAccumulationSteps"]
    microbatches = math.ceil(math.ceil(len(rows) / batch_size) * controls["epochs"])
    steps = min(controls["maxSteps"], math.ceil(microbatches / accumulation))
    microbatches = min(microbatches, steps * accumulation)
    rng = random.Random(controls["seed"])

    def batches():
        order = list(range(len(rows)))
        while True:
            rng.shuffle(order)
            for offset in range(0, len(rows), batch_size):
                yield [rows[index] for index in order[offset:offset + batch_size]]

    pending = batches()
    update(0, steps)
    for step in range(1, steps + 1):
        optimizer.zero_grad(set_to_none=True)
        group = list(itertools.islice(pending, min(microbatches, accumulation)))
        microbatches -= len(group)
        counts = [sum(label != -100 for _, labels in batch for label in labels[1:]) for batch in group]
        total = sum(counts)
        for batch, count in zip(group, counts):
            checkpoint()
            width = max(len(ids) for ids, _ in batch)
            ids = torch.tensor([ids + [pad] * (width - len(ids)) for ids, _ in batch], dtype=torch.long, device=device)
            labels = torch.tensor([labels + [-100] * (width - len(labels)) for _, labels in batch], dtype=torch.long, device=device)
            mask = torch.tensor([[1] * len(ids) + [0] * (width - len(ids)) for ids, _ in batch], dtype=torch.long, device=device)
            backward_once(model, ids, labels, mask, count / total)
        optimizer.step()
        update(step, steps)
    checkpoint()
    return model


def retain_adapter(model, base, directory, checkpoint):
    import torch
    from safetensors import safe_open

    staging = directory / "adapter.pending"
    staging.mkdir(mode=0o700)
    try:
        config = model.peft_config["default"]
        config.base_model_name_or_path = base["id"]
        config.revision = base["revision"]
        model.save_pretrained(staging, safe_serialization=True, save_embedding_layers=False)
        (staging / "README.md").unlink(missing_ok=True)
        weights = staging / "adapter_model.safetensors"
        with safe_open(weights, framework="pt", device="cpu") as opened:
            if not opened.keys():
                raise CheckFailed("artifact_invalid")
            for key in opened.keys():
                checkpoint()
                if not torch.isfinite(opened.get_tensor(key)).all().item():
                    raise CheckFailed("nonfinite_loss")
        files = {}
        for name in ("adapter_model.safetensors", "adapter_config.json"):
            with (staging / name).open("rb") as artifact:
                digest = hashlib.sha256()
                for chunk in iter(lambda: artifact.read(1024 * 1024), b""):
                    checkpoint()
                    digest.update(chunk)
                files[name] = {"bytes": artifact.tell(), "sha256": digest.hexdigest()}
        checkpoint()
        staging.rename(directory / "adapter")
        return files
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def run_local(inputs):
    os.umask(0o077)
    directory = Path(inputs["runDirectory"])
    deadline = time.monotonic() + inputs["recipe"]["resourceLimits"]["wallTimeMs"] / 1000
    progress = {}
    stat = Path("/proc/self/stat").read_text().rsplit(") ", 1)[1].split()
    process_file = directory / "process.tmp"
    process_file.write_text(json.dumps({
        "pid": os.getpid(), "started": stat[19],
        "boot": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
    }))
    process_file.replace(directory / "process.json")

    def checkpoint():
        if (directory / "cancel").exists():
            raise CheckFailed("cancelled")
        if time.monotonic() >= deadline:
            raise CheckFailed("time_limit")

    def watch():
        while time.monotonic() < deadline + 5:
            if (directory / "cancel").exists():
                time.sleep(10)
                os._exit(125)
            time.sleep(0.5)
        os._exit(124)

    threading.Thread(target=watch, daemon=True).start()
    try:
        with reserve_device(directory.parent.parent / "device.lock"):
            checkpoint()
            tokenizer, rows, tokens = prepare_inputs(inputs)
            import torch
            device, capacity = select_cuda(inputs, tokens)
            exercise(inputs, rows, tokens, device, capacity)
            torch.cuda.empty_cache()

            def update(step, steps):
                checkpoint()
                progress.update(step=step, steps=steps, device=observe_cuda(device, capacity), tokens=tokens)
                write_status(directory, {"status": "running", **progress})

            try:
                model = train(inputs, tokenizer, rows, device, torch.float16, checkpoint, update)
                files = retain_adapter(model, inputs["recipe"]["baseModel"], directory, checkpoint)
            except torch.OutOfMemoryError as error:
                raise CheckFailed("insufficient_memory") from error
            write_status(directory, {"status": "completed", **progress, "files": files})
    except CheckFailed as error:
        reason = error.report["status"]
        write_status(directory, {"status": "cancelled" if reason == "cancelled" else "failed", **progress, "reason": reason})
    except Exception:
        write_status(directory, {"status": "failed", **progress, "reason": "worker_failed"})


if __name__ == "__main__":
    with redirect_stdout(sys.stderr):
        run_local(json.load(sys.stdin))
`;
