import type { SpecificationStore } from "../application/ports.js";
import type { SpecificationRecord } from "../domain/specification.js";

/**
 * Process-local store with optimistic concurrency. A second writer that started
 * from an older revision is rejected instead of silently overwriting the
 * workflow state.
 */
export function createInMemorySpecificationStore(
  seed: ReadonlyArray<SpecificationRecord> = [],
): SpecificationStore {
  const records = new Map<string, SpecificationRecord>(
    seed.map((record) => [record.specId, structuredClone(record)]),
  );

  return {
    async create(record) {
      if (records.has(record.specId)) return false;
      records.set(record.specId, structuredClone(record));
      return true;
    },
    async findById(specId) {
      const record = records.get(specId);
      return record === undefined ? null : structuredClone(record);
    },
    async save(record, expectedRevision) {
      const current = records.get(record.specId);
      if (current === undefined || current.revision !== expectedRevision) {
        return false;
      }
      records.set(record.specId, structuredClone(record));
      return true;
    },
  };
}
