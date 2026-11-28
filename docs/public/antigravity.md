# Google Antigravity

Use Google's official Antigravity runtime inside OpenPond with your Google AI subscription. Google determines the models and limits available to your account. Gemini 4 Neon requires an eligible paid Google AI Pro or Ultra plan; see [Google's model availability](https://antigravity.google/docs/models).

## Connect your Google account

1. Open **Settings → Providers → Google Antigravity → Manage**.
2. Choose **Install Antigravity**. OpenPond downloads the current runtime from Google and verifies its checksum before activating it.
3. Choose **Sign in with Google**, then **Open Google sign-in**.
4. Finish signing in on Google's page. Paste the code, or the final page's full address, into OpenPond and choose **Continue**.
5. Wait for account verification and model discovery. Choose **Gemini 4 Neon** from the available models, then start a chat with Google Antigravity.

You do not need a Gemini API key for this subscription connection. Use the code field even when the browser and OpenPond run on the same computer; the same flow also works when the server runs on another computer. Sign-in links expire, so start a new attempt if necessary.

## Installation and updates

Managed installation supports macOS, Linux and Windows on x64 and ARM64, including musl Linux. Allow several GiB of free disk space for downloading, staging and starting the native runtime. OpenPond requires Antigravity 1.5.12 or newer.

Choose **Check for updates** in the provider's settings, then **Update Antigravity** when offered. A failed download or checksum verification keeps the previous runtime. Running conversations retain their original executable; subsequent processes use the updated runtime.

Installation continues when you close the settings dialog. Reopen **Manage** to check progress. A pending sign-in can also be reopened in the same browser session. After restarting the server, start a fresh sign-in attempt if the previous one was unfinished.

## Accounts and conversations

OpenPond stores this Google login in a dedicated profile in its application home. This connection does not inherit API keys, Google Cloud billing settings or another application's Google login.

Disable the connection to stop its active sessions while keeping the saved Google login. Enable it again to verify access and reload models. **Sign out of Google** stops active sessions and removes the saved login. Sign in again to connect another account; saved conversations and workspace files remain, but conversations tied to the previous account cannot silently resume with a different account.

Use **Refresh** to verify access and reload the models Google's runtime offers to OpenPond. Account checks, model discovery and chat use Google's [Agent Client Protocol integration](https://antigravity.google/docs/cli/acp). If Neon is absent, check the account's plan and Google's current model availability.
