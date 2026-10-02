// ModelCatalog — models.dev as this server holds it for every client: the
// models per provider, the newest one, a model's context window. A live
// fetch at boot, the shipped snapshot as the fallback. Stub.
export interface CatalogModel { id: string; name: string; releaseDate: string; contextWindow: number; reasoning: boolean }

export class ModelCatalog {
  /** Load: live from models.dev, else the snapshot. */
  async load(): Promise<void> { throw stub(); }
  async refresh(): Promise<void> { throw stub(); }
  providers(): string[] { throw stub(); }
  hasProvider(provider: string): boolean { throw stub(); }
  modelsFor(provider: string): CatalogModel[] { throw stub(); }
  /** The newest model id for a provider, or null. */
  latestFor(provider: string | null): string | null { throw stub(); }
  contextWindowOf(provider: string, model: string): number { throw stub(); }
  /** Where the catalog came from. */
  source(): 'live' | 'snapshot' { throw stub(); }
}
const stub = () => new Error('stub');
