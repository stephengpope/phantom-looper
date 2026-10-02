// Presets — named snapshots of the model settings a client applies as one
// patch. Stub.
export interface PresetRow { id: string; name: string; values: Record<string, unknown>; createdAt: Date }

export class Presets {
  async list(): Promise<PresetRow[]> { throw stub(); }
  /** Create or overwrite. Only model-subgroup keys are allowed. */
  async save(id: string, name: string, values: Record<string, unknown>): Promise<PresetRow> { throw stub(); }
  async remove(id: string): Promise<void> { throw stub(); }
}
const stub = () => new Error('stub');
