import { Component, type ErrorInfo, type ReactNode } from "react";

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  error: Error | null;
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    void window.openpond?.logRendererError?.({
      type: "react-error-boundary",
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
      componentStack: info.componentStack,
    });
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="renderer-error-screen">
        <section>
          <h1>OpenPond App hit a renderer error</h1>
          <pre>{this.state.error.message}</pre>
          <button onClick={() => window.location.reload()}>Reload</button>
        </section>
      </main>
    );
  }
}
