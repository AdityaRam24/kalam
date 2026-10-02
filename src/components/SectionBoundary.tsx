import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Contain a render failure to the view it happened in.
 *
 * The app-level boundary replaces EVERYTHING with an error page, which made one
 * bad object anywhere in the cluster cost the user the whole console. Wrapped
 * around each page and around the topology map, this keeps navigation and every
 * other view alive, says which view failed and why, and lets the user retry or
 * copy the details. `resetKey` clears the error automatically when the thing
 * the view depends on changes (another page, another source).
 */
interface Props {
  /** Shown in the message: "The <name> hit an error". */
  name: string;
  /** When this changes, a previous error is cleared and the view re-mounts. */
  resetKey?: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
  stack: string;
  attempt: number;
  copied: boolean;
  lastKey?: string;
}

export default class SectionBoundary extends Component<Props, State> {
  state: State = { error: null, stack: '', attempt: 0, copied: false, lastKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.lastKey) {
      return { lastKey: props.resetKey, error: null, stack: '', attempt: state.attempt + 1 };
    }
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ stack: info.componentStack || '' });
    console.error(`[${this.props.name}] render failed:`, error, info.componentStack);
  }

  private details(): string {
    const { error, stack } = this.state;
    return [
      `View: ${this.props.name}`,
      `When: ${new Date().toISOString()}`,
      `Error: ${error?.message}`,
      '',
      error?.stack || '',
      '',
      'Component stack:',
      stack.trim(),
    ].join('\n');
  }

  render() {
    const { error, attempt, copied } = this.state;
    if (!error) return <div key={attempt} style={{ display: 'contents' }}>{this.props.children}</div>;

    return (
      <div className="panel-card" role="alert" style={{ borderLeft: '4px solid var(--status-error)' }}>
        <div className="panel-card-title">
          <h2 style={{ color: 'var(--status-error)' }}>The {this.props.name} hit an error</h2>
        </div>
        <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          Only this view stopped — everything else keeps working. This usually means one object in the
          data had a shape the view did not expect. <strong>Try again</strong> re-draws it from the current
          data; if it keeps happening, <strong>Copy details</strong> and send them along.
        </p>
        <pre style={{
          margin: '0 0 12px', padding: 10, borderRadius: 6, fontSize: 12, maxHeight: 160, overflow: 'auto',
          background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', whiteSpace: 'pre-wrap',
        }}>
          {error.message}
        </pre>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" onClick={() => this.setState({ error: null, stack: '', attempt: attempt + 1 })}>
            Try again
          </button>
          <button
            className="btn secondary"
            onClick={() => {
              navigator.clipboard?.writeText(this.details())
                .then(() => { this.setState({ copied: true }); setTimeout(() => this.setState({ copied: false }), 1500); })
                .catch(() => {});
            }}
          >
            {copied ? 'Copied' : 'Copy details'}
          </button>
        </div>
      </div>
    );
  }
}
