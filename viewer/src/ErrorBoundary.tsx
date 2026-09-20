import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Last line of defence: a render error anywhere in the canvas would otherwise
 * unmount the whole tree and leave a white page with nothing but a console trace.
 * Showing what broke — and offering a reload — keeps a bad run's data from looking
 * like a broken install.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null; info?: string }
> {
  state: { error: Error | null; info?: string } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("viewer crashed:", error, info.componentStack);
    this.setState({ info: info.componentStack ?? undefined });
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="vc-empty">
        <h1>Something broke</h1>
        <p>
          <code>{error.message}</code>
        </p>
        <p className="vc-dim">
          This is a bug in the viewer. Reload to try again — the run data on disk is untouched.
        </p>
        <p>
          <button className="vc-chip" onClick={() => location.reload()}>
            Reload
          </button>
        </p>
        {info && <pre className="vc-trace">{info.trim().split("\n").slice(0, 8).join("\n")}</pre>}
      </div>
    );
  }
}
