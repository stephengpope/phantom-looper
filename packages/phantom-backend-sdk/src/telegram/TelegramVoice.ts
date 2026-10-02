// TelegramVoice — speech both directions over Deepgram, the one voice
// vendor: a voice note to text, a reply to spoken audio. Stub.
export class TelegramVoice {
  async transcribe(audio: Buffer): Promise<{ text: string } | { error: 'no_key' | 'too_long' | 'failed' }> { throw stub(); }
  async speak(text: string): Promise<Buffer[]> { throw stub(); }
}
const stub = () => new Error('stub');
