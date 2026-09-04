// The error boundary: a throw while drawing one region of the screen must not
// take the app down. React unmounts the WHOLE tree on a render throw unless a
// boundary catches it, and Ink then exits the process — which is what a bad
// row in one list did (2026-09-03: a label with no length in the session
// list, and a running turn died with it). Vim and emacs keep running when a
// command fails and print the error where messages go; this is React's one
// mechanism for the same behavior.
//
// It does two things and nothing else: the stack goes to console.error (the
// app redirects that to ~/.phantom-cli/cli.log), and `onError` hands the
// message to the caller, who puts it where the app's messages go (a note in
// the conversation) and closes the region. The region draws NOTHING while
// broken — no notice of its own, the note is the notice — and comes back when
// `resetKey` changes (the menu closes, the view changes, the session
// switches). It never retries by itself: the same data would throw the same
// way, and a reset loop is worse than a blank region.
import { Component, type ReactNode } from 'react';

export class Boundary extends Component<{
  /** Where the error is written: the region's name, for the log line. */
  name: string;
  /** The message, for the app's message channel. Called once per throw. */
  onError: (message: string) => void;
  /** Changing this clears the error and draws the children again. */
  resetKey?: unknown;
  children: ReactNode;
}, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error): { error: Error } { return { error }; }

  override componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    console.error(`[${new Date().toISOString()}] ${this.props.name} failed: ${error.stack ?? String(error)}${info.componentStack ?? ''}`);
    this.props.onError(`${error.name}: ${error.message}`);
  }

  override componentDidUpdate(prev: { resetKey?: unknown }): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  override render(): ReactNode {
    return this.state.error ? null : this.props.children;
  }
}
