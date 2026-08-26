import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

const App = lazy(() => import("./App").then((module) => ({ default: module.App })));

window.addEventListener("error", (event) => {
  void window.openpond?.logRendererError?.({
    type: "error",
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    error: event.error instanceof Error ? { name: event.error.name, message: event.error.message, stack: event.error.stack } : null,
  });
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  void window.openpond?.logRendererError?.({
    type: "unhandledrejection",
    reason: reason instanceof Error ? { name: reason.name, message: reason.message, stack: reason.stack } : String(reason),
  });
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <Suspense fallback={null}>
        <App />
      </Suspense>
    </ErrorBoundary>
  </StrictMode>
);
