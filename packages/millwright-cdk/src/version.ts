// Kept in lockstep with package.json by scripts/set-version.mjs — do not edit by hand.
export const VERSION = '0.2.0';

/**
 * Highest run-model schemaVersion this control plane accepts. Synth fails
 * loud when a repo's definition library emits a newer schema.
 */
export const SUPPORTED_SCHEMA_VERSION = 1;
