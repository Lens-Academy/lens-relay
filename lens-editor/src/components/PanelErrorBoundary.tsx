import { Component, type ReactNode } from 'react';

interface Props {
  /** What failed, for the fallback line ("Concept relationships"). */
  name: string;
  /** A new key (the opened document) tries again. */
  resetKey: string;
  children: ReactNode;
}

interface State {
  failed: boolean;
  key: string;
}

/**
 * Keeps a panel's crash inside the panel: without it, an error while
 * rendering a panel at the top of the editor unmounts the whole app.
 */
export class PanelErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.key ? null : { failed: false, key: props.resetKey };
  }

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error(`${this.props.name} panel failed:`, error);
  }

  render() {
    return this.state.failed
      ? (
        <div className="mb-3 mt-1 rounded-md border border-gray-200 bg-gray-50/70 px-2 py-1.5 text-xs text-gray-500" role="status">
          {this.props.name} could not be shown.{' '}
          <button type="button" className="cursor-pointer underline" onClick={() => this.setState({ failed: false })}>
            Retry
          </button>
        </div>
      )
      : this.props.children;
  }
}
