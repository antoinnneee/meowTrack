// repos.js — orchestration git MULTI-REPOS.
//
// Fait le pont entre le registre des repos (table `repos`, CRUD dans db.js) et les
// primitives git bas niveau (repo.js). Résout le clone d'un repo, maintient un
// cache d'index de chemins par (repo, branche), et expose des wrappers « par
// repoId » utilisés par le serveur HTTP et par db.js (validation des chemins +
// contexte git à la création d'une issue).
//
// NB : import circulaire avec db.js (db.js importe gitContextFor/inspectPathFor…,
// ce module importe le registre). C'est SÛR : aucun binding n'est utilisé au
// moment de l'évaluation des modules — uniquement à l'intérieur des fonctions.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isGitClone,
  cloneInto,
  pull,
  normalizePath,
  inspectPath,
  gitContext,
  branchContext,
  buildIndex,
  listBranches,
  searchPaths,
  discoverGitRepos,
  // Gestionnaire de repos (git lecture + écriture)
  status,
  logGraph,
  listRefsAll,
  branchesDetailed,
  diffFile,
  stagedDiff,
  commitDetail,
  fileContent,
  getGitConfig,
  setGitConfig,
  stage,
  unstage,
  discard,
  commit,
  fetchRemote,
  push,
  createBranch,
  checkoutBranch,
  checkoutCommit,
  deleteBranch,
  deleteRemoteBranch,
  renameBranch,
  merge,
  rebase,
  cherryPick,
  revertCommit,
  resetTo,
  createTag,
  deleteTag,
  stashSave,
  stashPop,
  stashApply,
  stashDrop,
  stashShow,
  stashList,
  abortOperation,
  continueOperation,
  applyPatch,
  reflog,
  diffRefs,
  blame,
  setRemote,
  removeRemote,
  storeGithubCredential,
  clearGithubCredential,
  githubCredentialStatus,
  storeCredential,
  clearCredential,
  credentialStatus,
} from "./repo.js";
import { getRepoRow, listRepoRows, createRepo, checkpointTracker, closeTrackerDb, getSetting, setSetting, getHiddenBranches } from "./db.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// Racine de clone d'un repo (mémoïsée par id) :
//   1. local_path explicite (clone géré à la main / dev in-repo ciblé) ;
//   2. url définie → dossier dédié `.repos/<slug>/` à côté du service ;
//   3. ni l'un ni l'autre → `git rev-parse --show-toplevel` depuis meowtrack/
//      (cas dev in-repo : le checkout qui contient ce dossier).
const _rootCache = new Map(); // repoId → root absolu
function topLevel() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: HERE, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}
export function rootForRepo(repoOrId) {
  const repo = typeof repoOrId === "object" ? repoOrId : getRepoRow(repoOrId);
  if (!repo) throw new Error(`Repo introuvable : ${repoOrId}`);
  if (_rootCache.has(repo.id)) return _rootCache.get(repo.id);
  let root;
  if (repo.local_path && String(repo.local_path).trim()) root = resolve(String(repo.local_path).trim());
  else if (repo.url && String(repo.url).trim()) root = resolve(HERE, ".repos", repo.slug);
  else {
    const top = topLevel();
    root = top ? resolve(top) : resolve(HERE, "..");
  }
  _rootCache.set(repo.id, root);
  return root;
}
// À appeler si un repo change de local_path/url (invalide la mémoïsation + l'index).
export function invalidateRepo(repoId) {
  _rootCache.delete(repoId);
  for (const key of [..._index.keys()]) if (key.startsWith(`${repoId}|`)) _index.delete(key);
}

