/**
 * Version of the run model this definition library emits at synth.
 *
 * Compatibility contract: the deployed control plane accepts run models with
 * `schemaVersion` less than or equal to its own supported version, and synth
 * fails loud otherwise. Bump only when the run-model shape changes.
 */
export const SCHEMA_VERSION = 1;
