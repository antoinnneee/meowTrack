// routes/git.js — gestionnaire git (lectures non verrouillées + écritures
// sérialisées par dépôt via withGitLock), versionnement du tracking, et message de
// commit suggéré par l'IA. Les routes d'auth GitHub / credentials vivent dans
// routes/github.js (chemins exacts, pas de collision avec ce module).

import { send, readBody, repoOf } from "../http-util.js";
import { hideBranch, unhideBranch } from "../db.js";
import {
  statusFor,
  logGraphFor,
  branchesDetailedFor,
  stashListFor,
  getGitConfigFor,
  setGitConfigFor,
  diffFileFor,
  commitDetailFor,
  listTreeFor,
  fileContentFor,
  stageFor,
  unstageFor,
  discardFor,
  commitFor,
  fetchFor,
  pushFor,
  pullRepo,
  createBranchFor,
  renameBranchFor,
  deleteBranchFor,
  deleteRemoteBranchFor,
  checkoutBranchFor,
  checkoutCommitFor,
  mergeFor,
  cherryPickFor,
  revertCommitFor,
  resetToFor,
  createTagFor,
  deleteTagFor,
  stashSaveFor,
  stashPopFor,
  setRemoteFor,
  removeRemoteFor,
  getTrackingConfig,
  setTrackingConfig,
  flushTrackingCommits,
} from "../repos.js";
import { suggestCommitMessage } from "../ai/claude.js";

// Verrou anti-collision : une seule opération git MUTANTE en vol par repo (sinon
// 409). Les lectures (status/log/diff) ne sont pas verrouillées.
const gitLocks = new Set();
async function withGitLock(repoId, res, fn) {
  if (gitLocks.has(repoId)) return send(res, 409, { error: "git_busy", message: "Une opération git est déjà en cours sur ce repo." });
  gitLocks.add(repoId);
  try {
    return await fn();
  } finally {
    gitLocks.delete(repoId);
  }
}

