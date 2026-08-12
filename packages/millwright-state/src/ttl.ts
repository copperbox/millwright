import { REGISTRY_PARTITION_PREFIX } from './keys';

/**
 * TTL attribute on the state table: epoch seconds. Set on every item EXCEPT
 * `REG#` registry rows, which are configuration indexes, not run history —
 * they are refreshed by every successful synth and must never age out.
 */
export const TTL_ATTRIBUTE = 'expiresAt';

/** Run/job metadata retention default (`retention.metadata`). */
export const DEFAULT_METADATA_RETENTION_DAYS = 90;

/** Event dedupe / processing records expire after 30 minutes (spec §7.1). */
export const EVENT_DEDUPE_TTL_SECONDS = 30 * 60;

const SECONDS_PER_DAY = 24 * 60 * 60;

/** Epoch-seconds TTL value for an item written at `nowMs`, kept `days` days. */
export function expiresAtAfterDays(nowMs: number, days: number): number {
  return expiresAtAfterSeconds(nowMs, days * SECONDS_PER_DAY);
}

export function expiresAtAfterSeconds(nowMs: number, seconds: number): number {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new Error(`nowMs must be a non-negative epoch-milliseconds value, got ${nowMs}`);
  }
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`TTL seconds must be positive, got ${seconds}`);
  }
  return Math.floor(nowMs / 1000) + Math.round(seconds);
}

/** Whether an item is TTL-exempt by partition (`REG#` registry rows only). */
export function isTtlExempt(pk: string): boolean {
  return pk.startsWith(REGISTRY_PARTITION_PREFIX);
}

/**
 * Stamp the metadata-retention TTL onto an item. Throws on `REG#` rows so the
 * TTL exemption is enforced in code, not by caller discipline.
 */
export function withMetadataTtl<T extends { readonly pk: string }>(
  item: T,
  nowMs: number,
  retentionDays: number = DEFAULT_METADATA_RETENTION_DAYS,
): T & { expiresAt: number } {
  if (isTtlExempt(item.pk)) {
    throw new Error(
      `Registry rows are TTL-exempt configuration indexes; refusing to stamp ${TTL_ATTRIBUTE} ` +
        `on "${item.pk}"`,
    );
  }
  return { ...item, [TTL_ATTRIBUTE]: expiresAtAfterDays(nowMs, retentionDays) };
}
