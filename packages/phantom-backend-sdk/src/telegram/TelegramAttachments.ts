// TelegramAttachments — an inbound Telegram file: what it is (image,
// audio, document), what to call it, where it lands in the workspace, and
// the line the agent is told. Stub.
export interface StoredAttachment { hostPath: string; containerPath: string; name: string; type: 'image' | 'audio' | 'video' | 'document'; mime: string | null; bytes: number }

export class TelegramAttachments {
  async store(workspaceId: string, file: { data: Buffer; name?: string; mime?: string }): Promise<StoredAttachment> { throw stub(); }
  /** The user's message with the attachments described for the agent. */
  composeMessage(attachments: StoredAttachment[], userText: string): string { throw stub(); }
}
const stub = () => new Error('stub');
