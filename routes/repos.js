// routes/repos.js — registre des dépôts (CRUD), métadonnées (/api/meta), branches,
// autocomplete de chemins, mise à jour du clone, et « Améliorer (IA) ».
//
// handle(ctx) renvoie true si la requête a été traitée (réponse envoyée), sinon
// falsy → le routeur (server.js) essaie le module suivant.

import { send, readBody, repoOf } from "../http-util.js";
import { PORT } from "../config.js";
import { listRepos, createRepo, getRepo, getRepoRow, updateRepo, deleteRepo, rotateRepoToken, resolveRepoId, stats } from "../db.js";
import {
  ensureRepo,
  importReposFromDir,
  gitContextFor,
  invalidateRepo,
  removeManagedClone,
  listBranchesFor,
  searchPathsFor,
  refreshPathsFor,
  rootForRepo,
  resolveRepoByPath,
  provisionRepoTokenFile,
} from "../repos.js";
import { improveDescriptionWithClaude } from "../ai/claude.js";

// Racine de clone d'un repo, tolérante (null si non résolvable — ex. repo sans
// clone encore présent). Sert l'affichage (/api/meta) sans casser la réponse.
function safeRoot(repoId) {
  try {
    return rootForRepo(repoId);
  } catch {
    return null;
  }
}

