// CommitMessages — the sync's commit message, written by a model from the
// session's whole staged diff plus the card. Stub.
export class CommitMessages {
  async write(sessionId: string, stat: string, diff: string, cardText: string): Promise<string> { throw stub(); }
}
const stub = () => new Error('stub');
