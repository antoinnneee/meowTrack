// db/constants.js — vocabulaire et garde-fous partagés par la couche de données.
//
// Module FEUILLE : aucune dépendance (ni connexion, ni autre module db/*). Les
// énumérations exportées font partie de l'API publique (réexportées par db.js) ;
// les limites et Sets dérivés sont consommés par les modules de domaine.

// ── Vocabulaire issues ───────────────────────────────────────────────────────
export const TYPES = ["bug", "feature", "task", "chore"];
export const STATUSES = ["open", "in_progress", "done", "wontfix"];
export const PRIORITIES = ["low", "medium", "high", "critical"];

// ── Vocabulaire Good Vibes v2 (arbre de nœuds) ───────────────────────────────
export const NODE_STATUSES = ["active", "paused", "done", "abandoned"];
export const NODE_COLORS = ["accent", "feature", "task", "bug", "high"];
export const CHAT_MODELS = ["sonnet", "opus", "haiku"];
export const MESSAGE_STATES = ["pending", "streaming", "complete", "error"];

// ── Garde-fous (anti-DoS / quotas) ───────────────────────────────────────────
export const MAX_DEPTH = 32; // profondeur max d'un arbre (anti-DoS récursion)
export const MAX_NODES_PER_SUBTREE = 500; // garde-fou volume par sous-arbre
export const MAX_NODES_PER_REPO = 2000; // garde-fou volume par repo (chat « top level »)
export const MAX_ACTIONS = 20; // actions IA max appliquées par tour
export const MAX_NOTES = 50000; // taille max du corps markdown d'UNE note (~50 Ko)
export const MAX_NOTE_COUNT = 50; // nombre max de notes par nœud

// Préfixes de codes lisibles, par type (cf. nextRef).
export const PREFIX = { bug: "BUG", feature: "FEAT", task: "TASK", chore: "CHORE", node: "NODE" };

// ── Sets dérivés (validation O(1)) + regex date ──────────────────────────────
export const NODE_STATUS_SET = new Set(NODE_STATUSES);
export const NODE_COLOR_SET = new Set(NODE_COLORS);
export const MSG_STATE_SET = new Set(MESSAGE_STATES);
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
