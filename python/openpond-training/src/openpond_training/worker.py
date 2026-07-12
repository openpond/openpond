from __future__ import annotations

import argparse
from contextlib import redirect_stdout
import hashlib
import json
import os
import random
import shutil
import signal
import sys
import tempfile
import time
import resource
from pathlib import Path
from typing import Any

import numpy as np
import torch
from datasets import Dataset
from transformers import TrainerCallback
from trl import SFTConfig, SFTTrainer

from .artifacts import build_artifact_manifest, validate_artifact_manifest
from .contracts import ContractError, load_bundle
from .events import EventWriter
from .fixture_model import (
    BASE_MODEL_ID,
    BASE_MODEL_REVISION,
    TOKENIZER_REVISION,
    construct_fixture,
    lora_config,
    reload_adapter,
    render_record,
)


class Cancelled(RuntimeError):
    pass


class CancellationCallback(TrainerCallback):
    def __init__(self, cancel_file: Path | None, writer: EventWriter, wall_time_ms: int, memory_bytes: int) -> None:
        self.cancel_file = cancel_file
        self.writer = writer
        self.deadline = time.monotonic() + wall_time_ms / 1000
        self.memory_bytes = memory_bytes
        self.cancelled = False
        self.resource_error: str | None = None

    def on_step_end(self, args, state, control, **kwargs):  # type: ignore[no-untyped-def]
        self.writer.emit("progress", {"step": int(state.global_step), "maxSteps": int(state.max_steps), "memoryBytes": current_max_rss_bytes()})
        if time.monotonic() >= self.deadline:
            self.resource_error = "Training worker exceeded its declared wall-time limit."
            control.should_training_stop = True
        if current_max_rss_bytes() > self.memory_bytes:
            self.resource_error = "Training worker exceeded its declared memory limit."
            control.should_training_stop = True
        if self.cancelled or (self.cancel_file and self.cancel_file.exists()):
            control.should_training_stop = True
        return control


