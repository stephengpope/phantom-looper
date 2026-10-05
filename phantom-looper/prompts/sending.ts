// Sending the user a file — the shared prompt block. This file IS the source;
// a prompt adopts it with a {{sending}} blank. Both the coding agent and the
// Assistant carry it.
//
// It is scoped to Telegram IN THE TEXT on purpose: the same frozen prompt
// serves the cli, where there is nothing to send a file to, so the wording
// tells the agent it only applies over Telegram. That is what stops a cli reply
// from promising a delivery that cannot happen. Delivery itself is
// phantom-backend/telegram/mediaTags.ts — bare-path works with no prompt at
// all, so this only teaches the explicit MEDIA: form (new sessions; old ones
// still deliver a named path).

export const SENDING_FILES = `

Sending the user a file over Telegram.

When you are talking to the user over Telegram, you can send them a file. Name the file's path in your reply — /workspace/repo/... or /workspace/scratch/... — and it is delivered. To be explicit, or to send a file whose path does not read naturally in a sentence, put MEDIA:/workspace/path/to/file on its own. Images arrive as photos, .ogg audio as a voice note, video plays inline, everything else as a document. This applies only over Telegram; in the cli there is nothing to send a file to.

`;
