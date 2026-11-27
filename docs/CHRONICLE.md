# The Living Fridge Chronicle — Le Frigo Vide

Le Bulletin du Frigo: an event-sourced bulletin of everything that
has passed through your fridge, with ghosts and a Chef's Verdict.

## Event sourcing

The Chronicle reads **only** the `ingredient_events` log, for one
session. Nothing else is a source of truth — not the aggregate
`ingredient_history` counts, not the meals.

Event types:

| Event | Meaning |
|---|---|
| `added` | First sighting of an ingredient in this session (or the first sighting of a new cycle after a fate) |
| `confirmed_present` | Seen again in a later observation |
| `cooked` | The guest rescued it (recorded a `rescued` fate) |
| `discarded` | The guest threw it away (recorded a `discarded` fate) |

Every event carries `session_id`, `ingredient`, `event_type`,
`observation_id` (null for fates), `source` (`live` or
`legacy_migration`), and `created_at` (ISO).

## The observation lifecycle

- **Log Fridge Check** (`POST /api/fridge-check`) is the ONLY call
  that records ingredients. One call = one `observation_id`; each
  ingredient in it logs `added` (first sighting in this session) or
  `confirmed_present`.
- **Ask Chef Jean-Paul** (`POST /api/generate`) logs **nothing**. A
  menu generate never creates an observation, so re-generating the
  same menu can never inflate appearances or manufacture a Ghost.
- **Fates** (`POST /api/ingredients/:name/status`,
  `rescued` / `discarded`) are events too. A fate is recorded only
  when the ingredient was actually observed in this session;
  otherwise the endpoint returns `404`.

**Ghosts.** A Ghost is an active ingredient seen in at least 2
separate observations (`GHOST_MIN_APPEARANCES = 2`).

**Cycles.** Status and appearances are computed on the **current
cycle only**: the cycle starts at the latest `added` event. A fresh
sighting after a fate is a new instance (`added`), not a confirmation
of the old one — so a re-bought spinach is `active` again with 1
appearance in its new cycle. Older cycles stay in the log but no
longer decide the status; otherwise a re-bought spinach would stay
`rescued` forever. First/last seen are the earliest/latest sighting
times in the cycle, not the first/last rows in id order.

**Ordering.** Events are read by real time —
`ORDER BY unixepoch(created_at) ASC, id ASC` — because the log mixes
two timestamp formats (live rows written by SQLite's
`datetime('now')`, migrated/seeded rows written as ISO). As strings
the space sorts before the `T`, which would put a newer live event
before an older ISO event and compute the cycle backwards. `id` only
breaks ties within the same second.

**The investigation.** When ghosts exist, the Chronicle opens a case
on the prime suspect (most appearances, then longest in the fridge).
The verdict templates are English-only:

- 3+ appearances: *"You do not have a spinach shortage, Monsieur.
  You have a commitment problem."*
- 3+ days: *"The spinach has watched 3 sunrises from the same shelf.
  It is no longer food. It is a witness."*
- Otherwise: *"The spinach keeps returning, and nobody will say why."*

With suspect ("Suspect: The Owner"), victim ("Victim: N appearances
in the fridge"), and evidence ("Evidence: 0 confirmed cooking
events").

## Sessions

One session per browser. The client keeps a stable id in
`localStorage` and sends it as the `X-Frigo-Session` header; a
validated `?session=` query parameter overrides the header; with
neither, the session is `default`. The session UUID is browser
isolation, not authentication.

## The demo session (read-only)

Demo data lives **only** in the `demo` session, seeded once at first
boot (`seedChronicleDemo()`, 10 events):

| Ingredient | Observations | Fate |
|---|---|---|
| spinach | 3 | — (the Ghost) |
| cold rice | 2 | — |
| stale bread | 2 | rescued (`cooked`) |
| wilted lettuce | 1 | discarded |

Your own session starts empty; the UI's **Sample Chronicle (Demo)**
tab shows the demo with a `DEMO DATA` badge.

The demo is read-only **enforced by the server**, not just in the
UI: `POST /api/fridge-check`, `POST /api/ingredients/:name/status`,
and `POST /api/generate` for session `demo` all return
`403 Forbidden`. Archiving also refuses the demo session, so the
rule is consistent even though no demo meal exists today.

## Legacy migration

A database from before event sourcing (v12 aggregates in
`ingredient_history`) is migrated once at boot, so the old history
shows up in the Chronicle. The migration is **per-ingredient**, not
global: a database can hold legacy history rows AND newer events at
the same time, and one event anywhere must not skip the whole
migration.

For each history row, the missing sightings are computed as `count`
minus the distinct observations already in the event log, and only
the missing ones are synthesized (labelled `legacy_migration`,
spread evenly between `first_seen` and `last_seen`):

- The first synthesized sighting is `added` only when the
  ingredient has no events at all; otherwise every synthesized
  sighting is `confirmed_present`, so they cannot reset the
  ingredient's current cycle.
- A fate is appended only when the ingredient had no events and the
  legacy snapshot has a status (`rescued` → `cooked`,
  `discarded` → `discarded`).

History rows are never deleted. The migration runs once (a non-empty
event log means it already ran). A pre-event-sourced database also
gets its `ingredient_history` rebuilt keyed by
`(session_id, ingredient)` under `default`, keeping every row.
