// db/constants.js — vocabulaire et garde-fous partagés par la couche de données.
//
// Module FEUILLE : aucune dépendance (ni connexion, ni autre module db/*). Les
// énumérations exportées font partie de l'API publique (réexportées par db.js) ;
// les limites et Sets dérivés sont consommés par les modules de domaine.

// ── Vocabulaire issues ───────────────────────────────────────────────────────
export const TYPES = ["bug", "feature", "task", "chore"];
export const STATUSES = ["open", "in_progress", "done", "wontfix"];
export const PRIORITIES = ["low", "medium", "high", "critical"];

// ── Vocabulaire Vibes v2 (arbre de nœuds) ───────────────────────────────
// `waiting` = en attente d'une information de l'utilisateur (clé API, config, décision)
// avant de pouvoir être implémenté. Bloqué pour l'orchestrateur (claimNextNode exige
// status='active') ; l'info manquante est décrite dans la colonne `pending_info`.
export const NODE_STATUSES = ["active", "paused", "waiting", "done", "abandoned"];
// Type de nœud. `normal` = objectif/jalon classique. `activation` = NŒUD D'ACTIVATION :
// une porte manuelle qui bloque tous les nœuds qui le requièrent (prérequis) tant qu'il
// n'est pas « activé » (status='done'). Réutilise le moteur de prérequis ; exclu de
// l'orchestrateur (jamais réclamé comme tâche exécutable).
export const NODE_KINDS = ["normal", "activation"];
export const NODE_COLORS = ["accent", "feature", "task", "bug", "high"];
export const CHAT_MODELS = ["sonnet", "opus", "haiku"];
export const MESSAGE_STATES = ["pending", "streaming", "complete", "error"];
// Liens de prérequis entre nœuds (hors hiérarchie) : catalogue fermé des types.
export const NODE_LINK_KINDS = ["requires"];

// ── Orchestrateur d'exécution (bail + runs + revue) ──────────────────────────
// `run_state` décrit l'EXÉCUTION (séparé de `status`, l'intention de planning).
// NULL = jamais exécuté ; 'done' = miroir de status='done'. 'review' ne débloque
// PAS les dépendants (attend un retour) et n'est pas réclamable.
export const RUN_STATES = ["running", "review", "failed", "done"];
// État d'un enregistrement d'exécution (table node_runs).
export const NODE_RUN_STATES = ["running", "done", "review", "failed"];
// Types et états d'un point de revue (table node_reviews).
export const REVIEW_KINDS = ["decision", "question", "risk", "discovery"];
export const REVIEW_STATES = ["open", "resolved", "dismissed"];
// État rapporté par l'agent dans .meowtrack/runs/<ref>.json (fail-closed).
export const REPORT_STATES = ["done", "needs_review", "failed"];
// Résultat de test rapporté par l'agent.
export const TEST_RESULTS = ["pass", "fail", "skipped"];

// ── Garde-fous (anti-DoS / quotas) ───────────────────────────────────────────
export const MAX_DEPTH = 32; // profondeur max d'un arbre (anti-DoS récursion)
export const MAX_NODES_PER_SUBTREE = 500; // garde-fou volume par sous-arbre
export const MAX_NODES_PER_REPO = 2000; // garde-fou volume par repo (chat « top level »)
export const MAX_ACTIONS = 200; // actions IA max appliquées par tour
export const MAX_NOTES = 50000; // taille max du corps markdown d'UNE note (~50 Ko)
export const MAX_NOTE_COUNT = 50; // nombre max de notes par nœud
export const MAX_LINKS_PER_NODE = 50; // nombre max de prérequis sortants par nœud
export const MAX_REPORT_BYTES = 256 * 1024; // taille max d'un rapport .meowtrack/runs/<ref>.json (~256 Ko)
export const MAX_REVIEW_POINTS = 50; // points de revue max ingérés par rapport
export const MAX_AUTO_REVIEWS = 3; // auto-revues max par nœud avant bascule en revue humaine

// Préfixes de codes lisibles, par type (cf. nextRef).
export const PREFIX = { bug: "BUG", feature: "FEAT", task: "TASK", chore: "CHORE", node: "NODE" };

// ── Sets dérivés (validation O(1)) + regex date ──────────────────────────────
export const NODE_STATUS_SET = new Set(NODE_STATUSES);
export const NODE_KIND_SET = new Set(NODE_KINDS);
export const NODE_COLOR_SET = new Set(NODE_COLORS);
export const NODE_LINK_KIND_SET = new Set(NODE_LINK_KINDS);
export const MSG_STATE_SET = new Set(MESSAGE_STATES);
export const REVIEW_KIND_SET = new Set(REVIEW_KINDS);
export const REVIEW_STATE_SET = new Set(REVIEW_STATES);
export const TEST_RESULT_SET = new Set(TEST_RESULTS);
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Format d'un code de nœud (anti-traversal pour le chemin du rapport).
export const NODE_REF_RE = /^[A-Z]+-\d+$/;
