#!/usr/bin/env python3
"""Read deployed backend logs through gcloud without changing its saved profile.

Example:
  python3 scripts/read-staging-logs.py --project PROJECT --namespace NAMESPACE \
    --start 2026-11-18T14:30:00-05:00 --end 2026-11-18T15:00:00-05:00 \
    --output /tmp/staging-logs.json

An empty result only means this query matched no retained Cloud Logging entries.
It does not establish whether a Work turn used a sandbox. Correlate turn/tool
events and provider records separately when reviewing execution.
"""

import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def timestamp(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("Include a timezone offset or Z")
        return parsed.astimezone(timezone.utc)
    except ValueError as error:
        raise argparse.ArgumentTypeError(str(error)) from error


def iso(value):
    return value.isoformat().replace("+00:00", "Z")


def quoted(value):
    return json.dumps(value)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project", required=True)
    parser.add_argument("--namespace", help="Kubernetes namespace; selects k8s_container logs")
    parser.add_argument("--cluster", help="Optional Kubernetes cluster")
    parser.add_argument("--filter", help="Additional Cloud Logging filter, combined with the time/scope filters")
    parser.add_argument("--start", type=timestamp, default=datetime.now(timezone.utc) - timedelta(hours=2))
    parser.add_argument("--end", type=timestamp, default=datetime.now(timezone.utc))
    parser.add_argument("--limit", type=int, default=1000)
    parser.add_argument("--timeout", type=int, default=55, help="Maximum gcloud runtime in seconds")
    parser.add_argument("--output", type=Path, required=True, help="New private JSON evidence file")
    args = parser.parse_args()
    if args.start >= args.end:
        parser.error("--start must precede --end")
    if not 1 <= args.limit <= 10000 or not 1 <= args.timeout <= 60:
        parser.error("--limit must be 1..10000 and --timeout must be 1..60")
    if args.cluster and not args.namespace:
        parser.error("--cluster requires --namespace")
    if not args.namespace and not args.filter:
        parser.error("Provide --namespace or an explicit --filter to scope the backend read")
    clauses = [f"timestamp >= {quoted(iso(args.start))}", f"timestamp <= {quoted(iso(args.end))}"]
    if args.namespace:
        clauses.extend(['resource.type="k8s_container"', f"resource.labels.namespace_name={quoted(args.namespace)}"])
    if args.cluster:
        clauses.append(f"resource.labels.cluster_name={quoted(args.cluster)}")
    if args.filter:
        clauses.append(f"({args.filter})")
    query = " AND ".join(clauses)
    executable = shutil.which("gcloud")
    if not executable:
        parser.error("gcloud is not installed")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Refuse existing paths and symlinks, including on an unsuccessful read.
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    report = {"observedAt": iso(datetime.now(timezone.utc)), "readOnly": True,
              "project": args.project, "query": query, "limit": args.limit,
              "status": "failed", "entries": []}
    code = 1
    try:
        # gcloud refreshes its SQLite credential cache even during read commands.
        # Use its existing profile in an ephemeral private directory so read-only
        # host configuration works, without implementing a separate auth flow.
        config = Path(os.environ.get("CLOUDSDK_CONFIG", str(Path.home() / ".config/gcloud")))
        with tempfile.TemporaryDirectory(prefix="openpond-log-read-") as directory:
            private_config = Path(directory) / "gcloud"
            shutil.copytree(config, private_config, ignore=shutil.ignore_patterns("logs", "*.lock"))
            environment = {**os.environ, "CLOUDSDK_CONFIG": str(private_config),
                           "CLOUDSDK_CORE_DISABLE_FILE_LOGGING": "true",
                           "CLOUDSDK_CORE_DISABLE_PROMPTS": "1"}
            command = [executable, "logging", "read", query, f"--project={args.project}",
                       f"--limit={args.limit}", "--order=asc", "--format=json", "--quiet"]
            result = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=args.timeout)
            if result.returncode:
                # Provider diagnostics stay in the private evidence, not stdout.
                failure = "gcloud_failed"
                if "NameResolutionError" in result.stderr or "Failed to resolve" in result.stderr:
                    failure = "network_dns_unavailable"
                report.update(error=failure, exitCode=result.returncode, diagnostic=result.stderr)
            else:
                entries = json.loads(result.stdout)
                if not isinstance(entries, list):
                    raise ValueError("gcloud returned an unexpected response")
                report.update(status="complete", entries=entries, count=len(entries),
                              reachedLimit=len(entries) >= args.limit)
                code = 0
    except subprocess.TimeoutExpired:
        report.update(error="gcloud_timeout", timeoutSeconds=args.timeout)
    except (OSError, ValueError) as error:
        report.update(error=type(error).__name__, diagnostic=str(error))
    finally:
        with os.fdopen(descriptor, "w") as stream:
            json.dump(report, stream, indent=2)
            stream.write("\n")
    print(json.dumps({"status": report["status"], "count": report.get("count"),
                      "reachedLimit": report.get("reachedLimit"), "error": report.get("error"),
                      "output": str(args.output.resolve())}))
    return code


if __name__ == "__main__":
    sys.exit(main())
