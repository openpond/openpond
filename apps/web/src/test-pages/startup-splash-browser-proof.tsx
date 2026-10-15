import { lazy, StrictMode, Suspense, useState, type Dispatch, type SetStateAction } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { AppSplash } from "../components/splash/AppSplash";
import { AppStartupBoundary, useAppStartupProgress } from "../components/splash/AppStartupBoundary";
import { appStartupState, type AppStartupState } from "../startup/app-startup";
import "../styles/theme.css";
import "../styles/base.css";
import "../styles/splash/app-splash.css";

// Protect the lifecycle boundary that used to remount the splash halfway through
// its reveal. Open /test-pages/startup-splash-browser-proof.html in dev.
const host = document.getElementById("root")!;
const result = document.getElementById("result")!;
const root = createRoot(host);
let updateStartup: Dispatch<SetStateAction<AppStartupState>>;
let finishLoadingCode: () => void;
let retryCount = 0;

function Runtime() {
  const [startup, setStartup] = useState(() => appStartupState("account"));
  updateStartup = setStartup;
  useAppStartupProgress(startup);
  return startup.ready ? <div id="ready">OpenPond ready</div> : null;
}

const DeferredRuntime = lazy(() => new Promise<{ default: typeof Runtime }>(resolve => {
  finishLoadingCode = () => resolve({ default: Runtime });
}));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitFor(check: () => boolean) {
  const deadline = performance.now() + 10_000;
  while (!check()) {
    assert(performance.now() < deadline, "Startup did not reach the expected state.");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function verify() {
  flushSync(() => root.render(
    <StrictMode>
      <AppStartupBoundary>
        <Suspense fallback={null}><DeferredRuntime /></Suspense>
      </AppStartupBoundary>
    </StrictMode>,
  ));
  const splash = host.querySelector("main");
  assert(splash, "Code loading must show the splash.");
  await waitFor(() => host.querySelectorAll(".app-splash-letter").length >= 3);
  const beforeHandoff = host.querySelectorAll(".app-splash-letter").length;
  const firstLetter = host.querySelector(".app-splash-letter");
  finishLoadingCode();
  await waitFor(() => splash.getAttribute("aria-label") === appStartupState("account").label);
  assert(host.querySelector("main") === splash, "Loading app code must preserve the splash instance.");
  assert(host.querySelector(".app-splash-letter") === firstLetter, "Existing letters must survive the handoff.");
  assert(host.querySelectorAll(".app-splash-letter").length >= beforeHandoff, "The reveal must never move backward.");
  await waitFor(() => host.querySelectorAll(".app-splash-letter").length === 8);
  flushSync(() => updateStartup({
    ...appStartupState("account"), error: "Account unavailable", retry: () => {
      retryCount += 1;
      updateStartup({ ...appStartupState("account"), retrying: true });
    },
  }));
  const retry = host.querySelector("button");
  assert(retry, "Startup failures must keep recovery available.");
  flushSync(() => retry.click());
  assert(retryCount === 1 && !host.querySelector("button"), "Retry must reach the current runtime and clear recovery.");
  assert(host.querySelector("main") === splash, "Recovery must preserve the completed reveal.");
  flushSync(() => updateStartup(appStartupState("ready")));
  assert(!host.querySelector("main") && host.querySelector("#ready"), "Readiness must replace the splash with the app in one commit.");
  // Leave a full-size preview for visual review after the lifecycle assertions.
  flushSync(() => root.render(<AppSplash startup={appStartupState("connecting")} />));
  result.textContent = "PASS: StrictMode, lazy code handoff, continuous letters, recovery, retry, and readiness.";
  result.dataset.status = "passed";
}

void verify().catch(error => {
  result.textContent = `FAIL: ${error instanceof Error ? error.message : String(error)}`;
  result.dataset.status = "failed";
});
