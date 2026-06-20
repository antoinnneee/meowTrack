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
import { mkdirSync, rmSync } from "node:fs";
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
  branchesDetailed,
  diffFile,
  stagedDiff,
  commitDetail,
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
  cherryPick,
  revertCommit,
  resetTo,
  createTag,
  deleteTag,
  stashSave,
  stashPop,
  stashList,
  setRemote,
  removeRemote,
  storeGithubCredential,
  clearGithubCredential,
  githubCredentialStatus,
  storeCredential,
  clearCredential,
  credentialStatus,
} from "./repo.js";
import { getRepoRow, listRepoRows, createRepo } from "./db.js";

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
  try {
    rmSync(join(trackingRoot(), slug), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
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
export function listBranchesFor(repoId) {
  return listBranches(rootForRepo(repoId));
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

export function pullRepo(repoId) {
  const root = rootForRepo(repoId);
  if (!isGitClone(root)) return { ok: false, output: `Pas un clone git : ${root}`, root };
  const r = pull(root);
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
export function logGraphFor(repoId, opts) {
  return logGraph(rootForRepo(repoId), opts);
}
export function branchesDetailedFor(repoId) {
  return branchesDetailed(rootForRepo(repoId));
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
export function commitFor(repoId, message) {
  return commit(rootForRepo(repoId), message);
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
export function stashPopFor(repoId) {
  const r = stashPop(rootForRepo(repoId));
  refreshPathsFor(repoId, "");
  return r;
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
