// repo.js — primitives git BAS NIVEAU, paramétrées par `root` (un clone donné).
//
// Multi-repos : ce module ne connaît AUCUN registre ni état global. Chaque fonction
// reçoit explicitement la racine d'un clone (`root`). L'orchestration par repo
// (résolution du clone, registre, caches) vit dans `repos.js`. Sert deux besoins :
//   1. l'autocomplete des chemins (feature « @ » du dashboard + tool MCP),
//   2. la validation qu'un chemin référencé existe réellement, et le contexte
//      git (branche + commit court) capturé au moment où une référence est créée.
//
// Aucune écriture dans le repo : lecture seule (git ls-files / rev-parse + fs),
// sauf clone/fetch/pull explicites (cloneInto / pull).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

// Env de TOUTES les invocations git : GIT_LITERAL_PATHSPECS=1 neutralise la « magie »
// de pathspec (:(exclude), :/, :!, :(top)…) — un pathspec ne peut JAMAIS échapper au
// chemin littéral fourni (défense en profondeur, en plus du rejet « : » de normalizePath).
// GIT_TERMINAL_PROMPT=0 : jamais de prompt interactif (pas de TTY côté serveur) →
// une auth manquante échoue immédiatement avec un message clair au lieu de bloquer.
const GIT_ENV = { ...process.env, GIT_LITERAL_PATHSPECS: "1", GIT_TERMINAL_PROMPT: "0" };

// Exécute git dans `cwd` et retourne stdout trimé (ou null si échec). Lecture seule.
function git(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: GIT_ENV,
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

// Variante qui capture stderr et renvoie {ok, output} (les commandes d'écriture
// clone/pull doivent remonter leurs erreurs, contrairement au git() lecture-seule).
// `input` (optionnel) → stdin (message de commit multi-lignes, sans souci de quoting).
function gitRun(args, cwd, input) {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: [input != null ? "pipe" : "ignore", "pipe", "pipe"],
      input: input != null ? input : undefined,
      env: GIT_ENV,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, output: String(out).trim() };
  } catch (e) {
    const msg = String(e.stderr || e.stdout || e.message || e).trim();
    return { ok: false, output: msg };
  }
}

export function isGitClone(dir) {
  return !!dir && existsSync(join(dir, ".git"));
}

