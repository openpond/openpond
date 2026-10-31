# Fix-it capture

Fix-it saves bounded tool-error records in one ordinary private saved dataset per owner and workspace. All of that owner's connected agents contribute to this dataset. It is pinned first in the dataset library and uses the normal dataset read, edit and retention controls. Collection does not activate training.

Existing conversation-history and authored-folder imports remain available through the secondary dataset controls. Folder import opens the native folder picker or a dedicated path panel instead of displaying an import field on every dataset screen.

Open the Fix-it connections screen, choose a coding agent and copy its setup prompt into the workspace you want to connect. Setup reuses your existing OpenPond account and home, asks for the actual application context and permitted tool names, registers a scoped capture installation and installs the integration. Saved records remain until removed; raw capture buffers have separate bounded retention.

| Client | Integration | Qualified version |
| --- | --- | --- |
| Claude Code | Workspace tool hooks; restart after installing | 2.1.292 |
| OpenCode | Project plugin; restart after installing | 1.14.48 |
| Codex CLI | Installed `openpond-fix-it` skill and captured CLI launcher | 0.153.4 |
| OpenPond | Built-in tool observer | Installed OpenPond release |

Codex CLI capture uses native structured execution events, including actual process exit codes. Its hook output alone does not expose these codes. Launch a fresh captured task with the installed skill or:

```sh
openpond tool-learning run <installation-id> --home <existing-openpond-home> --prompt 'Your task'
```

Optional `--model <available-model>` selects a Codex model. Optional `--sandbox read-only|workspace-write` selects the normal Codex sandbox. Otherwise Codex's existing configuration applies. This connection observes shell commands in tasks launched through this command; it does not observe arbitrary Codex desktop chats. It preserves Codex authentication and permissions. OpenCode and Codex connections currently capture evidence only; they do not install specialist consultation.

Use `openpond tool-learning doctor <installation-id> --home <existing-openpond-home>` to check the installed integration, observed lifecycle, queue and remote state. Use `flush` to retry queued uploads. Disabling or uninstalling capture stops future collection and preserves saved dataset records. Reinstall and uninstall preserve user-modified files. A client version change requires qualifying the adapter again.

The dataset count and current detail refresh as uploads arrive. An open editor retains its local work; concurrent saves still use normal revision checks. Captured failures have no reference answer or training approval. A later successful command remains separate evidence until reviewed and explicitly linked.

Captured task rows show the agent, tool, capture time and a readable error preview. Open a captured task to see its tool action, full observed error, execution status and training permission. The full saved record remains available in the inspector. A capture being assigned to the train split does not grant training permission or activate a specialist.

For an opted-in learning policy, the Model's continual-learning view refreshes its saved state automatically. A prepared run waiting for admission shows its waiting reason and next check time. Waiting does not use execution failure retries. Cancellation remains available while a run waits; training starts only after the normal approval, funding and execution gates pass.
