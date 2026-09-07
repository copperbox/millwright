---
id: "008"
title: Generated code shape
type: wayfinder:prototype
status: open
assignee: none
blocked-by: ["003", "004", "006"]
---

## Question

What does the generated `millwright/workflows.ts` actually look like — and is it code a
human wants to inherit?

This is the ticket where the whole map becomes concrete. The output isn't a build
artifact; it's **source the user owns, reviews, edits, and lives in**. It has to read
like something a person wrote.

**Prototype it**: take real `.github/workflows` YAML (this repo's own, or a
representative open-source repo), hand-write the millwright file the importer *should*
have produced, and react to it. The artifact is the discussion.

Decisions to settle from that reaction:

- **File layout** — one `millwright/workflows.ts`, or a file per workflow with a barrel?
  v1's convention is a single `millwright/workflows.ts` entry point; a repo with 20
  GHA workflows makes one file enormous.
- **Naming** — GHA workflow file names and `name:` fields are free-form; TS identifiers
  are not. Sanitization, collisions, and which of the two sources wins.
- **Constants** — the `env:` blocks and `vars.*` placeholders from ticket 004 need a
  home. Top-of-file `const`s, a config object, or inline literals?
- **Comments** — how much provenance to carry. A header naming the source YAML and the
  importer version? Per-job source references? Enough to audit the translation against
  the original; not so much that the file reads as generated sludge.
- **Formatting** — does the importer depend on prettier, ship its own emitter, or
  produce plain text and let the repo's tooling format it?
- **Steps** — GHA multi-line `run:` blocks become... one step with an embedded newline
  string, or several steps? This changes the run view's step granularity and the
  SKIPPED semantics, so it is a real semantic choice, not cosmetics.

**Overwrite policy** — the sharpest open question here, and it touches the map's
"re-import and drift" fog: what happens when `millwright/workflows.ts` already exists?
Refuse, back up, write alongside as `workflows.imported.ts`, or overwrite with `--force`?
Whatever is decided, note the interaction with `millwright init`, which may already
create that file.

Prototype artifact goes under `prototypes/gha-import/`, linked from this ticket.