export async function handle(ctx) {
  const { req, res, method, path, q } = ctx;

  // ── Lectures (non verrouillées) ──
  if (method === "GET" && path === "/api/git/status") {
    send(res, 200, statusFor(repoOf(q)));
    return true;
  }
  if (method === "GET" && path === "/api/git/log") {
    send(res, 200, logGraphFor(repoOf(q), { limit: Number(q.get("limit")) || 300 }));
    return true;
  }
  if (method === "GET" && path === "/api/git/branches") {
    send(res, 200, branchesDetailedFor(repoOf(q)));
    return true;
  }
  // Masquage de branche (par dépôt) : retire/affiche une branche des sélecteurs
  // (topbar, modale, autocomplete « @ »). Sans effet sur le dépôt git lui-même.
  if (method === "POST" && path === "/api/git/branch/hide") {
    const { name } = await readBody(req);
    send(res, 200, hideBranch(repoOf(q), name));
    return true;
  }
  if (method === "POST" && path === "/api/git/branch/unhide") {
    const { name } = await readBody(req);
    send(res, 200, unhideBranch(repoOf(q), name));
    return true;
  }
  if (method === "GET" && path === "/api/git/stashes") {
    send(res, 200, stashListFor(repoOf(q)));
    return true;
  }
  if (method === "GET" && path === "/api/git/config") {
    send(res, 200, getGitConfigFor(repoOf(q)));
    return true;
  }
  // ── Versionnement du tracking (global, instance) : config + commit manuel ──
  if (method === "GET" && path === "/api/tracking/config") {
    send(res, 200, getTrackingConfig());
    return true;
  }
  if (method === "POST" && path === "/api/tracking/config") {
    const body = await readBody(req);
    send(res, 200, setTrackingConfig(body));
    return true;
  }
  if (method === "POST" && path === "/api/tracking/commit") {
    flushTrackingCommits(); // commit (+ push opt-in) immédiat de tous les trackers
    send(res, 200, getTrackingConfig());
    return true;
  }
  if (method === "GET" && path === "/api/git/diff") {
    send(res, 200, diffFileFor(repoOf(q), q.get("path") || "", { staged: q.get("staged") === "true", untracked: q.get("untracked") === "true" }));
    return true;
  }
  // Explorateur de fichiers : arbre complet + contenu d'un fichier (branche
  // optionnelle). Lectures seules, non verrouillées.
  if (method === "GET" && path === "/api/git/tree") {
    send(res, 200, listTreeFor(repoOf(q), q.get("branch") || null));
    return true;
  }
  if (method === "GET" && path === "/api/git/file") {
    send(res, 200, fileContentFor(repoOf(q), q.get("path") || "", q.get("branch") || null));
    return true;
  }
  const gitCommitMatch = path.match(/^\/api\/git\/commit\/([0-9a-fA-F]{4,64})$/);
  if (method === "GET" && gitCommitMatch) {
    send(res, 200, commitDetailFor(repoOf(q), gitCommitMatch[1]));
    return true;
  }

  // ── Écritures (verrouillées par repo) ──
  if (method === "POST" && path === "/api/git/stage") {
    const body = await readBody(req);
    const id = repoOf(q, body);
    await withGitLock(id, res, () => send(res, 200, stageFor(id, body.paths, !!body.all)));
    return true;
  }
  if (method === "POST" && path === "/api/git/unstage") {
    const body = await readBody(req);
    const id = repoOf(q, body);
    await withGitLock(id, res, () => send(res, 200, unstageFor(id, body.paths, !!body.all)));
    return true;
  }
  if (method === "POST" && path === "/api/git/discard") {
    const body = await readBody(req);
    const id = repoOf(q, body);
    await withGitLock(id, res, () => send(res, 200, discardFor(id, body.paths)));
    return true;
  }
  if (method === "POST" && path === "/api/git/commit") {
    const body = await readBody(req);
    const id = repoOf(q, body);
    await withGitLock(id, res, () => send(res, 200, commitFor(id, body.message)));
    return true;
  }
  if (method === "POST" && path === "/api/git/commit-message") {
    const message = await suggestCommitMessage(repoOf(q, await readBody(req)));
    send(res, 200, { message });
    return true;
  }
  if (method === "POST" && path === "/api/git/fetch") {
    const id = repoOf(q, await readBody(req));
    await withGitLock(id, res, () => send(res, 200, fetchFor(id)));
    return true;
  }
  if (method === "POST" && path === "/api/git/pull") {
    const id = repoOf(q, await readBody(req));
    await withGitLock(id, res, () => send(res, 200, pullRepo(id)));
    return true;
  }
  if (method === "POST" && path === "/api/git/push") {
    const body = await readBody(req);
    const id = repoOf(q, body);
    await withGitLock(id, res, () => send(res, 200, pushFor(id, { setUpstream: !!body.setUpstream })));
    return true;
  }
  if (method === "POST" && path === "/api/git/branch") {
    const body = await readBody(req);
    const id = repoOf(q, body);
    await withGitLock(id, res, () => send(res, 200, createBranchFor(id, body.name, { checkout: body.checkout !== false, ref: body.ref || null })));
    return true;
  }
  if (method === "POST" && path === "/api/git/branch/rename") {
    const body = await readBody(req);
    const id = repoOf(q, body);
    await withGitLock(id, res, () => send(res, 200, renameBranchFor(id, body.oldName, body.newName)));
    return true;
  }
  if (method === "POST" && path === "/api/git/branch/delete") {
    const body = await readBody(req);
    const id = repoOf(q, body);
    await withGitLock(id, res, () => send(res, 200, deleteBranchFor(id, body.name, { force: !!body.force })));
    return true;
  }
  if (method === "POST" && path === "/api/git/branch/delete-remote") {
    const body = await readBody(req);
    const id = repoOf(q, body);
    await withGitLock(id, res, () => send(res, 200, deleteRemoteBranchFor(id, body.remote, body.branch)));
    return true;
  }
  if (method === "POST" && path === "/api/git/checkout") {
    const body = await readBody(req);
    const id = repoOf(q, body);
    await withGitLock(id, res, () => send(res, 200, checkoutBranchFor(id, body.name)));
    return true;
  }
  if (method === "POST" && path === "/api/git/checkout-commit") {
    const body = await readBody(req);
    const id = repoOf(q, body);
    await withGitLock(id, res, () => send(res, 200, checkoutCommitFor(id, body.hash)));
    return true;
  }
  if (method === "POST" && path === "/api/git/merge") {
    const body = await readBody(req);
    const id = repoOf(q, body);
    await withGitLock(id, res, () => send(res, 200, mergeFor(id, body.name)));
    return true;
  }
  if (method === "POST" && path === "/api/git/cherry-pick") {
    const body = await readBody(req);
    const id = repoOf(q, body);
    await withGitLock(id, res, () => send(res, 200, cherryPickFor(id, body.hash)));
    return true;
  }
  if (method === "POST" && path === "/api/git/revert") {
    const body = await readBody(req);
    const id = repoOf(q, body);
    await withGitLock(id, res, () => send(res, 200, revertCommitFor(id, body.hash)));
    return true;
  }
  if (method === "POST" && path === "/api/git/reset") {
    const body = await readBody(req);
    const id = repoOf(q, body);
    await withGitLock(id, res, () => send(res, 200, resetToFor(id, body.hash, body.mode)));
    return true;
  }
  if (method === "POST" && path === "/api/git/tag") {
    const body = await readBody(req);
    const id = repoOf(q, body);
    await withGitLock(id, res, () => send(res, 200, createTagFor(id, body.name, { ref: body.ref || "HEAD", message: body.message || "" })));
    return true;
  }
  if (method === "POST" && path === "/api/git/tag/delete") {
    const body = await readBody(req);
    const id = repoOf(q, body);
    await withGitLock(id, res, () => send(res, 200, deleteTagFor(id, body.name)));
    return true;
  }
  if (method === "POST" && path === "/api/git/stash") {
    const body = await readBody(req);
    const id = repoOf(q, body);
    await withGitLock(id, res, () => send(res, 200, stashSaveFor(id, { message: body.message, includeUntracked: body.includeUntracked !== false })));
    return true;
  }
  if (method === "POST" && path === "/api/git/stash/pop") {
    const id = repoOf(q, await readBody(req));
    await withGitLock(id, res, () => send(res, 200, stashPopFor(id)));
    return true;
  }
  if (method === "POST" && path === "/api/git/config") {
    const body = await readBody(req);
    const id = repoOf(q, body);
    const results = {};
    if ("userName" in body) results.userName = setGitConfigFor(id, "user.name", body.userName);
    if ("userEmail" in body) results.userEmail = setGitConfigFor(id, "user.email", body.userEmail);
    if ("autocrlf" in body) results.autocrlf = setGitConfigFor(id, "core.autocrlf", body.autocrlf);
    if ("pullRebase" in body) results.pullRebase = setGitConfigFor(id, "pull.rebase", body.pullRebase);
    send(res, 200, { ok: Object.values(results).every((r) => r.ok), results, config: getGitConfigFor(id) });
    return true;
  }
  if (method === "POST" && path === "/api/git/remote") {
    const body = await readBody(req);
    const id = repoOf(q, body);
    await withGitLock(id, res, () => send(res, 200, setRemoteFor(id, body.name, body.url, { add: !!body.add })));
    return true;
  }
  if (method === "POST" && path === "/api/git/remote/delete") {
    const body = await readBody(req);
    const id = repoOf(q, body);
    await withGitLock(id, res, () => send(res, 200, removeRemoteFor(id, body.name)));
    return true;
  }

  return false;
}
