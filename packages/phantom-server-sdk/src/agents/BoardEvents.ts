// BoardEvents — a project's live feed of card writes, whoever wrote. Stub.
export type BoardEvent = { event: 'card'; card: Record<string, unknown>; from?: string; by?: string };

export class BoardEvents {
  publish(projectId: string, event: BoardEvent): void { throw stub(); }
  subscribe(projectId: string, listener: (event: BoardEvent) => void): () => void { throw stub(); }
  subscribeAll(listener: (projectId: string, event: BoardEvent) => void): () => void { throw stub(); }
}
const stub = () => new Error('stub');