// ── Magasin tracker.db PAR dépôt (base SQLite cloisonnée + versionnée) ────────
// Chaque dépôt a sa base `tracker.db` (données de tracking : issues/nodes/…). Elle
// vit dans un dossier dédié `.trackers/<slug>/`, à côté de la base de REGISTRE
// (même dossier que MEOWTRACK_DB). Phase 1 : simple dossier local. Phase 2 : ce
// dossier deviendra un worktree git de la branche orphan « tracking » du dépôt
// (cloisonnement + versionnement, sans toucher aux branches de code).
function trackingRoot() {
  const dbPath = process.env.MEOWTRACK_DB || join(HERE, "meowtrack.db");
  return resolve(dirname(dbPath), ".trackers");
}
export function trackerStoreDirFor(repoOrId) {
  const repo = typeof repoOrId === "object" ? repoOrId : getRepoRow(repoOrId);
  if (!repo) throw new Error(`Repo introuvable : ${repoOrId}`);
  return join(trackingRoot(), repo.slug);
}
// Chemin du fichier tracker.db d'un dépôt (crée le dossier au besoin). Appelé par
// db.js à l'ouverture paresseuse de la connexion du dépôt.
export function trackerDbPathFor(repoOrId) {
  const dir = trackerStoreDirFor(repoOrId);
  mkdirSync(dir, { recursive: true });
  return join(dir, "tracker.db");
}
// Supprime le magasin tracker d'un dépôt (suppression de dépôt). `repoRow` est
// fourni par deleteRepo car la ligne de registre est déjà supprimée à cet instant.
export function removeTrackerStoreFor(repoId, repoRow = null) {
  const slug = repoRow ? repoRow.slug : (getRepoRow(repoId) || {}).slug;
  if (!slug) return;
  const dir = join(trackingRoot(), slug);
  // Si c'est un worktree git, le désenregistrer proprement (sinon entrée fantôme
  // dans .git/worktrees du dépôt). Best-effort.
  if (trackingGit() && existsSync(join(dir, ".git")) && repoRow) {
    try {
      const root = rootForRepo(repoRow);
      gitT(root, ["worktree", "remove", "--force", dir]);
    } catch {
      /* ignore */
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Versionnement git du tracker.db PAR dépôt (Option B : branche ORPHAN « tracking »
// + worktree dédié). DÉSACTIVÉ par défaut (MEOWTRACK_TRACKING_GIT=1 pour activer) :
// le commit est LOCAL (versionnement, sûr), le push est opt-in séparé (publication
// vers le remote). La branche orphan n'a AUCUN historique commun avec le code → elle
// ne contient que tracker.db, et le worktree dédié évite tout changement de branche
// du checkout principal. Tout est best-effort : un échec git ne casse jamais l'app.
// ═══════════════════════════════════════════════════════════════════════════
// Configuration EFFECTIVE, lue DYNAMIQUEMENT (donc modifiable à chaud depuis l'UI) :
// réglage persisté (app_settings) > variable d'environnement > défaut.
function _trkFlag(key, envName) {
  const s = getSetting(key, "");
  if (s === "1") return true;
  if (s === "0") return false;
  return process.env[envName] === "1";
}
function _trkStr(key, envName, def) {
  const s = getSetting(key, "");
  return s || (process.env[envName] || "").trim() || def;
}
function trackingGit() {
  return _trkFlag("tracking_git", "MEOWTRACK_TRACKING_GIT");
}
function trackingPush() {
  return _trkFlag("tracking_push", "MEOWTRACK_TRACKING_PUSH");
}
function trackingBranch() {
  return _trkStr("tracking_branch", "MEOWTRACK_TRACKING_BRANCH", "tracking");
}
function trackingRemote() {
  return _trkStr("tracking_remote", "MEOWTRACK_TRACKING_REMOTE", "origin");
}
function trackingIntervalMs() {
  const s = getSetting("tracking_interval_ms", "") || process.env.MEOWTRACK_TRACKING_INTERVAL_MS || "";
  return Math.max(1000, Number(s) || 5000);
}
// Identité de commit dédiée (n'altère pas la config git de l'utilisateur).
const TRACK_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: process.env.MEOWTRACK_TRACKING_NAME || "meowtrack",
  GIT_AUTHOR_EMAIL: process.env.MEOWTRACK_TRACKING_EMAIL || "meowtrack@localhost",
  GIT_COMMITTER_NAME: process.env.MEOWTRACK_TRACKING_NAME || "meowtrack",
  GIT_COMMITTER_EMAIL: process.env.MEOWTRACK_TRACKING_EMAIL || "meowtrack@localhost",
};

export function trackingGitEnabled() {
  return trackingGit();
}

// git sans shell, capture stdout+stderr → {ok, out}. `input` (optionnel) → stdin.
function gitT(cwd, args, input) {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: [input != null ? "pipe" : "ignore", "pipe", "pipe"],
      input: input != null ? input : undefined,
      env: TRACK_ENV,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, out: String(out).trim() };
  } catch (e) {
    return { ok: false, out: String(e.stderr || e.stdout || e.message || e).trim() };
  }
}

// Garantit l'existence de la branche `tracking` dans le dépôt `root` :
//   1. locale présente → ok ; 2. présente sur le remote → branche locale de suivi ;
//   3. sinon, branche ORPHAN créée par plumbing (arbre vide → commit sans parent →
//      branche). Ne touche JAMAIS l'index ni le working tree du checkout principal.
function ensureTrackingBranch(root) {
  const B = trackingBranch();
  const R = trackingRemote();
  if (gitT(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${B}`]).ok) return true;
  if (gitT(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/${R}/${B}`]).ok) {
    return gitT(root, ["branch", B, `${R}/${B}`]).ok;
  }
  const tree = gitT(root, ["mktree"], "").out; // stdin vide → hash de l'arbre vide
  if (!tree) return false;
  const commit = gitT(root, ["commit-tree", tree, "-m", "Init tracking meowtrack"]).out; // sans parent → orphan
  if (!commit) return false;
  return gitT(root, ["branch", trackingBranch(), commit]).ok;
}

