# DeepSeek Streaming Wait For User

Sandbox template for a chat-agent lifecycle smoke. It calls DeepSeek V4 Flash
through a sandbox secret env ref, streams response deltas into artifacts, marks
the workspace waiting for user input, and emits a checkpoint hint when no reply
arrives before the wait timeout.

Validate locally:

```bash
openpond sandbox-template validate --file openpond.yaml
```

Create an OpenPond sandbox app repo for tagging from normal chat:

```bash
openpond repo create --name deepseek-v4-flash-sandbox-template --path . --empty --sandbox --yes
git add .
git commit -m "Add DeepSeek sandbox template"
openpond repo push --path . --branch master
```

Run a live smoke with a saved sandbox secret:

```bash
openpond sandbox-template start --file openpond.yaml --env-ref DEEPSEEK_API_KEY_SANDBOX=openpond://secret/... --env-literal DEEPSEEK_LIVE=1 --runtime-mode attempt --runtime-base-branch master --runtime-promotion-policy manual --budget-usd 0.05
```

For staging, set `OPENPOND_API_URL=https://api.staging-api.openpond.ai` and pass `--env staging` explicitly.
