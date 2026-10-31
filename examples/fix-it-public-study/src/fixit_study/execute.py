"""Bounded baseline episodes and correction-source evidence using tau2 itself."""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import time
import uuid
from pathlib import Path

from filelock import FileLock

from .assets import fetch_data
from .budget import BudgetStop, CALL_CONTEXT, CallBudget, PRICING, NANO_USD, meter_tau2, model_rate, nano_usd, reservation_units
from .plan import SELECTION_SHA256, SOURCE_COMMIT, selected_tasks, verify_upstream
from .traces import ToolTrace, digest


def write_json(path: Path, value: dict | list) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def read_plan(path: Path, expected_hash: str) -> dict:
    if path.stat().st_size > 10 * 1024 * 1024:
        raise ValueError("Study plan exceeds 10 MiB")
    plan = json.loads(path.read_bytes())
    content = {key: value for key, value in plan.items() if key != "planSha256"}
    actual = hashlib.sha256(json.dumps(content, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    if actual != plan.get("planSha256") or actual != expected_hash:
        raise ValueError("Confirm the exact retained study plan hash")
    if plan.get("schemaVersion") != "openpond.fixitPublicStudyPlan.v1" or plan.get("sourceCommit") != SOURCE_COMMIT or plan.get("selectionSha256") != SELECTION_SHA256:
        raise ValueError("The plan does not belong to the pinned study")
    if plan.get("split") == "test":
        raise ValueError("Held-out episodes require a frozen qualified comparison; baseline collection cannot run test tasks")
    return plan


def run_baseline(args) -> dict:
    verify_upstream()
    raw_plan = read_plan(args.plan, args.confirm_plan_sha256)
    _, selected = selected_tasks(raw_plan["split"])
    assets = fetch_data(args.data_dir)
    from tau2.data_model.benchmark import BenchmarkPlan
    from tau2.runner.batch import _load_run_tasks
    from tau2.runner.build import build_text_orchestrator
    from tau2.runner.presets import prepare_plan
    from tau2.runner.simulation import run_simulation

    configs = []
    for raw in raw_plan["plans"]:
        plan = BenchmarkPlan.model_validate(raw)
        plan = prepare_plan(plan, args.output / "upstream")
        if len(plan.configs) != 1:
            raise ValueError("Expected one English domain per plan")
        config = plan.configs[0]
        if config.language != "en" or config.domain not in selected or set(config.task_ids or []) != set(selected[config.domain]):
            raise ValueError("Execution selection differs from the declared partition")
        if config.num_trials != 1 or config.effective_agent != "llm_agent" or config.max_steps > 100:
            raise ValueError("Unexpected baseline agent, trial count or step limit")
        allowed = {"reasoning_effort", "temperature", "seed", "max_tokens", "max_completion_tokens"}
        if any(set(settings) - allowed for settings in [config.llm_args_agent, config.llm_args_user]):
            raise ValueError("Use only frozen generation settings; credentials/endpoints do not belong in plans")
        model_rate(config.llm_agent)
        model_rate(config.llm_user)
        config = config.model_copy(update={"max_retries": 0, "timeout": args.episode_timeout,
                                           "max_concurrency": 1, "workers": 0, "auto_review": False})
        configs.append(config)
    if {config.domain for config in configs} != set(selected) or len(configs) != len(selected):
        raise ValueError("Missing or repeated study domain")
    runtime_files = {item.name: hashlib.sha256(item.read_bytes()).hexdigest()
                     for item in Path(__file__).parent.glob("*.py")}
    protocol = {"schemaVersion": "openpond.fixitBaselineProtocol.v1", "planSha256": raw_plan["planSha256"],
                "sourceCommit": SOURCE_COMMIT, "split": raw_plan["split"], "arm": "baseline",
                "maximumSpendUsd": args.max_spend, "maxOutputTokens": args.max_output_tokens,
                "episodeTimeoutSeconds": args.episode_timeout, "localResponseCache": False,
                "attemptsPerEpisode": 1, "automaticProviderRetries": 0,
                "runtimeSha256": digest(runtime_files), "dependencyLockSha256": hashlib.sha256(args.lock_file.read_bytes()).hexdigest(),
                "criticalPackages": {name: importlib.metadata.version(name) for name in ["tau2", "litellm", "openai", "pydantic", "httpx"]},
                "pricing": PRICING, "assetVerification": assets,
                "configs": [config.model_dump(mode="json") for config in configs]}
    protocol["contentHash"] = digest(protocol)
    minimum_reservation = max(reservation_units(rate, args.max_output_tokens) for rate in PRICING["models"].values())
    if nano_usd(args.max_spend) < minimum_reservation:
        raise ValueError("The approved limit cannot fund the conservative full-context reservation for one call")
    args.output.mkdir(parents=True, exist_ok=True, mode=0o700)
    with FileLock(args.output / ".run.lock", timeout=0):
        protocol_path = args.output / "protocol.json"
        if protocol_path.exists():
            if json.loads(protocol_path.read_bytes()) != protocol:
                raise ValueError("This run is bound to a different immutable protocol")
        else:
            write_json(protocol_path, protocol)
        if args.prepare_only:
            return {"prepared": True, "protocolHash": protocol["contentHash"], "split": raw_plan["split"],
                    "declaredTaskCount": raw_plan["taskCount"], "maximumSpendUsd": args.max_spend,
                    "largestPerCallReservationUsd": str(minimum_reservation / NANO_USD),
                    "inferenceExecuted": False}
        if args.confirm_protocol_sha256 != protocol["contentHash"]:
            raise ValueError("Confirm the exact prepared protocol hash before paid execution")
        budget = CallBudget(args.output / "costs.sqlite3", args.max_spend)
        rows = []
        stopped = False
        try:
            with meter_tau2(budget, args.max_output_tokens):
                # Domain round-robin interleaves source collection rather than
                # exhausting one domain before the others. The sealed IDs remain unchanged.
                loaded = {config.domain: {task.id: task for task in _load_run_tasks(config)} for config in configs}
                if any(set(loaded[domain]) != set(ids) for domain, ids in selected.items()):
                    raise ValueError("Upstream task loading expanded or dropped the declared selection")
                for index in range(max(map(len, selected.values()))):
                    for config in configs:
                        ids = selected[config.domain]
                        if index >= len(ids):
                            continue
                        task_id = ids[index]
                        identity = {"split": raw_plan["split"], "arm": "baseline", "domain": config.domain, "taskId": task_id}
                        key = digest(identity)[:32]
                        directory = args.output / key
                        directory.mkdir(exist_ok=True, mode=0o700)
                        result_path = directory / "episode.json"
                        if result_path.exists():
                            rows.append(json.loads(result_path.read_bytes()))
                            continue
                        if (directory / "tool-events.jsonl").exists():
                            raise BudgetStop("Interrupted episode retained; inspect its original evidence before any replay")
                        if stopped:
                            rows.append({**identity, "status": "not_started_budget_or_uncertainty"})
                            continue
                        trace = ToolTrace(directory / "tool-events.jsonl", identity)
                        started = time.monotonic()
                        token = CALL_CONTEXT.set(identity)
                        try:
                            task = loaded[config.domain][task_id]
                            orchestrator = build_text_orchestrator(config, task, seed=config.seed,
                                                                   simulation_id=key)
                            trace.attach(orchestrator)
                            simulation = run_simulation(orchestrator)
                            write_json(directory / "simulation.json", simulation.model_dump(mode="json"))
                            stopped = budget.has_uncertain()
                            row = {**identity, "status": "unscored_model_request_uncertainty" if stopped else "scored" if simulation.reward_info is not None else "unscored",
                                   "rewardInfo": simulation.reward_info.model_dump(mode="json") if simulation.reward_info else None,
                                   "elapsedSeconds": time.monotonic()-started, "toolEvidence": trace.summary()}
                        except Exception as error:
                            stopped = isinstance(error, BudgetStop) or budget.has_uncertain()
                            row = {**identity, "status": "stopped_budget_or_uncertainty" if stopped else "unscored_execution_failure",
                                   "exceptionType": type(error).__name__, "elapsedSeconds": time.monotonic()-started,
                                   "toolEvidence": trace.summary()}
                        finally:
                            CALL_CONTEXT.reset(token)
                        write_json(result_path, row)
                        if raw_plan["split"] == "correction_source":
                            write_json(directory / "review-candidates.json", trace.review_candidates())
                        rows.append(row)
                        write_json(args.output / "costs.json", budget.summary())
            report = {"schemaVersion": "openpond.fixitBaselineRun.v1", "protocolHash": protocol["contentHash"],
                      "split": raw_plan["split"], "declaredTaskCount": raw_plan["taskCount"], "episodes": rows,
                      "costs": budget.summary(), "comparisonExecuted": False, "savingsMeasured": False}
            write_json(args.output / "report.json", report)
            return report
        finally:
            write_json(args.output / "costs.json", budget.summary())
            budget.close()
