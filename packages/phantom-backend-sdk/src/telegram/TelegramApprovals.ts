// TelegramApprovals — the approval gate: a gated tool asks, the user is
// sent a yes/no with buttons, the tool waits for the answer (or the
// signal). One outstanding ask per chat. Stub.
export interface ApprovalAsk { title: string; detail?: string }

export class TelegramApprovals {
  async request(chatId: number, ask: ApprovalAsk, signal?: AbortSignal): Promise<boolean> { throw stub(); }
  hasPending(chatId: number): boolean { throw stub(); }
  /** A button press or a typed yes/no: answers the pending ask. True when it was one. */
  async handleCallback(chatId: number, query: { id: string; data: string }): Promise<boolean> { throw stub(); }
  handleText(chatId: number, text: string): boolean { throw stub(); }
}
const stub = () => new Error('stub');
