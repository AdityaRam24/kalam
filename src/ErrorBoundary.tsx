import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Without this, any render-phase throw unmounts the whole app and leaves a
 * blank white page with no clue what happened. A cluster visualizer reads a lot
 * of shapes it does not control, so it needs somewhere to land.
 */
export default class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Trinetra crashed while rendering:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          padding: 32,
          fontFamily: 'Outfit, system-ui, sans-serif',
          color: '#e2e8f0',
          background: '#0f172a',
          minHeight: '100vh',
        }}
      >
        <h1 style={{ fontSize: 20, marginBottom: 8 }}>Trinetra hit a rendering error</h1>
        <p style={{ color: '#94a3b8', marginBottom: 16, maxWidth: 640 }}>
          The interface stopped instead of going blank. The details below are also in the
          browser console.
        </p>
        <pre
          style={{
            background: 'rgba(15, 23, 42, 0.6)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 8,
            padding: 12,
            fontSize: 12,
            overflowX: 'auto',
            marginBottom: 16,
          }}
        >
          {error.message}
          {error.stack ? `\n\n${error.stack}` : ''}
        </pre>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '8px 16px',
            borderRadius: 6,
            border: '1px solid #01a781',
            background: 'rgba(1, 167, 129, 0.12)',
            color: '#01a781',
            cursor: 'pointer',
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
