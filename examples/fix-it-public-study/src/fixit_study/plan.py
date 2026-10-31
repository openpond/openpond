"""Resolve selected tasks through the upstream released English text bindings.

This command performs no inference, scoring, capture, or training. It emits the
actual upstream plans so selection and asset pins can be reviewed before a run.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
from importlib.resources import files
from pathlib import Path

SOURCE_COMMIT = "989d3285ae669e49503324bdb9981bf14fccedeb"
SELECTION_SHA256 = "b8fe232c76c09218fb6d24c497a9686fa92e2a1fbf7ce6fcfc54ffe5b353e381"
DOMAINS = ("airline", "retail", "telecom")


def selected_tasks(split: str) -> tuple[dict, dict[str, list[str]]]:
    raw = files("fixit_study").joinpath("selection.json").read_bytes()
    if hashlib.sha256(raw).hexdigest() != SELECTION_SHA256:
        raise ValueError("The declared study selection has changed")
    manifest = json.loads(raw)
    if manifest["commit"] != SOURCE_COMMIT:
        raise ValueError("The selection is bound to a different upstream commit")
    for domain in DOMAINS:
        groups = [manifest[key][domain] for key in ("test", "development", "correction_source")]
        joined = [task for group in groups for task in group]
        if len(joined) != len(set(joined)):
            raise ValueError(f"Overlapping study partitions in {domain}")
    key = "development" if split == "development-smoke" else split
    selected = {domain: list(manifest[key][domain]) for domain in DOMAINS}
    if split == "development-smoke":
        selected = {domain: tasks[:1] for domain, tasks in selected.items()}
    expected = {"development-smoke": 3, "development": 6, "correction_source": 12, "test": 20}[split]
    if sum(map(len, selected.values())) != expected:
        raise ValueError("Unexpected selected-task denominator")
    return manifest, selected


def verify_upstream() -> None:
    distribution = importlib.metadata.distribution("tau2")
    origin = json.loads(distribution.read_text("direct_url.json") or "{}")
    if distribution.version != "2.0.0" or origin.get("vcs_info", {}).get("commit_id") != SOURCE_COMMIT:
        raise ValueError("Install the locked tau2 source; its exact upstream commit is required")


def resolve_plan(args: argparse.Namespace) -> dict:
    verify_upstream()
    from tau2.data_model.simulation import TextRunConfig
    from tau2.runner.presets import BenchmarkRequest, resolve_benchmark

    manifest, selection = selected_tasks(args.split)
    plans = []
    for domain, ids in selection.items():
        template = TextRunConfig(
            domain=domain,
            agent="llm_agent",
            llm_agent=args.agent_model,
            llm_args_agent=json.loads(args.agent_args),
            llm_user=args.user_model,
            llm_args_user=json.loads(args.user_args),
            task_ids=ids,
            num_trials=1,
            max_steps=args.max_steps,
            max_errors=10,
            max_concurrency=1,
            seed=args.seed,
        )
        plan = resolve_benchmark(BenchmarkRequest(
            preset="text", template=template, languages=["en"], domains=[domain],
            output=args.output.parent / f"{args.split}-{domain}",
        ))
        if len(plan.configs) != 1:
            raise ValueError("The English single-domain selection expanded unexpectedly")
        config = plan.configs[0]
        if config.language != "en" or config.domain != domain or set(config.task_ids) != set(ids) or len(config.task_ids) != len(ids):
            raise ValueError("Upstream resolved tasks differ from the declared study selection")
        if plan.frame.benchmark_version != manifest["benchmark_version"] or plan.frame.revision != manifest["benchmark_revision"]:
            raise ValueError("The released benchmark frame differs from the study manifest")
        plans.append(plan.model_dump(mode="json"))
    result = {
        "schemaVersion": "openpond.fixitPublicStudyPlan.v1",
        "scope": "custom subset; no official leaderboard score",
        "sourceCommit": SOURCE_COMMIT,
        "selectionSha256": SELECTION_SHA256,
        "split": args.split,
        "taskCount": sum(map(len, selection.values())),
        "inferenceExecuted": False,
        "plans": plans,
    }
    result["planSha256"] = hashlib.sha256(json.dumps(result, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["fetch-data", "plan"])
    parser.add_argument("--split", choices=["development-smoke", "development", "correction_source", "test"], default="development-smoke")
    parser.add_argument("--agent-model")
    parser.add_argument("--user-model")
    parser.add_argument("--agent-args", default="{}")
    parser.add_argument("--user-args", default="{}")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--max-steps", type=int, default=100)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--data-dir", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "fetch-data":
        from .assets import fetch_data
        print(json.dumps(fetch_data(args.data_dir)))
        return
    if not args.agent_model or not args.user_model or args.output is None:
        parser.error("plan requires --agent-model, --user-model and --output")
    # Set the upstream supported data root before importing any tau2 module.
    os.environ["TAU2_DATA_DIR"] = str(args.data_dir.resolve())
    if not 1 <= args.max_steps <= 100:
        parser.error("--max-steps must be within the declared 1–100 bound")
    if args.output.exists():
        parser.error("Choose a new plan output path; retained protocols are not overwritten")
    plan = resolve_plan(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(plan, indent=2) + "\n")
    print(json.dumps({key: plan[key] for key in ("split", "taskCount", "inferenceExecuted", "planSha256")}))


if __name__ == "__main__":
    main()
