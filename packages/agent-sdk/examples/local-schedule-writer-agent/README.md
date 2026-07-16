# Local Schedule Writer Agent

This example validates the local in-process scheduler. The scheduled action appends one JSON line to `artifacts/local-cron-writes.log` every five minutes while the OpenPond app server is running.

Run it manually with:

```bash
node ../../dist/cli.js run write-tick --json --cwd .
```