// Garantit que le magasin tracker d'un dépôt est un worktree de la branche orphan
// `tracking`. Idempotent. Repli en mode « plain » (simple dossier) si git
// indisponible / dépôt non clone / flag off. Préserve une base déjà présente.
// Renvoie { mode: 'worktree'|'plain', dir, root }.
export function ensureTrackingStore(repoId) {
  const dir = trackerStoreDirFor(repoId);
  if (!trackingGit()) {
    mkdirSync(dir, { recursive: true });
    return { mode: "plain", dir, root: null };
  }
  // GARDE-FOU : un repo SANS url ni local_path est le repli « dev in-repo » dont la
  // racine est le dépôt MEOWTRACK lui-même (topLevel). On ne versionne JAMAIS le
  // checkout de meowtrack (sinon on y crée une branche orphan « tracking »). Mode plain.
  const row = getRepoRow(repoId);
  const hasClone = row && (String(row.url || "").trim() || String(row.local_path || "").trim());
  if (!hasClone) {
    mkdirSync(dir, { recursive: true });
    return { mode: "plain", dir, root: null, reason: "self_repo" };
  }
  let root;
  try {
    root = rootForRepo(repoId);
  } catch {
    mkdirSync(dir, { recursive: true });
    return { mode: "plain", dir, root: null };
  }
  if (!isGitClone(root)) {
    mkdirSync(dir, { recursive: true });
    return { mode: "plain", dir, root: null };
  }
  if (existsSync(join(dir, ".git"))) return { mode: "worktree", dir, root }; // déjà un worktree

  // Conversion plain → worktree (une seule fois). La base est peut-être OUVERTE par
  // db.js (verrou fichier, bloquant sur Windows) : on rapatrie le WAL puis on FERME
  // la connexion avant de déplacer le fichier. Le prochain accès la rouvrira depuis
  // le même chemin (désormais dans le worktree).
  checkpointTracker(repoId);
  closeTrackerDb(repoId);

  // Préserver une base tracker.db déjà créée (mode plain antérieur) — la nôtre
  // prime sur la version éventuelle de la branche. Le stash est À CÔTÉ de `dir`
  // (jamais dedans : `dir` est supprimé juste après pour `git worktree add`).
  const dbFile = join(dir, "tracker.db");
  const stash = dir + ".predb";
  let stashed = false;
  if (existsSync(dbFile)) {
    try { rmSync(stash, { force: true }); } catch { /* ignore */ }
    renameSync(dbFile, stash);
    stashed = true;
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } // worktree add exige un dossier absent

  const fallbackPlain = () => {
    mkdirSync(dir, { recursive: true });
    if (stashed) { try { renameSync(stash, dbFile); } catch { /* ignore */ } }
    return { mode: "plain", dir, root };
  };
  gitT(root, ["worktree", "prune"]); // purge les registrations fantômes (dir supprimé)
  if (!ensureTrackingBranch(root)) return fallbackPlain();
  if (!gitT(root, ["worktree", "add", dir, trackingBranch()]).ok) return fallbackPlain();

  try { writeFileSync(join(dir, ".gitignore"), "tracker.db-wal\ntracker.db-shm\n"); } catch { /* ignore */ }
  if (stashed) { try { renameSync(stash, dbFile); } catch { /* ignore */ } } // notre base prime
  return { mode: "worktree", dir, root };
}

