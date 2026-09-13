// THE keyboard hook for every screen component. Ink's `useInput` delivers a
// keypress to every active handler at once, so a dialog asking "trash this?"
// on top of /resume would also hand the keystroke to the list beneath it.
// App wraps whatever a dialog covers in `<InputGate.Provider value={false}>`,
// and this hook goes inactive there. Components never think about it: they
// import useInput from here instead of from ink, and a dialog owns the keys
// for as long as it is up.
import { useInput as inkUseInput } from 'ink';
import { createContext, useContext } from 'react';

type Handler = Parameters<typeof inkUseInput>[0];
type Options = NonNullable<Parameters<typeof inkUseInput>[1]>;

/** true = keys reach the components under it; false = a dialog has them. */
export const InputGate = createContext(true);

export function useInput(handler: Handler, options: Options = {}): void {
  const open = useContext(InputGate);
  inkUseInput(handler, { ...options, isActive: open && (options.isActive ?? true) });
}