// Détecte les clones git contenus dans un dossier (import en masse). Inspecte le
// dossier lui-même ET chacun de ses sous-dossiers DIRECTS : profondeur 1, on ne
// descend pas dans les sous-arbres (évite de scanner des arbres de travail entiers
// et les `node_modules`). Lecture seule. Renvoie une liste { path, name } triée
// (chemins absolus, name = nom du dossier). Lève si `dir` n'est pas un dossier.
export function discoverGitRepos(dir) {
  const root = resolve(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Dossier introuvable : ${root}`);
  const found = [];
  const seen = new Set();
  const add = (p) => {
    if (isGitClone(p) && !seen.has(p)) { seen.add(p); found.push({ path: p, name: basename(p) }); }
  };
  add(root);
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (ent.isDirectory() && ent.name !== ".git") add(join(root, ent.name));
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

// Clone `url` dans `root` (crée le dossier parent). Renvoie {ok, output}.
// Refuse les remote-helpers exécutables (ext::/fd::) et les URL en « - » (option-
// injection) ; protocol.ext.allow=never en défense en profondeur.
export function cloneInto(url, root) {
  const u = String(url || "").trim();
  if (!u || /^-/.test(u) || /^(ext|fd)::/i.test(u)) return { ok: false, output: `URL de clone refusée : ${url}` };
  try {
    mkdirSync(dirname(root), { recursive: true });
  } catch {
    /* ignore — clone remontera l'erreur si le parent est inaccessible */
  }
  return gitRun(["-c", "protocol.ext.allow=never", "clone", "--", u, root], dirname(root));
}

// Pull (fetch + merge ff-only) du clone `root`. Renvoie {ok, output}.
export function pull(root) {
  const fetch = gitRun(["fetch", "--all", "--prune"], root);
  const pulled = gitRun(["pull", "--ff-only"], root);
  return { ok: fetch.ok && pulled.ok, pulled: pulled.ok, output: [fetch.output, pulled.output].filter(Boolean).join("\n") };
}

// Normalise un chemin saisi par l'utilisateur en chemin relatif repo, à slashes
// avant. Retourne null si le chemin sort de la racine (anti path-traversal).
export function normalizePath(root, p) {
  if (!p || typeof p !== "string") return null;
  const cleaned = p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!cleaned) return null;
  // Anti « pathspec magic » git (:(exclude), :/, :!, :(top)…) : aucun chemin repo
  // légitime ne commence par « : ». Sinon `git add/clean -- :(exclude)x` détournerait
  // le scoping par chemin (perte de données via discard). Cf. GIT_LITERAL_PATHSPECS.
  if (cleaned.startsWith(":")) return null;
  const abs = resolve(root, cleaned);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) return null;
  return cleaned.replace(/\/+$/, "");
}

// Existence + nature (file/dir) d'un chemin relatif repo. Si `branch` est fourni,
// la vérification se fait dans l'arbre de cette branche (via l'index ls-tree),
// pas dans le working tree. `getIdx(branch)` fournit l'index (caché par repos.js).
export function inspectPath(root, relPath, branch, getIdx) {
  const rel = normalizePath(root, relPath);
  if (!rel) return { path: relPath, exists: false, kind: null };
  if (branch) {
    const idx = getIdx(branch);
    if (idx.fileSet.has(rel)) return { path: rel, exists: true, kind: "file" };
    if (idx.dirSet.has(rel)) return { path: rel, exists: true, kind: "dir" };
    return { path: rel, exists: false, kind: null };
  }
  const abs = join(root, rel);
  if (!existsSync(abs)) return { path: rel, exists: false, kind: null };
  let kind = "file";
  try {
    kind = statSync(abs).isDirectory() ? "dir" : "file";
  } catch {
    /* ignore */
  }
  return { path: rel, exists: true, kind };
}

// Contexte git courant (branche + commit court du HEAD checkout du clone).
export function gitContext(root) {
  if (!isGitClone(root)) return { branch: null, commit: null };
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], root);
  const commit = git(["rev-parse", "--short", "HEAD"], root);
  return { branch: branch || null, commit: commit || null };
}

// Contexte d'une branche choisie (branche + commit court de son sommet). Repli
// sur le HEAD courant si `branch` est nul. Préfère origin/<branch> (clone miroir).
export function branchContext(root, branch) {
  if (!branch) return gitContext(root);
  let commit = git(["rev-parse", "--short", `origin/${branch}`], root);
  if (!commit) commit = git(["rev-parse", "--short", branch], root);
  return { branch, commit: commit || null };
}

// Construit l'index des chemins pour une source. `branch` falsy → working tree.
// Lit l'arbre d'une branche SANS checkout (un seul clone sert toutes les branches).
export function buildIndex(root, branch) {
  let out;
  if (branch) {
    out = git(["ls-tree", "-r", "--name-only", `origin/${branch}`], root);
    if (out == null) out = git(["ls-tree", "-r", "--name-only", branch], root);
  } else {
    out = git(["ls-files"], root);
  }
  const files = out ? out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  const dirSet = new Set();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) dirSet.add(parts.slice(0, i).join("/"));
  }
  return { files, dirs: [...dirSet].sort(), fileSet: new Set(files), dirSet, stamp: Date.now() };
}

// Branches connues du clone (locales + refs/remotes/origin/*), en nom court, plus
// la branche actuellement checkout (working tree).
export function listBranches(root) {
  if (!isGitClone(root)) return { branches: [], current: null };
  const raw = git(["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"], root) || "";
  const names = new Set();
  for (let line of raw.split("\n").map((s) => s.trim()).filter(Boolean)) {
    if (/(^|\/)HEAD$/.test(line)) continue; // ignore origin/HEAD
    if (line.startsWith("origin/")) line = line.slice("origin/".length);
    if (line) names.add(line);
  }
  const current = git(["rev-parse", "--abbrev-ref", "HEAD"], root);
  return { branches: [...names].sort(), current: current || null };
}

// Recherche de chemins (fichiers + dossiers) contenant `query` (insensible casse).
// Priorise : match en début de basename > début de chemin > sous-chaîne. Les
// dossiers remontent avant les fichiers à score égal. `idx` = index pré-construit
// (fourni par repos.js, caché par repo+branche). Limite par défaut 30.
export function searchPaths(idx, query = "", limit = 30) {
  const q = String(query || "").toLowerCase().replace(/\\/g, "/");
  const score = (path, kind) => {
    if (!q) return kind === "dir" ? 1 : 0;
    const lower = path.toLowerCase();
    const at = lower.indexOf(q);
    if (at === -1) return -1;
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    let s = 100;
    if (base.startsWith(q)) s = 0;
    else if (lower.startsWith(q)) s = 10;
    else if (base.includes(q)) s = 30;
    else s = 60;
    return s + at * 0.01 + (kind === "dir" ? -5 : 0) + path.length * 0.001;
  };
  const candidates = [];
  for (const d of idx.dirs) {
    const s = score(d, "dir");
    if (s >= 0) candidates.push({ path: d, kind: "dir", _s: s });
  }
  for (const f of idx.files) {
    const s = score(f, "file");
    if (s >= 0) candidates.push({ path: f, kind: "file", _s: s });
  }
  candidates.sort((a, b) => a._s - b._s);
  return candidates.slice(0, Math.max(1, Math.min(200, limit))).map(({ path, kind }) => ({ path, kind }));
}

// ═══════════════════════════════════════════════════════════════════════════
// Gestionnaire de repos — primitives git LECTURE + ÉCRITURE (status, log/graphe,
// diff, staging, commit, sync distant, branches, merge, stash, tags, config, et
// opérations ciblées commit : cherry-pick/revert/reset). Toutes paramétrées par
// `root`. Sécurité : chemins normalisés (anti path-traversal) + `--` avant tout
// pathspec + GIT_LITERAL_PATHSPECS, refs validées (anti option-injection), hash hex
// strict, exécution SANS shell (execFile).
// ═══════════════════════════════════════════════════════════════════════════

const FS = "\x1f"; // séparateur de champ (unit separator)
const RS = "\x1e"; // séparateur d'enregistrement (record separator)

function normPaths(root, paths) {
  const arr = Array.isArray(paths) ? paths : paths == null ? [] : [paths];
  const out = [];
  for (const p of arr) {
    const n = normalizePath(root, p);
    if (n) out.push(n);
  }
  return [...new Set(out)];
}

const isHash = (h) => /^[0-9a-fA-F]{4,64}$/.test(String(h || ""));

// Valide un nom de branche / ref : anti option-injection (`-…`) + caractères
// interdits par git. Strict mais conforme aux noms usuels (y compris `feat/x`).
export function isValidRef(name) {
  const s = String(name || "").trim();
  if (!s || s.length > 255) return false;
  if (s.startsWith("-")) return false; // anti option-injection
  if (/[\x00-\x20~^:?*\[\\]/.test(s)) return false; // contrôle, espace, métachars git
  if (s.includes("..") || s.includes("@{")) return false;
  if (/^\/|\/$|\/\/|\.lock(\/|$)|(^|\/)\.|\.$/.test(s)) return false;
  return true;
}
const isValidRemoteName = (n) => /^[A-Za-z0-9._\/-]{1,100}$/.test(String(n || "")) && !String(n).startsWith("-");

// ── Lecture ──────────────────────────────────────────────────────────────────

// État du working tree : branche, upstream, ahead/behind + liste de fichiers avec
// leur statut index (x) / worktree (y). Parse `git status --porcelain=v1 -z -b`.
export function status(root) {
  if (!isGitClone(root)) return { ok: false, output: `Pas un clone git : ${root}`, files: [] };
  const raw = git(["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"], root);
  if (raw == null) return { ok: false, output: "git status a échoué", files: [] };
  const parts = raw.split("\0");
  let branch = null;
  let upstream = null;
  let ahead = 0;
  let behind = 0;
  let detached = false;
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith("##")) {
      let head = line.slice(2).trim();
      if (head.startsWith("No commits yet on ")) head = head.slice("No commits yet on ".length);
      if (head.startsWith("HEAD (no branch)")) {
        detached = true;
      } else {
        const m = head.match(/^(.+?)(?:\.\.\.(\S+))?(?:\s\[(.+)\])?$/);
        if (m) {
          branch = m[1];
          upstream = m[2] || null;
          if (m[3]) {
            const a = m[3].match(/ahead (\d+)/);
            const b = m[3].match(/behind (\d+)/);
            ahead = a ? Number(a[1]) : 0;
            behind = b ? Number(b[1]) : 0;
          }
        }
      }
      continue;
    }
    const x = line[0];
    const y = line[1];
    const path = line.slice(3);
    let oldPath = null;
    if (x === "R" || x === "C") oldPath = parts[++i] || null; // -z : ancien chemin = entrée suivante
    files.push({
      path,
      oldPath,
      x,
      y,
      staged: x !== " " && x !== "?",
      unstaged: (y !== " " && y !== "?") || x === "?",
      untracked: x === "?",
      conflicted: x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D"),
    });
  }
  return { ok: true, branch, upstream, ahead, behind, detached, files };
}

// Décore un commit : parse la sortie `%D` ("HEAD -> main, origin/main, tag: v1").
function parseRefs(deco, remotes) {
  const out = [];
  for (let token of String(deco || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    let head = false;
    if (token === "HEAD") {
      out.push({ name: "HEAD", kind: "head", head: true });
      continue;
    }
    if (token.startsWith("HEAD -> ")) {
      head = true;
      token = token.slice("HEAD -> ".length);
    }
    if (token.startsWith("tag: ")) {
      out.push({ name: token.slice(5), kind: "tag" });
      continue;
    }
    const seg = token.split("/")[0];
    out.push({ name: token, kind: remotes.includes(seg) ? "remote" : "local", head });
  }
  return out;
}

// Données du graphe d'historique : commits de toutes les refs en ordre topo/date,
// avec parents + décorations. Le calcul des « lanes » est fait côté client.
// `excludeRefs` (optionnel) : globs `--exclude=…` appliqués avant `--all` pour
// retirer les branches cachées — `git log` ignore alors leurs refs, donc les
// commits qui leur sont exclusifs disparaissent (les commits partagés restent).
export function logGraph(root, { limit = 300, all = true, excludeRefs = null } = {}) {
  if (!isGitClone(root)) return { commits: [], head: null };
  const remotes = (git(["remote"], root) || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const fmt = ["%H", "%h", "%P", "%an", "%ae", "%cr", "%cI", "%s", "%D"].join(FS) + RS;
  const args = ["log", `--max-count=${Math.max(1, Math.min(2000, limit))}`, "--date-order", `--pretty=format:${fmt}`];
  if (Array.isArray(excludeRefs)) args.push(...excludeRefs); // doit précéder --all
  if (all) args.push("--all");
  const raw = git(args, root);
  if (raw == null) return { commits: [], head: null };
  const commits = [];
  for (const rec of raw.split(RS)) {
    const r = rec.replace(/^\n/, "");
    if (!r.trim()) continue;
    const f = r.split(FS);
    if (f.length < 9) continue;
    const [hash, short, parents, an, ae, cr, ci, subject, deco] = f;
    commits.push({
      hash,
      short,
      parents: parents.trim() ? parents.trim().split(/\s+/) : [],
      author: an,
      email: ae,
      date: cr,
      dateIso: ci,
      subject,
      refs: parseRefs(deco, remotes),
    });
  }
  const head = git(["rev-parse", "HEAD"], root);
  return { commits, head: head || null };
}

// Branches détaillées pour la sidebar : locales (upstream + ahead/behind) + remotes.
export function branchesDetailed(root) {
  if (!isGitClone(root)) return { current: null, local: [], remote: [] };
  const current = git(["rev-parse", "--abbrev-ref", "HEAD"], root) || null;
  const localRaw =
    git(["for-each-ref", "--format=" + ["%(refname:short)", "%(upstream:short)", "%(upstream:track)", "%(objectname:short)"].join(FS), "refs/heads"], root) || "";
  const local = localRaw
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [name, upstream, track, sha] = l.split(FS);
      const a = (track || "").match(/ahead (\d+)/);
      const b = (track || "").match(/behind (\d+)/);
      return { name, upstream: upstream || null, ahead: a ? Number(a[1]) : 0, behind: b ? Number(b[1]) : 0, sha, current: name === current };
    });
  const remoteRaw = git(["for-each-ref", "--format=" + ["%(refname:short)", "%(objectname:short)"].join(FS), "refs/remotes"], root) || "";
  const remote = remoteRaw
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [name, sha] = l.split(FS);
      return { name, sha };
    })
    .filter((r) => !/\/HEAD$/.test(r.name));
  return { current, local, remote };
}

// Diff d'un fichier (staged ou worktree). Fichier non suivi → diff vs /dev/null.
export function diffFile(root, relPath, { staged = false, untracked = false } = {}) {
  if (!isGitClone(root)) return { ok: false, output: "Pas un clone git" };
  const rel = normalizePath(root, relPath);
  if (!rel) return { ok: false, output: "Chemin invalide" };
  if (untracked && !staged) {
    const r = gitRun(["diff", "--no-index", "--no-color", "--", "/dev/null", rel], root);
    return { ok: true, path: rel, staged: false, untracked: true, diff: r.output || "" };
  }
  const out = git(staged ? ["diff", "--cached", "--no-color", "--", rel] : ["diff", "--no-color", "--", rel], root);
  return { ok: true, path: rel, staged, untracked: false, diff: out || "" };
}

// Diff complet des fichiers indexés (rédaction IA du message de commit), borné.
export function stagedDiff(root, { maxBytes = 60000 } = {}) {
  if (!isGitClone(root)) return "";
  const out = git(["diff", "--cached", "--no-color"], root) || "";
  return out.length > maxBytes ? out.slice(0, maxBytes) + "\n…(diff tronqué)" : out;
}

// Détail d'un commit : métadonnées + fichiers (numstat). Hash hex strict.
export function commitDetail(root, hash) {
  if (!isGitClone(root) || !isHash(hash)) return { ok: false, output: "hash invalide" };
  const fmt = ["%H", "%an", "%ae", "%cI", "%cr", "%P", "%s", "%b"].join(FS);
  const meta = git(["show", "-s", `--pretty=format:${fmt}`, hash], root);
  if (meta == null) return { ok: false, output: "commit introuvable" };
  const parts = meta.split(FS);
  const [H, an, ae, ci, cr, P, subject] = parts;
  const body = parts.slice(7).join(FS);
  const files = (git(["show", "--numstat", "--pretty=format:", hash], root) || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [add, del, ...p] = l.split("\t");
      return { added: add, deleted: del, path: p.join("\t") };
    });
  return { ok: true, hash: H, author: an, email: ae, dateIso: ci, date: cr, parents: P.trim() ? P.trim().split(/\s+/) : [], subject, body, files };
}

// Config git du repo + remotes (pour la page de configuration).
const ALLOWED_CONFIG = new Set(["user.name", "user.email", "core.autocrlf", "pull.rebase", "commit.gpgsign"]);
export function getGitConfig(root) {
  if (!isGitClone(root)) return { ok: false };
  const get = (k) => git(["config", "--get", k], root) || "";
  const remotesRaw = git(["remote", "-v"], root) || "";
  const remotes = {};
  for (const line of remotesRaw.split("\n").filter(Boolean)) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (m) {
      remotes[m[1]] = remotes[m[1]] || { name: m[1], fetch: "", push: "" };
      remotes[m[1]][m[3]] = m[2];
    }
  }
  return {
    ok: true,
    userName: get("user.name"),
    userEmail: get("user.email"),
    autocrlf: get("core.autocrlf"),
    pullRebase: get("pull.rebase"),
    remotes: Object.values(remotes),
  };
}
export function setGitConfig(root, key, value) {
  if (!isGitClone(root)) return { ok: false, output: "Pas un clone git" };
  if (!ALLOWED_CONFIG.has(key)) return { ok: false, output: `Clé non autorisée : ${key}` };
  const v = String(value == null ? "" : value);
  if (/^-/.test(v)) return { ok: false, output: "Valeur invalide" };
  if (v === "") {
    const r = gitRun(["config", "--unset", key], root);
    return r.ok || /did not match|n'a pas/i.test(r.output) ? { ok: true, output: "" } : r; // unset d'une clé absente = ok
  }
  return gitRun(["config", key, v], root);
}

// ── Écriture (working tree / index) ───────────────────────────────────────────

export function stage(root, paths, all = false) {
  if (!isGitClone(root)) return { ok: false, output: "Pas un clone git" };
  if (all) return gitRun(["add", "-A"], root);
  const rels = normPaths(root, paths);
  if (!rels.length) return { ok: false, output: "Aucun chemin valide" };
  return gitRun(["add", "--", ...rels], root);
}

export function unstage(root, paths, all = false) {
  if (!isGitClone(root)) return { ok: false, output: "Pas un clone git" };
  if (all) return gitRun(["reset", "-q", "HEAD"], root);
  const rels = normPaths(root, paths);
  if (!rels.length) return { ok: false, output: "Aucun chemin valide" };
  return gitRun(["reset", "-q", "HEAD", "--", ...rels], root);
}

// DESTRUCTIF : restaure les fichiers suivis (worktree) + supprime les non-suivis.
export function discard(root, paths) {
  if (!isGitClone(root)) return { ok: false, output: "Pas un clone git" };
  const rels = normPaths(root, paths);
  if (!rels.length) return { ok: false, output: "Aucun chemin valide" };
  const restore = gitRun(["restore", "--worktree", "--", ...rels], root);
  const clean = gitRun(["clean", "-fd", "--", ...rels], root);
  return { ok: restore.ok || clean.ok, output: [restore.output, clean.output].filter(Boolean).join("\n") };
}

// Commit des fichiers indexés. Message via stdin (`-F -`) → aucun souci de quoting.
export function commit(root, message) {
  if (!isGitClone(root)) return { ok: false, output: "Pas un clone git" };
  const msg = String(message || "").trim();
  if (!msg) return { ok: false, output: "Message de commit vide" };
  return gitRun(["commit", "-F", "-"], root, msg + "\n");
}

// ── Sync distant ──────────────────────────────────────────────────────────────

export function fetchRemote(root) {
  return isGitClone(root) ? gitRun(["fetch", "--all", "--prune"], root) : { ok: false, output: "Pas un clone git" };
}

export function push(root, { setUpstream = false } = {}) {
  if (!isGitClone(root)) return { ok: false, output: "Pas un clone git" };
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], root);
  if (setUpstream && branch && branch !== "HEAD") return gitRun(["push", "-u", "origin", branch], root);
  return gitRun(["push"], root);
}

// ── Branches / merge ──────────────────────────────────────────────────────────

export function createBranch(root, name, { checkout = true, ref = null } = {}) {
  if (!isGitClone(root)) return { ok: false, output: "Pas un clone git" };
  if (!isValidRef(name)) return { ok: false, output: `Nom de branche invalide : ${name}` };
  if (ref != null && !isHash(ref) && !isValidRef(ref)) return { ok: false, output: "Réf cible invalide" };
  const tail = ref != null ? [ref] : [];
  return checkout ? gitRun(["checkout", "-b", name, ...tail], root) : gitRun(["branch", name, ...tail], root);
}

export function checkoutBranch(root, name) {
  if (!isGitClone(root)) return { ok: false, output: "Pas un clone git" };
  if (!isValidRef(name)) return { ok: false, output: `Réf invalide : ${name}` };
  return gitRun(["checkout", name], root); // DWIM : crée le suivi local d'un origin/<name>
}

// Checkout d'un commit précis (HEAD détaché). Hash hex strict.
export function checkoutCommit(root, hash) {
  if (!isGitClone(root)) return { ok: false, output: "Pas un clone git" };
  if (!isHash(hash)) return { ok: false, output: "hash invalide" };
  return gitRun(["checkout", hash], root);
}

export function deleteBranch(root, name, { force = false } = {}) {
  if (!isGitClone(root)) return { ok: false, output: "Pas un clone git" };
  if (!isValidRef(name)) return { ok: false, output: `Nom de branche invalide : ${name}` };
  return gitRun(["branch", force ? "-D" : "-d", name], root);
}

// Supprime une branche côté distant : git push <remote> --delete <branch>.
// `remote` (ex. origin) et `branch` (ex. feature/x) validés séparément.
export function deleteRemoteBranch(root, remote, branch) {
  if (!isGitClone(root)) return { ok: false, output: "Pas un clone git" };
  if (!isValidRef(remote) || !isValidRef(branch)) return { ok: false, output: "Nom de remote ou de branche invalide" };
  return gitRun(["push", remote, "--delete", branch], root);
}

export function renameBranch(root, oldName, newName) {
  if (!isGitClone(root)) return { ok: false, output: "Pas un clone git" };
  if (!isValidRef(oldName) || !isValidRef(newName)) return { ok: false, output: "Nom de branche invalide" };
  return gitRun(["branch", "-m", oldName, newName], root);
}

export function merge(root, name) {
  if (!isGitClone(root)) return { ok: false, output: "Pas un clone git" };
  if (!isValidRef(name)) return { ok: false, output: `Réf invalide : ${name}` };
  return gitRun(["merge", "--no-edit", name], root);
}

// ── Opérations ciblées sur un commit (hash hex strict) ────────────────────────

export function cherryPick(root, hash) {
  if (!isGitClone(root)) return { ok: false, output: "Pas un clone git" };
  if (!isHash(hash)) return { ok: false, output: "hash invalide" };
  return gitRun(["cherry-pick", hash], root);
}

export function revertCommit(root, hash) {
  if (!isGitClone(root)) return { ok: false, output: "Pas un clone git" };
  if (!isHash(hash)) return { ok: false, output: "hash invalide" };
  return gitRun(["revert", "--no-edit", hash], root);
}

// DESTRUCTIF (surtout --hard) : déplace la branche courante sur `hash`.
export function resetTo(root, hash, mode = "mixed") {
  if (!isGitClone(root)) return { ok: false, output: "Pas un clone git" };
  if (!isHash(hash)) return { ok: false, output: "hash invalide" };
  const m = ["soft", "mixed", "hard"].includes(mode) ? mode : "mixed";
  return gitRun(["reset", `--${m}`, hash], root);
}

// ── Tags ──────────────────────────────────────────────────────────────────────

export function createTag(root, name, { ref = "HEAD", message = "" } = {}) {
  if (!isGitClone(root)) return { ok: false, output: "Pas un clone git" };
  if (!isValidRef(name)) return { ok: false, output: `Nom de tag invalide : ${name}` };
  const target = ref === "HEAD" ? "HEAD" : ref;
  if (target !== "HEAD" && !isHash(target) && !isValidRef(target)) return { ok: false, output: "Réf cible invalide" };
  const m = String(message || "").trim();
  return m ? gitRun(["tag", "-a", name, "-m", m, target], root) : gitRun(["tag", name, target], root);
}

export function deleteTag(root, name) {
  if (!isGitClone(root)) return { ok: false, output: "Pas un clone git" };
  if (!isValidRef(name)) return { ok: false, output: "Nom de tag invalide" };
  return gitRun(["tag", "-d", name], root);
}

// ── Stash ─────────────────────────────────────────────────────────────────────

export function stashSave(root, { message = "", includeUntracked = true } = {}) {
  if (!isGitClone(root)) return { ok: false, output: "Pas un clone git" };
  const args = ["stash", "push"];
  if (includeUntracked) args.push("-u");
  const m = String(message || "").trim();
  if (m) args.push("-m", m.slice(0, 200));
  return gitRun(args, root);
}

export function stashPop(root) {
  return isGitClone(root) ? gitRun(["stash", "pop"], root) : { ok: false, output: "Pas un clone git" };
}

export function stashList(root) {
  if (!isGitClone(root)) return [];
  const out = git(["stash", "list", "--pretty=format:%gd" + FS + "%s"], root) || "";
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((l) => {
      const [ref, desc] = l.split(FS);
      return { ref, desc: desc || "" };
    });
}

// ── Remotes (page de configuration) ──────────────────────────────────────────

export function setRemote(root, name, url, { add = false } = {}) {
  if (!isGitClone(root)) return { ok: false, output: "Pas un clone git" };
  if (!isValidRemoteName(name)) return { ok: false, output: `Nom de remote invalide : ${name}` };
  const u = String(url || "").trim();
  if (!u || /^-/.test(u) || /^(ext|fd)::/i.test(u)) return { ok: false, output: `URL refusée : ${url}` };
  return add ? gitRun(["remote", "add", name, u], root) : gitRun(["remote", "set-url", name, u], root);
}

export function removeRemote(root, name) {
  if (!isGitClone(root)) return { ok: false, output: "Pas un clone git" };
  if (!isValidRemoteName(name)) return { ok: false, output: "Nom de remote invalide" };
  return gitRun(["remote", "remove", name], root);
}

// ── GitHub : authentification via le credential helper ─────────────────────────
// Le device flow (server.js) obtient un token OAuth ; on le persiste dans le
// credential store standard de git (helper « store » → ~/.git-credentials) pour que
// `git push` HTTPS fonctionne sans prompt. Le token transite UNIQUEMENT par stdin
// (jamais en argument de ligne de commande, jamais loggé, jamais renvoyé au client).

// Neutralise toute injection : un \n permettrait d'écrire d'autres clés du protocole
// credential (ex. forcer un autre host/url). On supprime les retours de ligne.
function sanitizeCredField(v) {
  return String(v == null ? "" : v).replace(/[\r\n]/g, "").trim();
}

// Active le helper « store » au niveau global (fichier ~/.git-credentials standard).
export function enableCredentialStore(root) {
  return gitRun(["config", "--global", "credential.helper", "store"], root);
}

// Seuls http/https sont acceptés (le helper credential ne gère pas ssh ; http permet
// les Gitea/Forgejo auto-hébergés en clair). Host : domaine ou domaine:port.
function normProtocol(p) {
  const v = sanitizeCredField(p).toLowerCase();
  return v === "http" ? "http" : "https";
}

// ── Credentials HTTP(S) génériques (github.com, Gitea, GitLab self-hosted…) ─────
// Persiste (username, password/token) pour <protocol>://<host> via `git credential
// approve`. Le secret transite UNIQUEMENT par stdin (jamais en argument, jamais loggé,
// jamais renvoyé au client). Toute remote pointant cet hôte l'utilisera ensuite.
export function storeCredential(root, { protocol = "https", host, username, password } = {}) {
  if (!isGitClone(root)) return { ok: false, output: "Pas un clone git" };
  const h = sanitizeCredField(host);
  if (!h) return { ok: false, output: "Hôte requis (ex. gitea.exemple.com ou gitea.exemple.com:3000)" };
  const pw = String(password || "");
  if (!pw || /[\r\n]/.test(pw)) return { ok: false, output: "Mot de passe / token invalide" };
  const ensured = enableCredentialStore(root);
  if (!ensured.ok) return ensured;
  const p = normProtocol(protocol);
  const u = sanitizeCredField(username);
  const input = `protocol=${p}\nhost=${h}\nusername=${u}\npassword=${pw}\n\n`;
  const r = gitRun(["credential", "approve"], root, input);
  // `approve` ne produit pas de sortie : on ne renvoie jamais l'input (secret).
  return r.ok ? { ok: true, output: "" } : { ok: false, output: r.output };
}

// Oublie le credential <protocol>://<host> via `git credential reject`.
export function clearCredential(root, { protocol = "https", host, username } = {}) {
  if (!isGitClone(root)) return { ok: false, output: "Pas un clone git" };
  const h = sanitizeCredField(host);
  if (!h) return { ok: false, output: "Hôte requis" };
  const p = normProtocol(protocol);
  const u = sanitizeCredField(username);
  const input = `protocol=${p}\nhost=${h}\n${u ? `username=${u}\n` : ""}\n`;
  const r = gitRun(["credential", "reject"], root, input);
  return r.ok ? { ok: true, output: "" } : { ok: false, output: r.output };
}

// État d'un credential SANS jamais exposer le mot de passe : on lit via `git
// credential fill` et on ne renvoie que { connected, username }. Si rien n'est
// stocké, fill échoue (prompt désactivé par GIT_TERMINAL_PROMPT=0) → non connecté.
export function credentialStatus(root, { protocol = "https", host } = {}) {
  if (!isGitClone(root)) return { connected: false, username: null };
  const h = sanitizeCredField(host);
  if (!h) return { connected: false, username: null };
  const p = normProtocol(protocol);
  const r = gitRun(["credential", "fill"], root, `protocol=${p}\nhost=${h}\n\n`);
  if (!r.ok) return { connected: false, username: null };
  const out = r.output || "";
  const pw = /(?:^|\n)password=(.+)/.exec(out);
  const un = /(?:^|\n)username=(.+)/.exec(out);
  return { connected: !!(pw && pw[1]), username: un ? un[1].trim() : null };
}

// ── GitHub : raccourcis (host fixe github.com) au-dessus des primitives génériques ─
export function storeGithubCredential(root, { username, token } = {}) {
  return storeCredential(root, { protocol: "https", host: "github.com", username, password: token });
}
export function clearGithubCredential(root, { username } = {}) {
  return clearCredential(root, { protocol: "https", host: "github.com", username });
}
export function githubCredentialStatus(root) {
  return credentialStatus(root, { protocol: "https", host: "github.com" });
}
