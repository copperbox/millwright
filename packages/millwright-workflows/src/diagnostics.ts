/** One synth-time finding: a hard error or an advisory lint. */
export interface Diagnostic {
  readonly level: 'error' | 'warning';
  /** Stable machine-readable code, e.g. `image-unresolved`. */
  readonly code: string;
  readonly message: string;
  readonly workflow?: string;
  readonly job?: string;
}

export function formatDiagnostic(d: Diagnostic): string {
  const where = d.workflow ? ` [${d.workflow}${d.job ? `/${d.job}` : ''}]` : '';
  return `${d.level}[${d.code}]${where} ${d.message}`;
}

/** Thrown by `synthesize` when any error-level diagnostic fires. */
export class SynthError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[]) {
    const errors = diagnostics.filter((d) => d.level === 'error');
    super(
      `Synth failed with ${errors.length} error${errors.length === 1 ? '' : 's'}:\n` +
        errors.map((d) => `  ${formatDiagnostic(d)}`).join('\n'),
    );
    this.name = 'SynthError';
    this.diagnostics = diagnostics;
  }

  get errors(): readonly Diagnostic[] {
    return this.diagnostics.filter((d) => d.level === 'error');
  }

  get warnings(): readonly Diagnostic[] {
    return this.diagnostics.filter((d) => d.level === 'warning');
  }
}