// Commit (et push opt-in) de l'état COURANT du tracker d'un dépôt. Checkpoint WAL
// d'abord (fichier complet), puis add + commit si changements. Best-effort.
export function commitTrackingStore(repoId, { push = trackingPush() } = {}) {
  if (!trackingGit()) return { skipped: "disabled" };
  let store;
  try {
    store = ensureTrackingStore(repoId);
  } catch (e) {
    return { skipped: "error", output: e.message || String(e) };
  }
  if (store.mode !== "worktree") return { skipped: "no_worktree" };
  checkpointTracker(repoId); // rapatrie le WAL dans tracker.db
  gitT(store.dir, ["add", "tracker.db", ".gitignore"]);
  if (!gitT(store.dir, ["status", "--porcelain"]).out) return { nochange: true };
  const c = gitT(store.dir, ["commit", "-m", `tracking ${new Date().toISOString()}`]);
  let pushed = null;
  if (c.ok && push) pushed = gitT(store.dir, ["push", trackingRemote(), `HEAD:${trackingBranch()}`]).ok;
  return { committed: c.ok, pushed, output: c.out };
}

// Boot : prépare le worktree de CHAQUE dépôt (restore le tracker.db de la branche
// `tracking` sur une machine neuve) et, si push activé, tente un pull ff-only.
export function syncAllTrackingStores() {
  if (!trackingGit()) return [];
  const out = [];
  for (const repo of listRepoRows()) {
    try {
      const store = ensureTrackingStore(repo.id);
      if (store.mode === "worktree" && trackingPush()) {
        gitT(store.dir, ["pull", "--ff-only", trackingRemote(), trackingBranch()]);
      }
      out.push({ slug: repo.slug, mode: store.mode });
    } catch (e) {
      out.push({ slug: repo.slug, error: e.message || String(e) });
    }
  }
  return out;
}

// Committer périodique : à chaque intervalle, commit chaque tracker qui a changé (le
// « débounce » est porté par l'intervalle + le no-op si rien à committer — pas besoin
// d'instrumenter chaque mutation). unref → ne bloque pas l'arrêt.
let _committer = null;
export function startTrackingCommitter() {
  if (!trackingGit() || _committer) return;
  _committer = setInterval(() => {
    for (const repo of listRepoRows()) {
      try { commitTrackingStore(repo.id); } catch { /* ignore */ }
    }
  }, trackingIntervalMs());
  if (_committer.unref) _committer.unref();
}
// Flush final (à l'arrêt) : un dernier commit (+ push opt-in) de chaque tracker.
export function flushTrackingCommits() {
  if (!trackingGit()) return;
  for (const repo of listRepoRows()) {
    try { commitTrackingStore(repo.id); } catch { /* ignore */ }
  }
}
export function stopTrackingCommitter() {
  if (_committer) { clearInterval(_committer); _committer = null; }
  flushTrackingCommits();
}

// État du magasin d'un dépôt SANS effet de bord (pour l'affichage UI).
function trackingStoreMode(repoId) {
  if (!trackingGit()) return "off";
  let dir;
  try { dir = trackerStoreDirFor(repoId); } catch { return "?"; }
  if (existsSync(join(dir, ".git"))) return "worktree";
  return existsSync(dir) ? "plain" : "absent";
}

// Config EFFECTIVE + origine (env) + état par dépôt — pour la page de configuration.
export function getTrackingConfig() {
  return {
    git: trackingGit(),
    push: trackingPush(),
    branch: trackingBranch(),
    remote: trackingRemote(),
    intervalMs: trackingIntervalMs(),
    // Valeurs forcées par l'environnement (informatif : un réglage UI les surcharge).
    env: {
      git: process.env.MEOWTRACK_TRACKING_GIT === "1",
      push: process.env.MEOWTRACK_TRACKING_PUSH === "1",
    },
    stores: listRepoRows().map((r) => ({ slug: r.slug, name: r.name, mode: trackingStoreMode(r.id) })),
  };
}

