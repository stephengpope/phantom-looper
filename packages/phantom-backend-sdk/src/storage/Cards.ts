// Cards — the cards table's one owner, and card revisions. Addressed by
// project and number (PHA-7 is card 7, never reused). Every write lands on
// BoardEvents. Stub.
export interface CardRow {
  id: number; projectId: string; number: number; title: string; body: string | null;
  status: string; items: RequirementItem[]; pinned: boolean; archived: boolean;
  createdAt: Date; updatedAt: Date;
}
export interface RequirementItem { key: string; text: string; done: boolean }
export type RequirementOp = { op: 'add'; text: string } | { op: 'remove' | 'check' | 'uncheck'; key: string };
export type CardFields = Partial<Pick<CardRow, 'title' | 'body' | 'status' | 'pinned' | 'archived'>>;
export interface CardRevision { id: number; cardId: number; changedFrom: Partial<CardRow>; by: string | null; at: Date }

export class Cards {
  async byNumber(projectId: string, number: number): Promise<CardRow | undefined> { throw stub(); }
  async list(projectId: string, options?: { archived?: boolean; statuses?: string[] }): Promise<CardRow[]> { throw stub(); }
  async listArchived(projectId: string, page: { limit: number; before?: Date }): Promise<{ cards: CardRow[]; total: number }> { throw stub(); }
  async create(projectId: string, fields: CardFields & { title: string }, by?: string): Promise<CardRow> { throw stub(); }
  /** Fields and/or requirement ops in one write, one revision. */
  async update(projectId: string, number: number, fields: CardFields, items?: RequirementOp[], by?: string): Promise<CardRow> { throw stub(); }
  async remove(projectId: string, number: number): Promise<void> { throw stub(); }
  async revisions(projectId: string, number: number, limit: number): Promise<CardRevision[]> { throw stub(); }
  /** When the card last changed column. */
  async lastMovedAt(projectId: string, number: number): Promise<Date | null> { throw stub(); }
}
const stub = () => new Error('stub');
