/**
 * Explicit opt-out sentinel for `MillwrightProps.permissionsBoundary`.
 *
 * `permissionsBoundary` is required because it is the only cap on what
 * repo-editable workflow definitions can request. Passing `Boundary.NONE`
 * deploys without one; the construct emits a synth-time warning so the risk
 * stays visible in the file the operator wrote.
 */
export class Boundary {
  static readonly NONE = new Boundary();

  private constructor() {}
}