// Persiste la config (app_settings) puis réconcilie l'état runtime : (re)prépare les
// worktrees + relance le committer si activé, l'arrête sinon. Renvoie la config à jour.
export function setTrackingConfig(patch = {}) {
  if ("git" in patch) setSetting("tracking_git", patch.git ? "1" : "0");
  if ("push" in patch) setSetting("tracking_push", patch.push ? "1" : "0");
  if ("branch" in patch && String(patch.branch || "").trim()) setSetting("tracking_branch", String(patch.branch).trim());
  if ("remote" in patch && String(patch.remote || "").trim()) setSetting("tracking_remote", String(patch.remote).trim());
  if ("intervalMs" in patch && Number(patch.intervalMs)) setSetting("tracking_interval_ms", String(Math.max(1000, Number(patch.intervalMs))));
  if (_committer) { clearInterval(_committer); _committer = null; }
  if (trackingGit()) {
    syncAllTrackingStores();
    startTrackingCommitter();
  }
  return getTrackingConfig();
}

// ── Cache d'index de chemins, par (repo, branche) ────────────────────────────
const CACHE_MS = 4000;
const _index = new Map(); // `${repoId}|${branch}` → index (branch "" = working tree)

function getIndex(repoId, branch) {
  const key = `${repoId}|${branch || ""}`;
  const cached = _index.get(key);
  if (cached && Date.now() - cached.stamp < CACHE_MS) return cached;
  const built = buildIndex(rootForRepo(repoId), branch);
  _index.set(key, built);
  return built;
}

export function refreshPathsFor(repoId, branch) {
  if (branch === undefined) {
    for (const key of [..._index.keys()]) if (key.startsWith(`${repoId}|`)) _index.delete(key);
  } else {
    _index.delete(`${repoId}|${branch || ""}`);
  }
  const idx = getIndex(repoId, branch);
  return { repoId, branch: branch || null, files: idx.files.length, dirs: idx.dirs.length };
}

// ── Wrappers « par repoId » (résolvent le root puis délèguent à repo.js) ─────
export function gitContextFor(repoId) {
  return gitContext(rootForRepo(repoId));
}
export function branchContextFor(repoId, branch) {
  return branchContext(rootForRepo(repoId), branch);
}
export function normalizePathFor(repoId, p) {
  return normalizePath(rootForRepo(repoId), p);
}
export function inspectPathFor(repoId, relPath, branch = null) {
  return inspectPath(rootForRepo(repoId), relPath, branch, (b) => getIndex(repoId, b));
}
export function searchPathsFor(repoId, query = "", limit = 30, branch = null) {
  return searchPaths(getIndex(repoId, branch), query, limit);
}
// Arbre complet (fichiers + dossiers) d'un dépôt pour l'explorateur de fichiers.
// `branch` nul → working tree (ls-files) ; sinon arbre de la branche. Index caché.
export function listTreeFor(repoId, branch = null) {
  const idx = getIndex(repoId, branch);
  const ctx = branchContext(rootForRepo(repoId), branch);
  return { files: idx.files, dirs: idx.dirs, branch: ctx.branch, commit: ctx.commit };
}
export function fileContentFor(repoId, relPath, branch = null) {
  return fileContent(rootForRepo(repoId), relPath, branch);
}
// Ensemble effectif des branches masquées d'un dépôt : liste explicite (UI) +
// branche de suivi (orphan tracking.db), toujours cachée des sélecteurs de code.
function hiddenBranchSet(repoId) {
  const set = new Set(getHiddenBranches(repoId));
  set.add(trackingBranch());
  return set;
}
export function listBranchesFor(repoId) {
  const { branches, current } = listBranches(rootForRepo(repoId));
  const hidden = hiddenBranchSet(repoId);
  return { branches: branches.filter((b) => !hidden.has(b)), current };
}

