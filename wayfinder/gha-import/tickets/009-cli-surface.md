---
id: "009"
title: CLI surface
type: wayfinder:grilling
status: open
assignee: none
blocked-by: ["005", "008"]
---

## Question

What is the exact `millwright import` command surface, and how does it behave?

Charting fixed placement (Note 7): a command in `@copperbox/millwright-cli`, alongside
`init / synth / setup / repo / doctor / run / dispatch / runs / logs / secrets`. This
ticket pins the surface and the self-verification behavior.

**Arguments and flags**, drawing on the earlier tickets:

- Input selection — the whole `.github/workflows` directory by default? A specific file?
  A glob? Does it work outside a git repo?
- Output path and the overwrite policy from ticket 008.
- Shared-workflow resolution input from ticket 007.
- `--dry-run` — print the report and the would-be file without writing. Given holes
  are expected, this may be the *right default* for a first run.
- The `vars` fetch flag from ticket 004, if it survives.
- Report flags from ticket 005 (`--json`, `--allow-holes`), and the exit-code contract.

**Self-verification** (Note 7): generate → typecheck → `synthesize()` →
`validateRunModel()` → write. Settle the mechanics:

- Typechecking generated TS requires a TS compiler at runtime. Does the CLI already
  carry one (check `definition-loader.ts`, which must already load user TS for `synth`),
  or does this add a dependency? Reusing the existing loader is strongly preferred —
  it also guarantees the importer verifies against the *same* path `millwright synth`
  uses.
- A self-check failure is an **importer bug**, and must be reported differently from a
  hole (ticket 005). What does the user see, and can they recover the file anyway to
  fix it by hand? Refusing to write anything after a long import is hostile; writing
  known-broken code contradicts Note 2. Decide.
- Does `import` verify **before** or **after** writing, given the overwrite policy?

**Integration with `init`.** A new user's path is plausibly `millwright init` then
`millwright import`. Decide whether `init` should offer to import when it detects a
`.github/workflows` directory, or whether that coupling is unwanted — this tool is
disposable and `init` is not.

**Where does the CLI say "you're done with the YAML"?** Nothing in the flow deletes
`.github/workflows`, and running both systems in parallel during cutover is the sane
migration. Decide whether the importer says anything about that at all, or leaves it to
the (fog) migration playbook.
