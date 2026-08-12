/**
 * Package-manager discovery by lockfile (spec §7.2): the install contract is
 * pinned, not guessed. Dependency install exists because "sharing = npm
 * packages" is ticket-decided — the definition may import the repo's own
 * modules and its installed `@copperbox/millwright-workflows`.
 */

export interface InstallPlan {
  readonly file: string;
  readonly args: readonly string[];
  /** Present on the no-lockfile fallback — surfaced as a lint warning. */
  readonly warning?: string;
}

/**
 * `has` answers "does this file exist at the repo root?" — the discovery is
 * root-only by contract (working directory = repo root).
 */
export function installPlan(has: (file: string) => boolean): InstallPlan | undefined {
  if (has('package-lock.json')) {
    return { file: 'npm', args: ['ci'] };
  }
  if (has('pnpm-lock.yaml')) {
    return { file: 'corepack', args: ['pnpm', 'install', '--frozen-lockfile'] };
  }
  if (has('yarn.lock')) {
    return { file: 'corepack', args: ['yarn', 'install', '--frozen-lockfile'] };
  }
  if (has('package.json')) {
    return {
      file: 'npm',
      args: ['install'],
      warning:
        'no lockfile found (package-lock.json, pnpm-lock.yaml or yarn.lock); running ' +
        '"npm install" — the dependency install is not reproducible. Commit a lockfile.',
    };
  }
  // No package.json at all: nothing to install. The definition loader falls
  // back to the synth tooling's own copy of @copperbox/millwright-workflows.
  return undefined;
}