// ── Clone / pull d'un repo ───────────────────────────────────────────────────
// Garantit un clone à jour : clone si absent (et url présente), sinon pull.
// No-op pour un repo sans url (clone géré à la main / dev in-repo).
export function ensureRepo(repoId) {
  const repo = getRepoRow(repoId);
  if (!repo) throw new Error(`Repo introuvable : ${repoId}`);
  const root = rootForRepo(repo);
  if (!repo.url || !String(repo.url).trim()) {
    // Pas d'URL : on ne clone/pull pas, on lit le clone existant.
    return { ok: true, skipped: true, reason: "no_url", branch: gitContext(root).branch, commit: gitContext(root).commit, root };
  }
  if (isGitClone(root)) return pullRepo(repoId);
  const r = cloneInto(repo.url, root);
  if (r.ok) refreshPathsFor(repoId);
  const ctx = gitContext(root);
  return { ok: r.ok, cloned: r.ok, branch: ctx.branch, commit: ctx.commit, output: r.output, root };
}

export function pullRepo(repoId, opts) {
  const root = rootForRepo(repoId);
  if (!isGitClone(root)) return { ok: false, output: `Pas un clone git : ${root}`, root };
  const r = pull(root, opts);
  refreshPathsFor(repoId); // l'arbre a pu changer
  const ctx = gitContext(root);
  return { ok: r.ok, pulled: r.pulled, branch: ctx.branch, commit: ctx.commit, output: r.output, root };
}

// ── Import en masse d'un dossier multi-repos ─────────────────────────────────
// Détecte tous les clones git d'un dossier (repo.js:discoverGitRepos) et enregistre
// chacun dans le registre par `local_path` (aucune url → clone géré à la main, juste
// lu). Les clones déjà suivis (même local_path résolu) sont ignorés. Le slug est
// dérivé du nom de dossier ; en cas de collision, on suffixe `-2`, `-3`… Tolérant :
// un repo en échec n'empêche pas les autres. Renvoie { dir, found, added[], skipped[], errors[] }.
export function importReposFromDir(dir) {
  const found = discoverGitRepos(dir);
  const known = new Set(
    listRepoRows()
      .map((r) => r.local_path && resolve(String(r.local_path).trim()))
      .filter(Boolean)
  );
  const added = [];
  const skipped = [];
  const errors = [];
  for (const { path, name } of found) {
    if (known.has(path)) {
      skipped.push({ path, name, reason: "already_registered" });
      continue;
    }
    try {
      // createRepo détecte les collisions de slug (lève « slug déjà utilisé ») :
      // on suffixe et on réessaie. Toute autre erreur remonte sur ce repo.
      let repo = null;
      for (let attempt = 0; attempt < 50 && !repo; attempt++) {
        const slug = attempt === 0 ? name : `${name}-${attempt + 1}`;
        try {
          repo = createRepo({ slug, name, localPath: path });
        } catch (e) {
          if (!/déjà utilisé/.test(e.message || "")) throw e;
        }
      }
      if (!repo) throw new Error("impossible de dériver un slug unique");
      known.add(path);
      const ctx = gitContext(path);
      added.push({ slug: repo.slug, name: repo.name, path, branch: ctx.branch, commit: ctx.commit });
    } catch (e) {
      errors.push({ path, name, error: e.message || String(e) });
    }
  }
  return { dir: resolve(dir), found: found.length, added, skipped, errors };
}

// Sync de TOUS les repos au démarrage (clone si absent, sinon pull). Renvoie un
// rapport par repo. Tolérant aux échecs (un repo cassé ne bloque pas les autres).
export function ensureAllRepos() {
  const out = [];
  for (const repo of listRepoRows()) {
    try {
      out.push({ slug: repo.slug, ...ensureRepo(repo.id) });
    } catch (e) {
      out.push({ slug: repo.slug, ok: false, output: e.message || String(e) });
    }
  }
  return out;
}

// ── Gestionnaire de repos : wrappers « par repoId » (résolvent le root + délèguent
// à repo.js). Les opérations qui modifient le working tree invalident l'index des
// chemins (l'arbre a pu changer).
export function statusFor(repoId) {
  return status(rootForRepo(repoId));
}
// Nom de branche (pour comparaison avec l'ensemble des cachées) à partir d'un
// refname complet : refs/heads/<b> → <b> ; refs/remotes/<remote>/<b> → <b> ;
// tags / autres → null (jamais cachés).
function refBranchName(refname) {
  if (refname.startsWith("refs/heads/")) return refname.slice("refs/heads/".length);
  if (refname.startsWith("refs/remotes/")) {
    const rest = refname.slice("refs/remotes/".length); // <remote>/<b>
    const i = rest.indexOf("/");
    return i >= 0 ? rest.slice(i + 1) : rest;
  }
  return null;
}

