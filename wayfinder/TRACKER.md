# Millwright issue tracker — local markdown

This repo's issue tracker is plain markdown files under `wayfinder/`, versioned in git.
It exists so planning survives GitHub outages — the very thing millwright is for.

## Wayfinding operations

- **A map** is a `map.md` marked by frontmatter `labels: [wayfinder:map]`, with its
  tickets in a sibling `tickets/` directory. Living in that directory makes them
  children of that map. There may be several maps; each owns its own ticket numbering,
  starting at `001`.

  | Map | Location | Status |
  |---|---|---|
  | millwright v1 | `wayfinder/map.md` + `wayfinder/tickets/` | destination reached |
  | GHA import | `wayfinder/gha-import/map.md` + `wayfinder/gha-import/tickets/` | active |

  The v1 map sits at the `wayfinder/` root for historical reasons; new maps get their
  own subdirectory.
- A ticket's **id** is its `NNN` filename prefix; its **name** is the frontmatter
  `title`. Refer to tickets by name (linking the file), never by bare id. Ids are only
  unique **within** a map — always say which map when an id could be ambiguous.
- **Type** is frontmatter `type: wayfinder:<research|prototype|grilling|task>`.
- **Claiming**: set frontmatter `assignee:` before doing any work. An open ticket with
  `assignee: none` is unclaimed. Concurrent sessions coordinate through git — pull before
  claiming, commit the claim promptly.
- **Blocking** (body convention — no native tracker here): frontmatter
  `blocked-by: ["001", "004"]` lists the ids of blocking tickets. A ticket is unblocked
  when every listed ticket has `status: closed`.
- **Frontier** = tickets with `status: open`, `assignee: none`, and all `blocked-by`
  entries closed. Query:

  ```bash
  # substitute the map's ticket directory
  grep -l 'status: open' wayfinder/gha-import/tickets/*.md | xargs grep -l 'assignee: none'
  ```

  then check each hit's `blocked-by` list by hand (it's short).
- **Resolution**: append a `## Resolution` section to the ticket body (this is the
  resolution comment), set `status: closed`, and add a one-line entry linking the ticket
  to the map's **Decisions so far**.
- **Out of scope**: close the ticket with a `## Resolution` noting it was ruled out of
  scope, and add the one-liner to the map's **Out of scope** section instead of
  Decisions so far.
- **Assets** (research findings, prototypes) are committed on their own branches or files
  and linked from the ticket — never pasted into it.