export async function handle(ctx) {
  const { req, res, method, path, q } = ctx;
  const auth = ctx.auth || { admin: true };

  // GET /api/repos — liste des repos suivis. Un token de DÉPÔT ne voit que SON dépôt
  // (NODE-374) ; les tokens ne sont jamais inclus dans la liste (secret).
  if (method === "GET" && path === "/api/repos") {
    const all = listRepos();
    send(res, 200, auth.admin ? all : all.filter((r) => r.id === auth.repoId));
    return true;
  }
  // POST /api/repos — ajouter un repo (clone immédiat si une url est fournie).
  if (method === "POST" && path === "/api/repos") {
    const body = await readBody(req);
    const repo = createRepo(body);
    let sync = null;
    try {
      sync = ensureRepo(repo.id);
    } catch (e) {
      sync = { ok: false, output: e.message || String(e) };
    }
    send(res, 201, { repo, sync });
    return true;
  }
  // POST /api/repos/import { dir } — détecte tous les clones git d'un dossier
  // (profondeur 1) et les enregistre par local_path. Doit précéder le match
  // /api/repos/:idOrSlug (qui capturerait "import").
  if (method === "POST" && path === "/api/repos/import") {
    const body = await readBody(req);
    const dir = body && String(body.dir || "").trim();
    if (!dir) return send(res, 400, { error: "dir requis" }), true;
    try {
      send(res, 201, importReposFromDir(dir));
    } catch (e) {
      send(res, 400, { error: e.message || String(e) });
    }
    return true;
  }
  // GET /api/repos/resolve?path=<cwd> — résout un chemin FS (cwd d'un MCP lancé par
  // dépôt) vers le dépôt qui le contient → verrou mono-repo sans config (NODE-301).
  // Doit précéder le match /api/repos/:idOrSlug (qui capturerait "resolve").
  if (method === "GET" && path === "/api/repos/resolve") {
    const match = resolveRepoByPath(q.get("path") || "");
    send(res, 200, { slug: match ? match.slug : null, root: match ? match.root : null });
    return true;
  }
  // POST /api/repos/:idOrSlug/token/rotate — régénère le token du dépôt (NODE-372),
  // invalide l'ancien. L'accès est déjà gardé en amont (admin, ou détenteur du token
  // de CE dépôt). Doit précéder le match /api/repos/:idOrSlug (chemin plus profond).
  {
    const rot = path.match(/^\/api\/repos\/([^/]+)\/token\/rotate$/);
    if (rot && method === "POST") {
      try {
        const repo = rotateRepoToken(decodeURIComponent(rot[1]));
        provisionRepoTokenFile(repo.id); // réécrit le fichier local du clone géré (best-effort)
        send(res, 200, repo); // inclut le nouveau token (appelant autorisé)
      } catch (e) {
        send(res, 400, { error: e.message || String(e) });
      }
      return true;
    }
  }
  // /api/repos/:idOrSlug  et  /api/repos/:idOrSlug/update
  const repoMatch = path.match(/^\/api\/repos\/([^/]+)(\/update)?$/);
  if (repoMatch) {
    const key = decodeURIComponent(repoMatch[1]);
    const sub = repoMatch[2] || "";
    if (sub === "/update" && method === "POST") {
      const id = resolveRepoId(key);
      send(res, 200, { ...ensureRepo(id), git: gitContextFor(id) });
      return true;
    }
    if (sub === "" && method === "GET") {
      // Accès déjà gardé (admin ou détenteur du token de CE dépôt) → on inclut le token.
      const r = getRepo(key, true);
      send(res, r ? 200 : 404, r || { error: "not_found", repo: key });
      return true;
    }
    if (sub === "" && method === "PATCH") {
      const repo = updateRepo(key, await readBody(req));
      invalidateRepo(repo.id); // url/local_path ont pu changer → invalide clone+index
      send(res, 200, repo);
      return true;
    }
    if (sub === "" && method === "DELETE") {
      // Capture la row AVANT suppression de registre (pour résoudre le clone géré).
      const row = getRepoRow(key);
      const result = deleteRepo(key);
      // Suppression LOCALE uniquement : retire notre clone `.repos/<slug>/` si on le
      // possède. Ne touche jamais le distant ni un local_path utilisateur.
      const clone = result.deleted && row ? removeManagedClone(row) : { removed: false, reason: "not_deleted" };
      send(res, 200, { ...result, clone });
      return true;
    }
  }

  // GET /api/meta?repo= — contexte git + stats + racine repo (scopé) + registre.
  // Un token de DÉPÔT ne voit que SON dépôt dans la liste `repos` (NODE-374).
  if (method === "GET" && path === "/api/meta") {
    const id = repoOf(q);
    const repos = listRepos();
    send(res, 200, {
      ...stats(id),
      git: gitContextFor(id),
      repoRoot: safeRoot(id),
      repo: getRepo(id),
      repos: auth.admin ? repos : repos.filter((r) => r.id === auth.repoId),
      port: PORT,
    });
    return true;
  }

  // GET /api/branches?repo= — branches connues du clone (+ branche courante).
  if (method === "GET" && path === "/api/branches") {
    send(res, 200, listBranchesFor(repoOf(q)));
    return true;
  }

  // GET /api/paths?repo=&q=&limit=&branch= — autocomplete (feature « @ »), arbre
  // de la branche `branch` si fournie (sinon working tree courant).
  if (method === "GET" && path === "/api/paths") {
    const id = repoOf(q);
    send(res, 200, searchPathsFor(id, q.get("q") || "", Number(q.get("limit")) || 30, q.get("branch") || null));
    return true;
  }
  // POST /api/paths/refresh?repo=&branch= — re-scan d'une source (ou de toutes).
  if (method === "POST" && path === "/api/paths/refresh") {
    const id = repoOf(q);
    send(res, 200, refreshPathsFor(id, q.get("branch") ?? undefined));
    return true;
  }
  // POST /api/repo/update?repo= — clone (si absent) ou git fetch+pull. Legacy :
  // sans `repo`, agit sur le repo par défaut.
  if (method === "POST" && path === "/api/repo/update") {
    const id = repoOf(q);
    send(res, 200, { ...ensureRepo(id), git: gitContextFor(id) });
    return true;
  }
  // POST /api/improve-description { title, description } — réécriture via Claude.
  if (method === "POST" && path === "/api/improve-description") {
    const { title, description } = await readBody(req);
    const improved = await improveDescriptionWithClaude(title, description);
    send(res, 200, { description: improved });
    return true;
  }

  return false;
}