def run(args: argparse.Namespace) -> int:
    bundle_directory = Path(args.bundle).resolve()
    output_directory = Path(args.output).resolve()
    output_directory.mkdir(parents=True, exist_ok=True)
    writer = EventWriter(args.job_id, sys.stdout, output_directory / "events.jsonl")
    cancellation: CancellationCallback | None = None

    def request_cancel(_signum: int, _frame: Any) -> None:
        if cancellation is not None:
            cancellation.cancelled = True

    signal.signal(signal.SIGTERM, request_cancel)
    signal.signal(signal.SIGINT, request_cancel)
    writer.emit("start", {"workerVersion": "0.0.1", "nonProduction": True, "device": "cpu"})
    temporary_directory = Path(tempfile.mkdtemp(prefix="openpond-training-"))
    try:
        manifest, recipe, records = load_bundle(bundle_directory)
        if os.environ.get("OPENPOND_TRAINING_INJECT_FAILURE") == "1":
            raise RuntimeError("Injected worker failure.")
        optimizer = recipe["optimizer"]
        limits = recipe["resourceLimits"]
        cancellation = CancellationCallback(Path(args.cancel_file).resolve() if args.cancel_file else None, writer, int(limits["wallTimeMs"]), int(limits["memoryBytes"]))
        seed = int(optimizer["seed"])
        random.seed(seed)
        np.random.seed(seed)
        torch.manual_seed(seed)
        torch.set_num_threads(max(1, min(int(limits["cpuThreads"]), os.cpu_count() or 1)))
        model, tokenizer, template_hash = construct_fixture(records, seed)
        expected_hash = recipe["baseModel"]["chatTemplateHash"]
        if expected_hash not in {template_hash, "fixture00000000"}:
            raise ContractError(f"Chat template hash mismatch: expected {expected_hash}, constructed {template_hash}.")
        text_records = [{"text": render_record(record)} for record in records]
        dataset = Dataset.from_list(text_records)
        sample = tokenizer(text_records[0]["text"], return_tensors="pt", truncation=True, max_length=int(recipe["dataset"]["maxSequenceLength"]))
        with torch.no_grad():
            before_logits = model(**sample).logits.detach().clone()
        config = SFTConfig(
            output_dir=str(temporary_directory / "trainer"),
            max_steps=int(optimizer["maxSteps"]),
            num_train_epochs=float(optimizer["epochs"]),
            per_device_train_batch_size=int(optimizer["batchSize"]),
            gradient_accumulation_steps=int(optimizer["gradientAccumulationSteps"]),
            learning_rate=float(optimizer["learningRate"]),
            logging_strategy="no",
            save_strategy="no",
            report_to="none",
            disable_tqdm=True,
            use_cpu=True,
            seed=seed,
            dataset_text_field="text",
            max_length=int(recipe["dataset"]["maxSequenceLength"]),
        )
        trainer = SFTTrainer(
            model=model,
            args=config,
            train_dataset=dataset,
            processing_class=tokenizer,
            peft_config=lora_config(recipe),
            callbacks=[cancellation],
        )
        with redirect_stdout(sys.stderr):
            result = trainer.train()
        if cancellation.resource_error:
            raise RuntimeError(cancellation.resource_error)
        if cancellation.cancelled or (cancellation.cancel_file and cancellation.cancel_file.exists()):
            raise Cancelled("Training was cancelled.")
        adapter_directory = output_directory / "adapter"
        trainer.model.save_pretrained(adapter_directory, safe_serialization=True)
        tokenizer.save_pretrained(output_directory / "tokenizer")
        reloaded, reloaded_tokenizer, reloaded_template_hash = reload_adapter(adapter_directory, records, seed)
        reload_sample = reloaded_tokenizer(text_records[0]["text"], return_tensors="pt", truncation=True, max_length=int(recipe["dataset"]["maxSequenceLength"]))
        with torch.no_grad():
            after_logits = reloaded(**reload_sample).logits.detach()
        logit_delta = float(torch.max(torch.abs(before_logits - after_logits)).item())
        adapter_parameters = [parameter.detach() for name, parameter in reloaded.named_parameters() if "lora_" in name]
        adapter_nonzero = any(bool(torch.any(parameter != 0).item()) for parameter in adapter_parameters)
        if not adapter_parameters or not adapter_nonzero or logit_delta <= 0:
            raise RuntimeError("LoRA smoke failed: adapter parameters or logits did not change.")
        metrics = {"trainLoss": float(result.training_loss), "steps": int(result.global_step), "logitDelta": logit_delta, "adapterParameterCount": sum(parameter.numel() for parameter in adapter_parameters)}
        (output_directory / "metrics.json").write_text(json.dumps(metrics, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        writer.emit("metric", metrics)
        if args.taskset:
            run_frozen_evaluation(
                taskset_path=Path(args.taskset).resolve(),
                model=reloaded,
                tokenizer=reloaded_tokenizer,
                output_path=output_directory / "frozen-eval-predictions.jsonl",
                seed=seed,
            )
        tokenizer_hash = hashlib.sha256(reloaded_tokenizer.backend_tokenizer.to_str().encode("utf-8")).hexdigest()
        artifact_manifest = build_artifact_manifest(job_id=args.job_id, output_directory=output_directory, base_model_id=BASE_MODEL_ID, base_revision=BASE_MODEL_REVISION, tokenizer_revision=TOKENIZER_REVISION, tokenizer_hash=tokenizer_hash, chat_template_hash=reloaded_template_hash, metadata={"bundleHash": manifest["contentHash"], "recipeHash": manifest["recipeHash"], "seed": seed, "reloadVerified": True, **metrics})
        writer.emit("complete", {"artifactManifest": str(output_directory / "artifact-manifest.json"), "artifactCount": len(artifact_manifest["artifacts"]), "nonProduction": True})
        return 0
    except Cancelled as error:
        writer.emit("cancel", {"message": str(error)})
        return 130
    except Exception as error:
        writer.emit("failure", {"errorType": type(error).__name__, "message": str(error)[:20000]})
        return 1
    finally:
        shutil.rmtree(temporary_directory, ignore_errors=True)


def current_max_rss_bytes() -> int:
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(value if sys.platform == "darwin" else value * 1024)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="openpond-training")
    result.add_argument("command", choices=["run", "evaluate"], nargs="?", default="run")
    result.add_argument("--bundle", required=True)
    result.add_argument("--output", required=True)
    result.add_argument("--job-id", required=True)
    result.add_argument("--cancel-file")
    result.add_argument("--taskset")
    return result


def evaluate(args: argparse.Namespace) -> int:
    bundle_directory = Path(args.bundle).resolve()
    output_directory = Path(args.output).resolve()
    output_directory.mkdir(parents=True, exist_ok=True)
    writer = EventWriter(args.job_id, sys.stdout, output_directory / "events.jsonl")
    writer.emit("start", {"workerVersion": "0.0.1", "nonProduction": True, "device": "cpu", "mode": "manual_import_evaluation"})
    try:
        bundle_manifest, recipe, records = load_bundle(bundle_directory)
        artifact_manifest = validate_artifact_manifest(output_directory)
        expected = recipe["baseModel"]
        actual = artifact_manifest.get("baseModel", {})
        if actual.get("id") != expected["id"] or actual.get("revision") != expected["revision"]:
            raise ContractError("Imported adapter base model does not match the Training Plan.")
        if artifact_manifest.get("tokenizerRevision") != expected["tokenizerRevision"]:
            raise ContractError("Imported adapter tokenizer revision does not match the Training Plan.")
        expected_template = expected["chatTemplateHash"]
        actual_template = artifact_manifest.get("chatTemplateHash")
        if expected_template != "fixture00000000" and actual_template != expected_template:
            raise ContractError("Imported adapter chat-template hash does not match the Training Plan.")
        seed = int(recipe["optimizer"]["seed"])
        model, tokenizer, template_hash = reload_adapter(output_directory / "adapter", records, seed)
        if not args.taskset:
            raise ContractError("Manual import evaluation requires a frozen Taskset.")
        run_frozen_evaluation(taskset_path=Path(args.taskset).resolve(), model=model, tokenizer=tokenizer, output_path=output_directory / "frozen-eval-predictions.jsonl", seed=seed)
        writer.emit("metric", {"reloadVerified": True, "frozenEvaluationExecuted": True})
        tokenizer_hash = hashlib.sha256(tokenizer.backend_tokenizer.to_str().encode("utf-8")).hexdigest()
        rebuilt = build_artifact_manifest(job_id=args.job_id, output_directory=output_directory, base_model_id=BASE_MODEL_ID, base_revision=BASE_MODEL_REVISION, tokenizer_revision=TOKENIZER_REVISION, tokenizer_hash=tokenizer_hash, chat_template_hash=template_hash, metadata={"bundleHash": bundle_manifest["contentHash"], "recipeHash": bundle_manifest["recipeHash"], "seed": seed, "reloadVerified": True, "manualImport": True})
        writer.emit("complete", {"artifactManifest": str(output_directory / "artifact-manifest.json"), "artifactCount": len(rebuilt["artifacts"]), "nonProduction": True, "manualImport": True})
        return 0
    except Exception as error:
        writer.emit("failure", {"errorType": type(error).__name__, "message": str(error)[:20000]})
        return 1


def run_frozen_evaluation(*, taskset_path: Path, model, tokenizer, output_path: Path, seed: int) -> None:  # type: ignore[no-untyped-def]
    taskset = json.loads(taskset_path.read_text(encoding="utf-8"))
    rows = []
    model.eval()
    for task in taskset.get("tasks", []):
        if task.get("split") != "frozen_eval":
            continue
        prompt = str(task.get("input", {}).get("prompt", ""))
        encoded = tokenizer(f"<user> {prompt} <eos> <assistant>", return_tensors="pt", truncation=True, max_length=96)
        with torch.no_grad():
            generated = model.generate(**encoded, max_new_tokens=16, do_sample=False, pad_token_id=tokenizer.pad_token_id)
        completion = tokenizer.decode(generated[0][encoded["input_ids"].shape[1]:], skip_special_tokens=True).strip()
        rows.append({"taskId": task["id"], "seed": seed, "output": {"text": completion}})
    output_path.write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in rows), encoding="utf-8")


def main() -> None:
    args = parser().parse_args()
    raise SystemExit(evaluate(args) if args.command == "evaluate" else run(args))


if __name__ == "__main__":
    main()
