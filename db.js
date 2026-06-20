// db.js — FAÇADE (barrel) de la couche de persistance SQLite du suivi.
//
// Le code a été éclaté en modules cohérents sous db/ ; ce fichier ne fait que
// ré-exporter l'API PUBLIQUE (contrat inchangé pour server.js / mcp / repos.js /
// tests) et lancer la séquence d'initialisation au chargement. Mettre la logique
// dans les modules de domaine, pas ici.
//
//   db/constants.js   vocabulaire + garde-fous (feuille, sans dépendance)
//   db/helpers.js     normalisation pure des valeurs (clamp, notes, dates)
//   db/connection.js  registre + pool tracker.db + proxy `db` + withRepo + schéma
//   db/registry.js    registre des dépôts (CRUD), app_settings, resolveRepoId
//   db/migrations.js  bootstrap + migrations one-shot (initDb)
//   db/issues.js      issues / références / commentaires
//   db/nodes.js       arbre Vibes + application des actions IA
//   db/messages.js    persistance des chats (par nœud + forêt)
//
// MULTI-REPOS : un registre `repos` (meowtrack.db, par machine) scope toutes les
// données ; chaque dépôt a sa propre base `tracker.db` (issues/nodes/messages). Le
// MCP (mcp.js) et le dashboard (server.js) ouvrent la même base — WAL autorise
// lectures concurrentes + un seul writer.

// ── Vocabulaire (constantes publiques) ───────────────────────────────────────
export { TYPES, STATUSES, PRIORITIES, NODE_STATUSES, NODE_COLORS, CHAT_MODELS, MESSAGE_STATES } from "./db/constants.js";

// ── Connexions (registre + pool tracker) ─────────────────────────────────────
export { closeTrackerDb, checkpointTracker } from "./db/connection.js";

// ── Registre des dépôts + réglages d'instance ────────────────────────────────
export {
  getSetting,
  setSetting,
  getRepoRow,
  listRepoRows,
  listRepos,
  getRepo,
  resolveRepoId,
  createRepo,
  updateRepo,
  deleteRepo,
  getHiddenBranches,
  hideBranch,
  unhideBranch,
} from "./db/registry.js";

// ── Issues / références / commentaires ───────────────────────────────────────
export {
  extractMentions,
  listReferences,
  addReference,
  removeReference,
  listComments,
  addComment,
  getIssue,
  createIssue,
  updateIssue,
  deleteIssue,
  listIssues,
  stats,
} from "./db/issues.js";

// ── Nœuds Vibes (arbre + actions IA) ────────────────────────────────────
export {
  getNode,
  getSubtree,
  listRootNodes,
  listForest,
  listChildren,
  nodePathIds,
  createNode,
  updateNode,
  deleteNode,
  moveNode,
  reorderChildren,
  setNodePositions,
  applyNodeActions,
  applyForestActions,
} from "./db/nodes.js";

// ── Chats (par nœud + forêt) ─────────────────────────────────────────────────
export {
  clearNodeMessages,
  listNodeMessages,
  getNodeMessage,
  addNodeMessage,
  updateNodeMessage,
  clearForestMessages,
  listForestMessages,
  getForestMessage,
  addForestMessage,
  updateForestMessage,
} from "./db/messages.js";

// ── Initialisation au chargement (bootstrap + migrations idempotentes) ────────
// Exécutée APRÈS l'évaluation de tous les modules ci-dessus (registre + schéma
// prêts) : préserve l'effet de bord historique « importer db.js initialise la base ».
import { initDb } from "./db/migrations.js";
initDb();
