// The base of every one-shot model call outside an agent loop — session
// titles, commit messages, digests, compaction summaries. A subclass is
// named for what it is — `class TitleHelper extends PhantomHelper` — and
// that name, read here at construction, is what its call is billed to
// (kindOf). The two rules every model call follows are written once: the
// model comes from `languageModel()` (which records the tokens — see
// createAgent.ts), and `maxRetries: 0` (the retry loop is ours, in the
// fetch, never the SDK's).
import { generateText } from 'ai';
import { languageModel, kindOf, type ModelConfig, type TokenKind } from './createAgent.js';

export abstract class PhantomHelper {
  readonly kind: TokenKind;

  /** `sessionId`: the session the call serves; null for one serving none. */
  constructor(private readonly model: ModelConfig, private readonly sessionId: string | null) {
    this.kind = kindOf(new.target.name);
  }

  /** One model call, billed to this helper. Subclasses build the request
   *  from their own input and call this. */
  protected async call(req: { system?: string; prompt: string; maxTokens?: number | null }): Promise<string> {
    const { text } = await generateText({
      model: languageModel({ ...this.model, usage: { kind: this.kind, sessionId: this.sessionId } }),
      maxRetries: 0,
      ...(req.system ? { system: req.system } : {}),
      prompt: req.prompt,
      ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}),
    });
    return text;
  }
}