// Graphe d'historique filtré. Plutôt que `--all` (qui ramasse aussi le HEAD du
// worktree de tracking sur le serveur), on parcourt une **sélection positive** des
// refs visibles : tous les refs/heads + refs/remotes + refs/tags, SAUF les branches
// cachées (liste explicite + branche de suivi) et le refs/remotes/*/HEAD symbolique.
// Conséquence : les commits exclusifs à une branche cachée disparaissent du graphe
// ET de la liste de commits ; les commits partagés avec une branche visible restent.
// On nettoie aussi les pastilles des branches cachées sur ces commits partagés.
export function logGraphFor(repoId, opts) {
  const root = rootForRepo(repoId);
  const hidden = hiddenBranchSet(repoId);
  const refs = [];
  for (const { refname } of listRefsAll(root)) {
    if (/^refs\/remotes\/[^/]+\/HEAD$/.test(refname)) continue; // origin/HEAD symbolique
    const b = refBranchName(refname);
    if (b != null && hidden.has(b)) continue; // branche cachée
    refs.push(refname);
  }
  const out = logGraph(root, { ...opts, refs });
  for (const c of out.commits) {
    c.refs = c.refs.filter((r) => {
      if (r.kind !== "local" && r.kind !== "remote") return true; // tags / HEAD : gardés
      const short = r.kind === "remote" && r.name.includes("/") ? r.name.slice(r.name.indexOf("/") + 1) : r.name;
      return !hidden.has(short);
    });
  }
  return out;
}
export function branchesDetailedFor(repoId) {
  const d = branchesDetailed(rootForRepo(repoId));
  const explicit = new Set(getHiddenBranches(repoId));
  const trk = trackingBranch();
  // Annote chaque branche : `hidden` (masquée des sélecteurs), `hiddenLocked` pour
  // la branche de suivi (cachée par défaut, non « démasquable » depuis l'UI).
  const mark = (b, short) => ({ ...b, hidden: explicit.has(short) || short === trk, hiddenLocked: short === trk });
  return {
    ...d,
    local: (d.local || []).map((b) => mark(b, b.name)),
    remote: (d.remote || []).map((b) => mark(b, b.name.includes("/") ? b.name.slice(b.name.indexOf("/") + 1) : b.name)),
    hiddenBranches: [...explicit],
    trackingBranch: trk,
  };
}
export function diffFileFor(repoId, relPath, opts) {
  return diffFile(rootForRepo(repoId), relPath, opts);
}
export function stagedDiffFor(repoId, opts) {
  return stagedDiff(rootForRepo(repoId), opts);
}
export function commitDetailFor(repoId, hash) {
  return commitDetail(rootForRepo(repoId), hash);
}
export function getGitConfigFor(repoId) {
  return getGitConfig(rootForRepo(repoId));
}
export function setGitConfigFor(repoId, key, value) {
  return setGitConfig(rootForRepo(repoId), key, value);
}
export function stageFor(repoId, paths, all) {
  return stage(rootForRepo(repoId), paths, all);
}
export function unstageFor(repoId, paths, all) {
  return unstage(rootForRepo(repoId), paths, all);
}
export function discardFor(repoId, paths) {
  const r = discard(rootForRepo(repoId), paths);
  refreshPathsFor(repoId, "");
  return r;
}
export function commitFor(repoId, message, opts) {
  return commit(rootForRepo(repoId), message, opts);
}
export function applyPatchFor(repoId, patch, opts) {
  const r = applyPatch(rootForRepo(repoId), patch, opts);
  refreshPathsFor(repoId, "");
  return r;
}
export function abortOperationFor(repoId) {
  const r = abortOperation(rootForRepo(repoId));
  refreshPathsFor(repoId, "");
  return r;
}
export function continueOperationFor(repoId) {
  const r = continueOperation(rootForRepo(repoId));
  refreshPathsFor(repoId, "");
  return r;
}
export function reflogFor(repoId, opts) {
  return reflog(rootForRepo(repoId), opts);
}
export function diffRefsFor(repoId, a, b, relPath) {
  return diffRefs(rootForRepo(repoId), a, b, relPath);
}
export function blameFor(repoId, relPath, branch) {
  return blame(rootForRepo(repoId), relPath, branch);
}
export function fetchFor(repoId) {
  return fetchRemote(rootForRepo(repoId));
}
export function pushFor(repoId, opts) {
  return push(rootForRepo(repoId), opts);
}
export function createBranchFor(repoId, name, opts) {
  const r = createBranch(rootForRepo(repoId), name, opts);
  if (r.ok) refreshPathsFor(repoId, "");
  return r;
}
export function checkoutBranchFor(repoId, name) {
  const r = checkoutBranch(rootForRepo(repoId), name);
  if (r.ok) refreshPathsFor(repoId, "");
  return r;
}
export function checkoutCommitFor(repoId, hash) {
  const r = checkoutCommit(rootForRepo(repoId), hash);
  if (r.ok) refreshPathsFor(repoId, "");
  return r;
}
export function deleteBranchFor(repoId, name, opts) {
  return deleteBranch(rootForRepo(repoId), name, opts);
}
export function deleteRemoteBranchFor(repoId, remote, branch) {
  return deleteRemoteBranch(rootForRepo(repoId), remote, branch);
}
export function renameBranchFor(repoId, oldName, newName) {
  return renameBranch(rootForRepo(repoId), oldName, newName);
}
export function mergeFor(repoId, name) {
  const r = merge(rootForRepo(repoId), name);
  refreshPathsFor(repoId, "");
  return r;
}
export function rebaseFor(repoId, onto) {
  const r = rebase(rootForRepo(repoId), onto);
  refreshPathsFor(repoId, "");
  return r;
}
export function cherryPickFor(repoId, hash) {
  const r = cherryPick(rootForRepo(repoId), hash);
  refreshPathsFor(repoId, "");
  return r;
}
export function revertCommitFor(repoId, hash) {
  const r = revertCommit(rootForRepo(repoId), hash);
  refreshPathsFor(repoId, "");
  return r;
}
export function resetToFor(repoId, hash, mode) {
  const r = resetTo(rootForRepo(repoId), hash, mode);
  refreshPathsFor(repoId, "");
  return r;
}
export function createTagFor(repoId, name, opts) {
  return createTag(rootForRepo(repoId), name, opts);
}
export function deleteTagFor(repoId, name) {
  return deleteTag(rootForRepo(repoId), name);
}
export function stashSaveFor(repoId, opts) {
  const r = stashSave(rootForRepo(repoId), opts);
  refreshPathsFor(repoId, "");
  return r;
}
export function stashPopFor(repoId, ref) {
  const r = stashPop(rootForRepo(repoId), ref);
  refreshPathsFor(repoId, "");
  return r;
}
export function stashApplyFor(repoId, ref) {
  const r = stashApply(rootForRepo(repoId), ref);
  refreshPathsFor(repoId, "");
  return r;
}
export function stashDropFor(repoId, ref) {
  return stashDrop(rootForRepo(repoId), ref);
}
export function stashShowFor(repoId, ref) {
  return stashShow(rootForRepo(repoId), ref);
}
export function stashListFor(repoId) {
  return stashList(rootForRepo(repoId));
}
export function setRemoteFor(repoId, name, url, opts) {
  return setRemote(rootForRepo(repoId), name, url, opts);
}
export function removeRemoteFor(repoId, name) {
  return removeRemote(rootForRepo(repoId), name);
}
export function storeGithubCredentialFor(repoId, opts) {
  return storeGithubCredential(rootForRepo(repoId), opts);
}
export function clearGithubCredentialFor(repoId, opts) {
  return clearGithubCredential(rootForRepo(repoId), opts);
}
export function githubCredentialStatusFor(repoId) {
  return githubCredentialStatus(rootForRepo(repoId));
}
export function storeCredentialFor(repoId, opts) {
  return storeCredential(rootForRepo(repoId), opts);
}
export function clearCredentialFor(repoId, opts) {
  return clearCredential(rootForRepo(repoId), opts);
}
export function credentialStatusFor(repoId, opts) {
  return credentialStatus(rootForRepo(repoId), opts);
}
