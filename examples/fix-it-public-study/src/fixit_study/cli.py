"""Study planning and bounded baseline/source collection commands."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from . import plan


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] != "run-baseline":
        plan.main()
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["run-baseline"])
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--confirm-plan-sha256", required=True)
    parser.add_argument("--max-spend", required=True)
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--confirm-protocol-sha256")
    parser.add_argument("--max-output-tokens", type=int, default=4096)
    parser.add_argument("--episode-timeout", type=int, default=900)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--lock-file", type=Path, default=Path("uv.lock"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not 512 <= args.max_output_tokens <= 8192 or not 60 <= args.episode_timeout <= 1800:
        parser.error("Use output bounds 512–8192 tokens and episode timeouts 60–1800 seconds")
    os.environ["TAU2_DATA_DIR"] = str(args.data_dir.resolve())
    from .execute import run_baseline
    report = run_baseline(args)
    if report.get("prepared"):
        print(json.dumps(report))
        return
    print(json.dumps({"split": report["split"], "declaredTaskCount": report["declaredTaskCount"],
                      "statuses": [row["status"] for row in report["episodes"]],
                      "actualUsd": report["costs"]["actualUsd"],
                      "unresolvedHeldUsd": report["costs"]["unresolvedHeldUsd"],
                      "comparisonExecuted": False, "savingsMeasured": False}))


if __name__ == "__main__":
    main()
