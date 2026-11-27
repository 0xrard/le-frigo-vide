// Le Bulletin du Frigo — the Living Fridge Chronicle.
// Event-sourced: the Chronicle reads ONLY the ingredient_events log for
// one session. Appearances = distinct observations an ingredient was seen
// in (added / confirmed_present). A menu generate logs NOTHING, so
// re-generating the same menu can never manufacture a Ghost. Status is
// the latest cooked/discarded event; otherwise the ingredient is active.
// A Ghost is an active ingredient seen in at least 2 observations.
import { getSessionEvents } from './db.mjs';

export const GHOST_MIN_APPEARANCES = 2;

export function daysSince(iso, nowMs = Date.now()) {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((nowMs - t) / 86_400_000));
}

// Derive one ingredient's dossier from its events in this session.
// Status and appearances are computed on the CURRENT CYCLE only: the
// cycle starts at the latest 'added' event (a fresh sighting after a
// fate is a new instance). Older cycles stay in the log but no longer
// decide the status — otherwise a re-bought spinach would stay
// 'rescued' forever (audit C).
export function deriveDossier(ingredient, events, nowMs = Date.now()) {
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].event_type === 'added') { start = i; break; }
  }
  const cycle = events.slice(start);
  const sightings = cycle.filter((e) => e.event_type === 'added' || e.event_type === 'confirmed_present');
  const observations = new Set(sightings.map((e) => e.observation_id).filter(Boolean));
  // First/last seen are the earliest/latest sighting TIMES in the cycle,
  // not the first/last rows in id order: a legacy top-up can append old
  // timestamps after newer ones, and last_seen must never go backwards.
  const times = sightings.map((e) => new Date(e.created_at).getTime()).filter((t) => !Number.isNaN(t));
  const firstSeen = times.length ? new Date(Math.min(...times)).toISOString() : null;
  const lastSeen = times.length ? new Date(Math.max(...times)).toISOString() : null;
  const fate = [...cycle].reverse().find((e) => e.event_type === 'cooked' || e.event_type === 'discarded');
  return {
    ingredient,
    appearances: observations.size,
    first_seen: firstSeen,
    last_seen: lastSeen,
    days: daysSince(firstSeen, nowMs),
    status: fate ? (fate.event_type === 'cooked' ? 'rescued' : 'discarded') : 'active',
    status_at: fate ? fate.created_at : null,
    source: cycle.length && cycle[0].source === 'legacy_migration' ? 'legacy_migration' : 'live',
  };
}

// English-only MVP (v18.1): the verdicts are in English; `lang` is
// accepted for API compatibility and ignored.
const VERDICTS = {
  commitment: (name) => `You do not have a ${name} shortage, Monsieur. You have a commitment problem.`,
  witness: (name, days) => `The ${name} has watched ${days} sunrises from the same shelf. It is no longer food. It is a witness.`,
  returns: (name) => `The ${name} keeps returning, and nobody will say why.`,
  suspect: 'Suspect: The Owner',
  victim: (n) => `Victim: ${n} appearances in the fridge`,
  evidence: 'Evidence: 0 confirmed cooking events',
  verdictLabel: "Chef's Verdict:",
};

function buildInvestigation(ghosts) {
  if (!ghosts.length) return null;
  // Prime suspect: most appearances, then longest in the fridge.
  const [g] = [...ghosts].sort((a, b) => (b.appearances - a.appearances) || (b.days - a.days));
  const v = VERDICTS;
  const name = g.ingredient;
  const verdict = g.appearances >= 3
    ? v.commitment(name)
    : g.days >= 3
      ? v.witness(name, g.days)
      : v.returns(name);
  return {
    ingredient: name,
    title: `THE CASE OF THE FORGOTTEN ${name.toUpperCase()}`,
    suspect: v.suspect,
    victim: v.victim(g.appearances),
    evidence: v.evidence,
    verdictLabel: v.verdictLabel,
    verdict,
  };
}

export function buildChronicle(lang = 'en', sessionId = 'default', nowMs = Date.now()) {
  const l = 'en';
  const events = getSessionEvents(sessionId);
  const byIngredient = new Map();
  for (const e of events) {
    if (!byIngredient.has(e.ingredient)) byIngredient.set(e.ingredient, []);
    byIngredient.get(e.ingredient).push(e);
  }
  const dossiers = [...byIngredient.entries()]
    .map(([ingredient, evs]) => deriveDossier(ingredient, evs, nowMs))
    .sort((a, b) => (b.appearances - a.appearances) || (b.days - a.days));
  const survivors = dossiers.filter((d) => d.status === 'active');
  const rescued = dossiers.filter((d) => d.status === 'rescued');
  const departed = dossiers.filter((d) => d.status === 'discarded');
  const ghosts = survivors.filter((d) => d.appearances >= GHOST_MIN_APPEARANCES);
  return {
    ok: true,
    lang: l,
    session_id: sessionId,
    demo: sessionId === 'demo',
    generated_at: new Date(nowMs).toISOString(),
    totals: {
      tracked: dossiers.length,
      sessions: dossiers.reduce((n, d) => n + d.appearances, 0),
    },
    survivors,
    rescued,
    departed,
    ghosts,
    investigation: buildInvestigation(ghosts),
  };
}
