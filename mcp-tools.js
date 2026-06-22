// mcp-tools.js — déclaration partagée des outils MCP Meowtrack.
//
// Le MÊME jeu d'outils est exposé par deux transports :
//   - mcp.js (stdio)      : apiFetch = client HTTP vers le serveur distant.
//   - server.js (POST /mcp) : apiFetch = client HTTP loopback vers le serveur lui-même.
// Seuls la fonction `apiFetch` et le repo par défaut changent ; les outils, schémas
// et descriptions sont identiques. AUCUN accès direct à db.js ici — tout passe par
// l'API REST (le serveur reste la seule source de vérité).
//
// MULTI-REPOS : chaque entrée / nœud appartient à UN repo. Le paramètre `repo`
// (slug ou id, ex. 'meownopoly') cible le repo ; omis, on retombe sur `defaultRepo`
// si fourni, sinon le serveur utilise SON repo par défaut.

import { z } from "zod";

// Énumérations (doivent rester alignées sur db.js — dupliquées ici pour ne pas
// importer db.js, dont l'import ouvrirait une base SQLite locale).
const TYPES = ["bug", "feature", "task", "chore"];
const STATUSES = ["open", "in_progress", "done", "wontfix"];
const PRIORITIES = ["low", "medium", "high", "critical"];
const NODE_STATUSES = ["active", "paused", "done", "abandoned"];
const NODE_KINDS = ["normal", "activation"];
const NODE_COLORS = ["accent", "feature", "task", "bug", "high"];

// Enregistre tous les outils Meowtrack sur `server` (un McpServer du SDK).
//   apiFetch(method, path, body?) → Promise<data>  : client REST (lève sur !ok).
//   defaultRepo                                     : repo (slug/id) appliqué quand
//                                                     un appel n'en précise pas.
export function registerMeowtrackTools(server, { apiFetch, defaultRepo = "" }) {
  const DEFAULT_REPO = (defaultRepo || "").trim();
  const apiGet = (path) => apiFetch("GET", path);

  // Construit une query string à partir des champs définis (ignore null/undefined/"").
  function qs(obj) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(obj || {})) {
      if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
    }
    const s = p.toString();
    return s ? "?" + s : "";
  }
  // Résout le repo effectif d'un appel (param explicite sinon défaut). Peut être
  // undefined → le serveur utilisera SON repo par défaut.
  function repoOf(repo) {
    return repo != null && repo !== "" ? String(repo) : DEFAULT_REPO || undefined;
  }

  function ok(data) {
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }
  function fail(err) {
    return { content: [{ type: "text", text: `Erreur: ${err.message || err}` }], isError: true };
  }
  function guard(fn) {
    return async (args) => {
      try {
        return ok(await fn(args));
      } catch (e) {
        return fail(e);
      }
    };
  }

  // ── Compaction des grandes listes (coût tokens) ─────────────────────────────
  // Les listes (entrées, forêt de nœuds) peuvent être volumineuses : par défaut
  // on projette les seuls champs utiles et on pagine. `full:true` rend l'objet
  // brut complet (références, notes, etc.). Champs compacts par défaut :
  const ISSUE_LIST_FIELDS = ["id", "ref", "type", "title", "status", "priority", "branch", "updatedAt"];
  const NODE_LIST_FIELDS = ["id", "ref", "parentId", "depth", "title", "status", "kind", "progress", "childCount", "position"];
  // Ne conserve que `keys` sur chaque élément d'un tableau (clés absentes ignorées).
  function pick(rows, keys) {
    if (!Array.isArray(rows)) return rows;
    return rows.map((r) => {
      const o = {};
      for (const k of keys) if (k in r) o[k] = r[k];
      return o;
    });
  }
  // Pagination client : tranche [offset, …] + métadonnées { total, offset, count, items }.
  function paginate(rows, { offset = 0 } = {}) {
    if (!Array.isArray(rows)) return rows;
    const start = Math.max(0, offset | 0);
    const items = start ? rows.slice(start) : rows;
    return { total: rows.length, offset: start, count: items.length, items };
  }
  const offsetParam = z.number().int().optional().describe("Pagination : ignorer les N premiers éléments (défaut 0).");
  const fullParam = z.boolean().optional().describe("Renvoyer les objets bruts complets (sans projection ni pagination). Défaut false : vue compacte.");

  const refSpecSchema = z
    .string()
    .describe("Chemin repo-relatif, avec lignes optionnelles : 'chemin', 'chemin:120' ou 'chemin:120-145'.");
  // Paramètre repo commun à (presque) tous les outils.
  const repoParam = z
    .union([z.string(), z.number()])
    .optional()
    .describe("Repo cible (slug ou id, ex. 'meownopoly'). Omis : repo par défaut du serveur. Voir meowtrack_repos.");

  // ═══════════════════════════════════════════════════════════════════════════
  // Repos — registre des dépôts git suivis.
  // ═══════════════════════════════════════════════════════════════════════════
  server.registerTool(
    "meowtrack_repos",
    {
      annotations: { readOnlyHint: true },
      title: "Lister les repos suivis",
      description:
        "Liste les dépôts git du registre (slug, nom, url, branche par défaut, repo par défaut). Le `slug` " +
        "ou l'`id` sert de paramètre `repo` aux autres outils. Les entrées/nœuds sont scopés par repo.",
      inputSchema: {},
    },
    guard(async () => apiGet("/api/repos"))
  );
  server.registerTool(
    "meowtrack_repo_add",
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: "Ajouter un repo",
      description:
        "Enregistre un nouveau dépôt git à suivre (et le clone immédiatement si une `url` est fournie). " +
        "Le `slug` est dérivé de l'url s'il n'est pas donné. Retourne le repo créé + le rapport de clone.",
      inputSchema: {
        slug: z.string().optional().describe("Identifiant court (ex. 'chatserver'). Dérivé de l'url si absent."),
        name: z.string().optional().describe("Libellé affiché (défaut : slug)."),
        url: z.string().optional().describe("URL git de clone (https/ssh). Absente : clone géré à la main / dev in-repo."),
        localPath: z.string().optional().describe("Chemin de clone explicite (sinon .repos/<slug>/)."),
        defaultBranch: z.string().optional().describe("Branche par défaut pour l'autocomplete/contexte."),
        isDefault: z.boolean().optional().describe("Faire de ce repo le repo par défaut."),
      },
    },
    guard(async (a) => apiFetch("POST", "/api/repos", a))
  );
  server.registerTool(
    "meowtrack_repo_import",
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: "Importer un dossier multi-repos",
      description:
        "Détecte TOUS les clones git d'un dossier (le dossier lui-même + ses sous-dossiers directs, profondeur 1) " +
        "et les enregistre d'un coup dans le registre, chacun par son `local_path` (sans url : clones lus tels quels, " +
        "non gérés par le service). Les clones déjà suivis sont ignorés. Retourne { found, added[], skipped[], errors[] }.",
      inputSchema: {
        dir: z.string().describe("Chemin absolu du dossier contenant plusieurs dépôts git."),
      },
    },
    guard(async ({ dir }) => apiFetch("POST", "/api/repos/import", { dir }))
  );
  server.registerTool(
    "meowtrack_repo_update",
    {
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
      title: "Mettre à jour un repo (pull) ou ses métadonnées",
      description:
        "Sans autre champ : clone (si absent) ou git fetch+pull du repo. Avec des champs (name/url/localPath/" +
        "defaultBranch/isDefault) : modifie le registre. `action='pull'` force le pull même avec des champs.",
      inputSchema: {
        repo: z.union([z.string(), z.number()]).describe("Repo cible (slug ou id)."),
        action: z.enum(["pull", "edit"]).optional().describe("'pull' (défaut si aucun champ) ou 'edit' (métadonnées)."),
        name: z.string().optional(),
        url: z.string().optional(),
        localPath: z.string().optional(),
        defaultBranch: z.string().optional(),
        isDefault: z.boolean().optional(),
      },
    },
    guard(async ({ repo, action, ...fields }) => {
      const key = encodeURIComponent(String(repo));
      const hasEdits = Object.keys(fields).length > 0;
      if (action === "edit" || (hasEdits && action !== "pull")) {
        const updated = await apiFetch("PATCH", "/api/repos/" + key, fields);
        return action === "pull" || !hasEdits ? { ...updated, ...(await apiFetch("POST", "/api/repos/" + key + "/update")) } : updated;
      }
      return apiFetch("POST", "/api/repos/" + key + "/update");
    })
  );
  server.registerTool(
    "meowtrack_repo_remove",
    {
      annotations: { readOnlyHint: false, destructiveHint: true },
      title: "Supprimer un repo",
      description: "Retire un dépôt du registre ET toutes ses entrées/nœuds (cascade). Le dernier repo ne peut pas être supprimé. Irréversible.",
      inputSchema: { repo: z.union([z.string(), z.number()]).describe("Repo cible (slug ou id).") },
    },
    guard(async ({ repo }) => apiFetch("DELETE", "/api/repos/" + encodeURIComponent(String(repo))))
  );

  // ── meowtrack_create ─────────────────────────────────────────────────────────
  server.registerTool(
    "meowtrack_create",
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: "Créer un bug / feature / tâche",
      description:
        "Crée une entrée de suivi (type ∈ {bug,feature,task,chore}). Les `paths` et les `@chemin` cités dans " +
        "`description` sont validés contre le repo et ajoutés en références. Retourne l'issue créée (ex. BUG-1, par repo).",
      inputSchema: {
        repo: repoParam,
        type: z.enum(TYPES).optional().describe("Type (défaut 'bug')."),
        title: z.string().describe("Titre court."),
        description: z.string().optional().describe("Description détaillée (peut contenir des @chemin)."),
        priority: z.enum(PRIORITIES).optional().describe("Priorité (défaut 'medium')."),
        status: z.enum(STATUSES).optional().describe("Statut initial (défaut 'open')."),
        tags: z.array(z.string()).optional().describe("Étiquettes libres."),
        branch: z.string().optional().describe("Branche git de rattachement (tracking + validation des chemins). Défaut : branche checkout du serveur."),
        paths: z.array(refSpecSchema).optional().describe("Fichiers/dossiers associés (validés contre la branche)."),
      },
    },
    guard(async ({ repo, ...a }) => apiFetch("POST", "/api/issues" + qs({ repo: repoOf(repo) }), a))
  );

  // ── meowtrack_list ───────────────────────────────────────────────────────────
  server.registerTool(
    "meowtrack_list",
    {
      annotations: { readOnlyHint: true },
      title: "Lister / filtrer les entrées",
      description:
        "Liste les entrées de suivi d'un repo, triées par activité puis priorité. Par défaut masque les entrées " +
        "closes (done/wontfix) — passer includeClosed=true pour tout voir. Filtres combinables. Vue COMPACTE par " +
        "défaut (id/ref/type/title/status/priority/branch) + pagination ; `full:true` pour les objets complets.",
      inputSchema: {
        repo: repoParam,
        type: z.enum(TYPES).optional(),
        status: z.enum(STATUSES).optional().describe("Filtre exact sur le statut."),
        priority: z.enum(PRIORITIES).optional(),
        branch: z.string().optional().describe("Ne garder que les entrées rattachées à cette branche."),
        tag: z.string().optional().describe("Ne garder que les entrées portant cette étiquette."),
        path: z.string().optional().describe("Ne garder que les entrées référençant un chemin contenant cette sous-chaîne."),
        text: z.string().optional().describe("Recherche plein-texte sur titre/description/ref."),
        includeClosed: z.boolean().optional().describe("Inclure les entrées done/wontfix (défaut false)."),
        limit: z.number().int().optional().describe("Nombre max d'entrées (défaut 200)."),
        offset: offsetParam,
        full: fullParam,
      },
    },
    guard(async ({ repo, full, offset, ...a }) => {
      const rows = await apiGet("/api/issues" + qs({ repo: repoOf(repo), ...a }));
      return full ? rows : paginate(pick(rows, ISSUE_LIST_FIELDS), { offset });
    })
  );

  // ── meowtrack_get ────────────────────────────────────────────────────────────
  server.registerTool(
    "meowtrack_get",
    {
      annotations: { readOnlyHint: true },
      title: "Détail d'une entrée",
      description:
        "Retourne une entrée complète (références + commentaires) par code (ex. 'BUG-1') ou id numérique. " +
        "Les codes étant numérotés PAR repo, préciser `repo` quand on cible par code.",
      inputSchema: { repo: repoParam, ref: z.string().describe("Code (BUG-1, FEAT-2…) ou id numérique.") },
    },
    guard(async ({ repo, ref }) => {
      try {
        return await apiGet("/api/issues/" + encodeURIComponent(ref) + qs({ repo: repoOf(repo) }));
      } catch (e) {
        if (String(e.message).includes("404")) throw new Error(`Issue introuvable : ${ref}`);
        throw e;
      }
    })
  );

  // ── meowtrack_update ─────────────────────────────────────────────────────────
  server.registerTool(
    "meowtrack_update",
    {
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
      title: "Modifier une entrée",
      description:
        "Met à jour les champs fournis d'une entrée existante. Fournir `paths` REMPLACE l'ensemble des " +
        "références (utiliser meowtrack_add_reference pour en ajouter une sans tout réécrire).",
      inputSchema: {
        repo: repoParam,
        ref: z.string().describe("Code ou id de l'entrée."),
        title: z.string().optional(),
        description: z.string().optional(),
        type: z.enum(TYPES).optional(),
        status: z.enum(STATUSES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        tags: z.array(z.string()).optional(),
        branch: z.string().optional().describe("Rattacher l'entrée à cette branche (recapture le commit + revalide les chemins)."),
        paths: z.array(refSpecSchema).optional().describe("Remplace TOUTES les références par cette liste."),
      },
    },
    guard(async ({ repo, ref, ...fields }) => apiFetch("PATCH", "/api/issues/" + encodeURIComponent(ref) + qs({ repo: repoOf(repo) }), fields))
  );

  // ── meowtrack_set_status (raccourci) ─────────────────────────────────────────
  server.registerTool(
    "meowtrack_set_status",
    {
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
      title: "Changer le statut",
      description: "Raccourci pour passer une entrée à open / in_progress / done / wontfix.",
      inputSchema: {
        repo: repoParam,
        ref: z.string().describe("Code ou id de l'entrée."),
        status: z.enum(STATUSES).describe("Nouveau statut."),
      },
    },
    guard(async ({ repo, ref, status }) => apiFetch("PATCH", "/api/issues/" + encodeURIComponent(ref) + qs({ repo: repoOf(repo) }), { status }))
  );

  // ── meowtrack_delete ─────────────────────────────────────────────────────────
  server.registerTool(
    "meowtrack_delete",
    {
      annotations: { readOnlyHint: false, destructiveHint: true },
      title: "Supprimer une entrée",
      description: "Supprime définitivement une entrée et ses références/commentaires (cascade).",
      inputSchema: { repo: repoParam, ref: z.string().describe("Code ou id de l'entrée.") },
    },
    guard(async ({ repo, ref }) => apiFetch("DELETE", "/api/issues/" + encodeURIComponent(ref) + qs({ repo: repoOf(repo) })))
  );

  // ── meowtrack_reorder ────────────────────────────────────────────────────────
  server.registerTool(
    "meowtrack_reorder",
    {
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
      title: "Réordonner les entrées",
      description:
        "Définit l'ordre MANUEL des entrées (prime sur le tri statut/priorité). `order` = codes/ids dans l'ordre voulu ; " +
        "les entrées non citées suivent (ordre relatif conservé). Retourne la liste réordonnée.",
      inputSchema: {
        repo: repoParam,
        order: z.array(z.union([z.string(), z.number()])).describe("Codes/ids des entrées dans le nouvel ordre."),
      },
    },
    guard(async ({ repo, order }) => apiFetch("POST", "/api/issues/reorder" + qs({ repo: repoOf(repo) }), { order }))
  );

  // ── meowtrack_add_reference ──────────────────────────────────────────────────
  server.registerTool(
    "meowtrack_add_reference",
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: "Ajouter une référence fichier/dossier",
      description:
        "Associe un chemin du repo (validé) à une entrée, avec plage de lignes optionnelle " +
        "(via la syntaxe 'chemin:120-145'). N'écrase pas les références existantes.",
      inputSchema: {
        repo: repoParam,
        ref: z.string().describe("Code ou id de l'entrée."),
        path: refSpecSchema,
      },
    },
    guard(async ({ repo, ref, path }) =>
      apiFetch("POST", "/api/issues/" + encodeURIComponent(ref) + "/references" + qs({ repo: repoOf(repo) }), { path })
    )
  );

  // ── meowtrack_remove_reference ───────────────────────────────────────────────
  server.registerTool(
    "meowtrack_remove_reference",
    {
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
      title: "Retirer une référence",
      description: "Supprime une référence par son id (visible dans le détail de l'entrée). L'id est global, indépendant du repo.",
      inputSchema: { referenceId: z.number().int().describe("id de la référence à retirer.") },
    },
    guard(async ({ referenceId }) => ({
      ...(await apiFetch("DELETE", "/api/references/" + referenceId)),
      referenceId,
    }))
  );

  // ── meowtrack_comment ────────────────────────────────────────────────────────
  server.registerTool(
    "meowtrack_comment",
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: "Ajouter un commentaire",
      description: "Ajoute une note de suivi (avancement, reproduction, piste…) à une entrée.",
      inputSchema: {
        repo: repoParam,
        ref: z.string().describe("Code ou id de l'entrée."),
        body: z.string().describe("Contenu du commentaire."),
      },
    },
    guard(async ({ repo, ref, body }) =>
      apiFetch("POST", "/api/issues/" + encodeURIComponent(ref) + "/comments" + qs({ repo: repoOf(repo) }), { body })
    )
  );

  // ── meowtrack_search_paths (feature « @ ») ───────────────────────────────────
  server.registerTool(
    "meowtrack_search_paths",
    {
      annotations: { readOnlyHint: true },
      title: "Rechercher des chemins du repo",
      description:
        "Autocomplete des fichiers/dossiers suivis par git sur le serveur (même source que le « @ » du " +
        "dashboard) pour un repo donné. Sert à découvrir les chemins exacts à associer à une entrée. Trié par pertinence.",
      inputSchema: {
        repo: repoParam,
        query: z.string().optional().describe("Sous-chaîne à rechercher (vide = premiers chemins)."),
        limit: z.number().int().optional().describe("Nombre max de résultats (défaut 30)."),
        branch: z.string().optional().describe("Chercher dans l'arbre de cette branche (défaut : branche checkout du serveur)."),
      },
    },
    guard(async ({ repo, query, limit, branch }) => apiGet("/api/paths" + qs({ repo: repoOf(repo), q: query, limit, branch })))
  );

  // ── meowtrack_branches ───────────────────────────────────────────────────────
  server.registerTool(
    "meowtrack_branches",
    {
      annotations: { readOnlyHint: true },
      title: "Lister les branches d'un repo",
      description:
        "Branches connues du clone serveur d'un repo (pour rattacher une entrée ou cibler l'autocomplete d'une " +
        "branche précise). Renvoie { branches: [...], current }.",
      inputSchema: { repo: repoParam },
    },
    guard(async ({ repo }) => apiGet("/api/branches" + qs({ repo: repoOf(repo) })))
  );

  // ── meowtrack_stats ──────────────────────────────────────────────────────────
  server.registerTool(
    "meowtrack_stats",
    {
      annotations: { readOnlyHint: true },
      title: "Statistiques de suivi",
      description: "Compte des entrées d'un repo par statut / type / priorité, plus le contexte git courant, la racine du clone et le registre des repos.",
      inputSchema: { repo: repoParam },
    },
    guard(async ({ repo }) => apiGet("/api/meta" + qs({ repo: repoOf(repo) })))
  );

  // ── meowtrack_refresh_paths ──────────────────────────────────────────────────
  server.registerTool(
    "meowtrack_refresh_paths",
    {
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
      title: "Rafraîchir l'index des chemins",
      description: "Force un nouveau scan des chemins d'un repo côté serveur (après un pull / changement de branche / nouveaux fichiers).",
      inputSchema: { repo: repoParam },
    },
    guard(async ({ repo }) => apiFetch("POST", "/api/paths/refresh" + qs({ repo: repoOf(repo) })))
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Vibes — arbre de NŒUDS récursif (objectifs / jalons / sous-jalons), scopé repo.
  // ═══════════════════════════════════════════════════════════════════════════
  const nodeRefSchema = z.union([z.string(), z.number()]).describe("Code (ex. 'NODE-1') ou id numérique du nœud.");
  const notesSchema = z
    .array(z.object({ title: z.string().optional().describe("Titre de la section (optionnel)."), body: z.string().describe("Corps markdown.") }))
    .describe("Liste de notes markdown [{title, body}]. REMPLACE toutes les notes existantes (reprends l'existant pour compléter).");

  // ── meowtrack_node_create ────────────────────────────────────────────────────
  server.registerTool(
    "meowtrack_node_create",
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: "Créer un nœud (objectif / jalon)",
      description:
        "Crée un nœud Vibes. Sans `parentId` → objectif racine ; sinon sous-jalon (hérite du repo du parent). " +
        "Progression dérivée automatiquement (ne pas la fixer). `kind='activation'` = porte manuelle bloquant les " +
        "nœuds qui la requièrent (meowtrack_node_link_add) tant qu'elle n'est pas 'done'. Retourne le nœud (NODE-N, par repo).",
      inputSchema: {
        repo: repoParam,
        title: z.string().describe("Titre du nœud."),
        parentId: nodeRefSchema.optional().describe("Parent (absent = nœud racine)."),
        description: z.string().optional().describe("Description courte."),
        notes: notesSchema.optional(),
        status: z.enum(NODE_STATUSES).optional().describe("Statut (défaut 'active')."),
        kind: z.enum(NODE_KINDS).optional().describe("Type : 'normal' (défaut) ou 'activation' (porte de prérequis manuelle)."),
        color: z.enum(NODE_COLORS).optional().describe("Couleur (défaut 'accent', ou héritée du parent)."),
        emoji: z.string().optional().describe("Emoji (défaut 🎯)."),
        position: z.number().int().optional().describe("Position parmi les frères (défaut : à la fin)."),
      },
    },
    guard(async ({ repo, ...a }) => apiFetch("POST", "/api/nodes" + qs({ repo: repoOf(repo) }), a))
  );

  // ── meowtrack_node_list ──────────────────────────────────────────────────────
  server.registerTool(
    "meowtrack_node_list",
    {
      annotations: { readOnlyHint: true },
      title: "Lister les nœuds (forêt ou racines)",
      description:
        "Liste les nœuds d'un repo. `view='forest'` (défaut) renvoie TOUT l'arbre à plat (avec parentId/depth) — " +
        "idéal pour comprendre la structure. `view='roots'` ne renvoie que les objectifs racines. Vue COMPACTE par " +
        "défaut (id/ref/parentId/depth/title/status/kind/progress) + pagination ; `full:true` pour les objets complets.",
      inputSchema: {
        repo: repoParam,
        view: z.enum(["forest", "roots"]).optional().describe("'forest' (tout, défaut) ou 'roots' (racines seules)."),
        status: z.enum(NODE_STATUSES).optional().describe("Filtre statut (racines uniquement)."),
        text: z.string().optional().describe("Recherche plein-texte (racines uniquement)."),
        limit: z.number().int().optional(),
        includeNotes: z.boolean().optional().describe("Inclure les notes markdown de chaque nœud (défaut false — réduit fortement la taille de la réponse)."),
        offset: offsetParam,
        full: fullParam,
      },
    },
    guard(async ({ repo, view, includeNotes, full, offset, ...rest }) => {
      const rows =
        (view ?? "forest") === "forest"
          ? await apiGet("/api/nodes" + qs({ repo: repoOf(repo), view: "forest", includeNotes: includeNotes ?? false }))
          : await apiGet("/api/nodes" + qs({ repo: repoOf(repo), ...rest }));
      if (full) return rows;
      const fields = includeNotes ? [...NODE_LIST_FIELDS, "notes"] : NODE_LIST_FIELDS;
      return paginate(pick(rows, fields), { offset });
    })
  );

  // ── meowtrack_node_get ───────────────────────────────────────────────────────
  server.registerTool(
    "meowtrack_node_get",
    {
      annotations: { readOnlyHint: true },
      title: "Détail d'un nœud (+ sous-arbre)",
      description: "Retourne un nœud complet (notes incluses) et, par défaut, son sous-arbre imbriqué (children). Préciser `repo` quand on cible par code.",
      inputSchema: {
        repo: repoParam,
        ref: nodeRefSchema,
        tree: z.boolean().optional().describe("Inclure le sous-arbre imbriqué (défaut true)."),
        messages: z.boolean().optional().describe("Inclure l'historique de chat du nœud (défaut false)."),
      },
    },
    guard(async ({ repo, ref, tree, messages }) => {
      try {
        return await apiGet(
          "/api/nodes/" + encodeURIComponent(ref) + qs({ repo: repoOf(repo), tree: tree === false ? "false" : undefined, messages: messages ? "true" : undefined })
        );
      } catch (e) {
        if (String(e.message).includes("404")) throw new Error(`Nœud introuvable : ${ref}`);
        throw e;
      }
    })
  );

  // ── meowtrack_node_update ────────────────────────────────────────────────────
  server.registerTool(
    "meowtrack_node_update",
    {
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
      title: "Modifier un nœud",
      description:
        "Met à jour les champs fournis d'un nœud (titre, description, NOTES markdown, statut, couleur, emoji). " +
        "`notes` remplace toute la liste de notes. La progression reste automatique.",
      inputSchema: {
        repo: repoParam,
        ref: nodeRefSchema,
        title: z.string().optional(),
        description: z.string().optional(),
        notes: notesSchema.optional(),
        status: z.enum(NODE_STATUSES).optional(),
        kind: z.enum(NODE_KINDS).optional().describe("Type : 'normal' ou 'activation' (porte de prérequis manuelle ; activer = passer status='done')."),
        pendingInfo: z
          .string()
          .nullable()
          .optional()
          .describe("Info attendue de l'utilisateur (markdown) quand status='waiting' ; null pour effacer. JAMAIS de secret (clé API…)."),
        color: z.enum(NODE_COLORS).optional(),
        emoji: z.string().optional(),
      },
    },
    guard(async ({ repo, ref, ...fields }) => apiFetch("PATCH", "/api/nodes/" + encodeURIComponent(ref) + qs({ repo: repoOf(repo) }), fields))
  );

  // ── meowtrack_node_set_status (raccourci) ────────────────────────────────────
  server.registerTool(
    "meowtrack_node_set_status",
    {
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
      title: "Changer le statut d'un nœud",
      description:
        "Raccourci statut : active / paused / waiting / done / abandoned. 'waiting' = en attente d'info utilisateur " +
        "(préfère meowtrack_node_request_input pour décrire le manque).",
      inputSchema: { repo: repoParam, ref: nodeRefSchema, status: z.enum(NODE_STATUSES) },
    },
    guard(async ({ repo, ref, status }) => apiFetch("PATCH", "/api/nodes/" + encodeURIComponent(ref) + qs({ repo: repoOf(repo) }), { status }))
  );

  // ── meowtrack_node_request_input ─────────────────────────────────────────────
  // À utiliser quand l'agent réalise qu'il MANQUE une info de l'utilisateur (clé API,
  // config, décision) avant de pouvoir implémenter ce nœud. Le passe en 'waiting'
  // (bloqué pour l'orchestrateur) et décrit le manque dans `info`. Le chat du nœud
  // bascule alors en mode « collecte » ; quand l'info est fournie, le nœud repasse
  // 'active' (via le chat ou le bouton « Prêt à implémenter »).
  server.registerTool(
    "meowtrack_node_request_input",
    {
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
      title: "Demander une info à l'utilisateur (mise en attente)",
      description:
        "Met un nœud EN ATTENTE d'info utilisateur (status='waiting') et décrit le manque (clé API, config, décision) " +
        "requis avant l'implémentation. N'inclus JAMAIS de secret dans `info`.",
      inputSchema: {
        repo: repoParam,
        ref: nodeRefSchema,
        info: z.string().describe("Markdown décrivant l'info manquante (clé API, config, décision). Sans secret."),
      },
    },
    guard(async ({ repo, ref, info }) =>
      apiFetch("PATCH", "/api/nodes/" + encodeURIComponent(ref) + qs({ repo: repoOf(repo) }), { status: "waiting", pendingInfo: info })
    )
  );

  // ── meowtrack_node_set_notes (raccourci) ─────────────────────────────────────
  server.registerTool(
    "meowtrack_node_set_notes",
    {
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
      title: "Définir les notes d'un nœud",
      description:
        "Remplace la liste de notes markdown d'un nœud. Pour AJOUTER, récupère d'abord les notes via " +
        "meowtrack_node_get puis renvoie l'ancienne liste + la nouvelle entrée.",
      inputSchema: { repo: repoParam, ref: nodeRefSchema, notes: notesSchema },
    },
    guard(async ({ repo, ref, notes }) => apiFetch("PATCH", "/api/nodes/" + encodeURIComponent(ref) + qs({ repo: repoOf(repo) }), { notes }))
  );

  // ── meowtrack_node_move ──────────────────────────────────────────────────────
  server.registerTool(
    "meowtrack_node_move",
    {
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
      title: "Déplacer / rattacher un nœud",
      description:
        "Reparente un nœud (et tout son sous-arbre) DANS LE MÊME repo. `newParentId=null` → en fait un objectif " +
        "racine. Refusé si cela créerait un cycle ou traverserait deux repos. `position` ordonne parmi les nouveaux frères.",
      inputSchema: {
        repo: repoParam,
        ref: nodeRefSchema,
        newParentId: nodeRefSchema.nullable().describe("Nouveau parent, ou null pour détacher (racine)."),
        position: z.number().int().optional(),
      },
    },
    guard(async ({ repo, ref, newParentId, position }) =>
      apiFetch("POST", "/api/nodes/" + encodeURIComponent(ref) + "/move" + qs({ repo: repoOf(repo) }), { newParentId: newParentId ?? null, position })
    )
  );

  // ── meowtrack_node_reorder ───────────────────────────────────────────────────
  server.registerTool(
    "meowtrack_node_reorder",
    {
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
      title: "Réordonner les enfants d'un nœud",
      description: "Définit l'ordre des sous-nœuds directs d'un parent. `order` = liste d'ids enfants dans l'ordre voulu.",
      inputSchema: {
        repo: repoParam,
        ref: nodeRefSchema.describe("Le parent dont on réordonne les enfants."),
        order: z.array(z.union([z.string(), z.number()])).describe("Ids enfants dans le nouvel ordre."),
      },
    },
    guard(async ({ repo, ref, order }) => apiFetch("POST", "/api/nodes/" + encodeURIComponent(ref) + "/reorder" + qs({ repo: repoOf(repo) }), { order }))
  );

  // ── meowtrack_node_delete ────────────────────────────────────────────────────
  server.registerTool(
    "meowtrack_node_delete",
    {
      annotations: { readOnlyHint: false, destructiveHint: true },
      title: "Supprimer un nœud",
      description: "Supprime un nœud ET tout son sous-arbre (cascade). Irréversible.",
      inputSchema: { repo: repoParam, ref: nodeRefSchema },
    },
    guard(async ({ repo, ref }) => apiFetch("DELETE", "/api/nodes/" + encodeURIComponent(ref) + qs({ repo: repoOf(repo) })))
  );

  // ── meowtrack_node_link_add (prérequis) ──────────────────────────────────────
  server.registerTool(
    "meowtrack_node_link_add",
    {
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
      title: "Lier un prérequis entre nœuds",
      description:
        "Crée un lien de PRÉREQUIS hors hiérarchie : « `from` dépend de `to` » (from = le dépendant, to = le " +
        "prérequis). Sert quand une même brique est requise par plusieurs nœuds (ne pas dupliquer le nœud : le " +
        "créer une fois puis le relier). N'affecte NI la hiérarchie NI la progression ; pilote le signal « bloqué ». " +
        "Refusé si auto-lien, inter-repos, ou cycle de prérequis. Idempotent.",
      inputSchema: { repo: repoParam, from: nodeRefSchema.describe("Le nœud dépendant."), to: nodeRefSchema.describe("Le prérequis dont il dépend.") },
    },
    guard(async ({ repo, from, to }) => apiFetch("POST", "/api/nodes/links" + qs({ repo: repoOf(repo) }), { fromId: from, toId: to }))
  );

  // ── meowtrack_node_link_remove ───────────────────────────────────────────────
  server.registerTool(
    "meowtrack_node_link_remove",
    {
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
      title: "Retirer un prérequis",
      description: "Supprime le lien de prérequis « `from` dépend de `to` ». Idempotent (sans effet si absent).",
      inputSchema: { repo: repoParam, from: nodeRefSchema.describe("Le nœud dépendant."), to: nodeRefSchema.describe("Le prérequis à délier.") },
    },
    guard(async ({ repo, from, to }) => apiFetch("DELETE", "/api/nodes/links" + qs({ repo: repoOf(repo) }), { fromId: from, toId: to }))
  );

  // ── meowtrack_node_links (liste) ─────────────────────────────────────────────
  server.registerTool(
    "meowtrack_node_links",
    {
      annotations: { readOnlyHint: true },
      title: "Lister les liens de prérequis",
      description:
        "Retourne tous les liens de prérequis du repo : [{id, fromId, toId, kind}] (from dépend de to). Pour les " +
        "prérequis d'UN nœud précis, meowtrack_node_get renvoie aussi ses champs `requires` / `requiredBy`.",
      inputSchema: { repo: repoParam },
    },
    guard(async ({ repo }) => apiGet("/api/nodes/links" + qs({ repo: repoOf(repo) })))
  );

  // ── meowtrack_issue_link_node (lien suivi ↔ nœud) ────────────────────────────
  server.registerTool(
    "meowtrack_issue_link_node",
    {
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
      title: "Lier une entrée de suivi à un nœud",
      description:
        "Rattache une entrée de SUIVI (bug/feature/tâche) au NŒUD/jalon Vibes qu'elle concerne (même dépôt). " +
        "Sert à relier un bug/feature à la tâche d'exécution correspondante. Idempotent.",
      inputSchema: {
        repo: repoParam,
        ref: z.string().describe("Code ou id de l'entrée de suivi (ex. 'BUG-1')."),
        node: nodeRefSchema.describe("Nœud à rattacher (ex. 'NODE-2' ou id)."),
      },
    },
    guard(async ({ repo, ref, node }) =>
      apiFetch("POST", "/api/issues/" + encodeURIComponent(ref) + "/nodes" + qs({ repo: repoOf(repo) }), { nodeRef: node })
    )
  );

  // ── meowtrack_issue_unlink_node ──────────────────────────────────────────────
  server.registerTool(
    "meowtrack_issue_unlink_node",
    {
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
      title: "Détacher un nœud d'une entrée de suivi",
      description: "Retire le lien entre une entrée de suivi et un nœud Vibes. `nodeId` = id numérique du nœud (cf. meowtrack_get → nodes liés).",
      inputSchema: {
        repo: repoParam,
        ref: z.string().describe("Code ou id de l'entrée de suivi."),
        nodeId: z.number().int().describe("Id du nœud à détacher."),
      },
    },
    guard(async ({ repo, ref, nodeId }) =>
      apiFetch("DELETE", "/api/issues/" + encodeURIComponent(ref) + "/nodes/" + Number(nodeId) + qs({ repo: repoOf(repo) }))
    )
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Orchestrateur — file de travail exécutable (bail + runs + revue). L'agent TIRE
  // les tâches prêtes, les réalise dans un worktree isolé, puis rend compte.
  // ═══════════════════════════════════════════════════════════════════════════
  const TEST_RESULTS = ["pass", "fail", "skipped"];

  // ── meowtrack_node_next ──────────────────────────────────────────────────────
  server.registerTool(
    "meowtrack_node_next",
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: "Réclamer la prochaine tâche prête",
      description:
        "Tire ET réclame atomiquement la prochaine tâche exécutable d'un repo : une FEUILLE active, débloquée " +
        "(tous ses prérequis 'done'), au bail libre. Pose un bail au nom de `owner` (le nœud passe run_state='running'). " +
        "Renvoie { node, config } ou node=null si rien n'est prêt. Boucle : next → travailler dans un WORKTREE ISOLÉ " +
        "(une branche dédiée par nœud) → écrire .meowtrack/runs/<ref>.json → complete → merger dans `main` (+push) → nœud suivant.",
      inputSchema: {
        repo: repoParam,
        owner: z.string().describe("Identifiant du worker (ex. 'agent-1') — détenteur du bail."),
        branch: z.string().optional().describe("Branche de travail associée au run (ex. 'meow/NODE-12')."),
      },
    },
    guard(async ({ repo, owner, branch }) => apiFetch("POST", "/api/nodes/next" + qs({ repo: repoOf(repo) }), { owner, branch }))
  );

  // ── meowtrack_node_peek ──────────────────────────────────────────────────────
  server.registerTool(
    "meowtrack_node_peek",
    {
      annotations: { readOnlyHint: true },
      title: "Prochaine tâche dispatchable (sans réclamer)",
      description:
        "Montre la prochaine FEUILLE que meowtrack_node_next dispatcherait — même ordre et mêmes critères — " +
        "SANS la réclamer, sans poser de bail, sans rien muter. Lecture seule, donc INDICATIF : l'état peut " +
        "changer avant le claim réel (worker concurrent, bail expiré, prérequis clos). Renvoie { node } (ou node=null).",
      inputSchema: { repo: repoParam },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ repo }) => apiFetch("GET", "/api/nodes/next" + qs({ repo: repoOf(repo) })))
  );

  // ── meowtrack_node_start ─────────────────────────────────────────────────────
  server.registerTool(
    "meowtrack_node_start",
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: "Marquer un nœud « en cours »",
      description:
        "Démarrage MANUEL d'un nœud (depuis Claude Code) : le marque « en cours » (run_state='running', badge ▶️ dans le graphe) " +
        "et pose un bail au nom de `owner`. Contrairement à meowtrack_node_next (orchestrateur), n'exige NI une feuille NI des " +
        "prérequis satisfaits — c'est un signal explicite « je commence à travailler dessus ». Le nœud doit être 'active' et non " +
        "déjà pris par un autre worker (sinon 409). Clôture via meowtrack_node_complete / _fail.",
      inputSchema: {
        repo: repoParam,
        ref: nodeRefSchema,
        owner: z.string().optional().describe("Identifiant du worker (défaut 'claude-code') — détenteur du bail."),
        branch: z.string().optional().describe("Branche de travail associée au run (ex. 'meow/NODE-12')."),
      },
    },
    guard(async ({ repo, ref, owner, branch }) =>
      apiFetch("POST", "/api/nodes/" + encodeURIComponent(ref) + "/start" + qs({ repo: repoOf(repo) }), { owner, branch })
    )
  );

  // ── meowtrack_node_heartbeat ─────────────────────────────────────────────────
  server.registerTool(
    "meowtrack_node_heartbeat",
    {
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
      title: "Prolonger le bail d'une tâche",
      description: "Prolonge le bail d'une tâche longue (évite l'expiration → re-réclamation). Échoue (409) si le bail a été perdu.",
      inputSchema: { repo: repoParam, ref: nodeRefSchema, owner: z.string().describe("Détenteur du bail.") },
    },
    guard(async ({ repo, ref, owner }) => apiFetch("POST", "/api/nodes/" + encodeURIComponent(ref) + "/heartbeat" + qs({ repo: repoOf(repo) }), { owner }))
  );

  // ── meowtrack_node_complete ──────────────────────────────────────────────────
  server.registerTool(
    "meowtrack_node_complete",
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: "Clôturer une tâche (+ rapport)",
      description:
        "Clôt une tâche réclamée (détenteur du bail uniquement). Ingère le rapport (inline `report` ou " +
        ".meowtrack/runs/<ref>.json) : applique les `nodeUpdates` sûrs, persiste les `reviewPoints`. Sans point " +
        "bloquant → 'done' (débloque les dépendants, progression remonte) ; sinon → 'review'. Réponse " +
        "hint:'compact_suggested' si auto_compact est ON. Après clôture : merger la branche dans `main` (+push) avant le nœud suivant.",
      inputSchema: {
        repo: repoParam,
        ref: nodeRefSchema,
        owner: z.string().describe("Détenteur du bail."),
        summary: z.string().optional().describe("Compte-rendu de ce qui a été fait."),
        branch: z.string().optional().describe("Branche de travail."),
        testResult: z.enum(TEST_RESULTS).optional().describe("Résultat des tests."),
        report: z
          .any()
          .optional()
          .describe(
            "Rapport inline (sinon lu depuis .meowtrack/runs/<ref>.json) : { state, summary, nodeUpdates[], reviewPoints[] }. " +
              "`nodeUpdates` accepte les actions NŒUD (add_node/update_node/…) et SUIVI (add_issue/…). " +
              "Non destructif + run.autoApplyUpdates → appliqué ; sinon proposé en revue."
          ),
      },
    },
    guard(async ({ repo, ref, ...a }) => apiFetch("POST", "/api/nodes/" + encodeURIComponent(ref) + "/complete" + qs({ repo: repoOf(repo) }), a))
  );

  // ── meowtrack_node_fail ──────────────────────────────────────────────────────
  server.registerTool(
    "meowtrack_node_fail",
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: "Signaler l'échec d'une tâche",
      description: "Marque une tâche en échec (libère le bail ; rejouable tant que le nombre de tentatives reste sous le maximum).",
      inputSchema: {
        repo: repoParam,
        ref: nodeRefSchema,
        owner: z.string().describe("Détenteur du bail."),
        error: z.string().optional().describe("Message d'erreur."),
        branch: z.string().optional(),
      },
    },
    guard(async ({ repo, ref, owner, error, branch }) =>
      apiFetch("POST", "/api/nodes/" + encodeURIComponent(ref) + "/fail" + qs({ repo: repoOf(repo) }), { owner, error, branch })
    )
  );

  // ── meowtrack_node_runs ──────────────────────────────────────────────────────
  server.registerTool(
    "meowtrack_node_runs",
    {
      annotations: { readOnlyHint: true },
      title: "Historique d'exécution d'un nœud",
      description: "Liste les runs d'un nœud (état, branche, résumé, test, rapport), du plus récent au plus ancien.",
      inputSchema: { repo: repoParam, ref: nodeRefSchema },
    },
    guard(async ({ repo, ref }) => apiGet("/api/nodes/" + encodeURIComponent(ref) + "/runs" + qs({ repo: repoOf(repo) })))
  );

  // ── meowtrack_node_reviews ───────────────────────────────────────────────────
  server.registerTool(
    "meowtrack_node_reviews",
    {
      annotations: { readOnlyHint: true },
      title: "Lister les points de revue",
      description:
        "Liste les points de revue. Avec `ref` → ceux d'un nœud ; sans `ref` → la file globale du repo. " +
        "`state` filtre (open/resolved/dismissed).",
      inputSchema: {
        repo: repoParam,
        ref: nodeRefSchema.optional().describe("Nœud cible (absent = file globale du repo)."),
        state: z.enum(["open", "resolved", "dismissed"]).optional(),
      },
    },
    guard(async ({ repo, ref, state }) =>
      ref != null
        ? apiGet("/api/nodes/" + encodeURIComponent(ref) + "/reviews" + qs({ repo: repoOf(repo), state }))
        : apiGet("/api/nodes/reviews" + qs({ repo: repoOf(repo), state }))
    )
  );

  // ── meowtrack_review_auto ────────────────────────────────────────────────────
  server.registerTool(
    "meowtrack_review_auto",
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: "Auto-réviser des points de revue (chat IA top-level)",
      description:
        "Déclenche une AUTO-REVUE : le chat IA forêt traite les points de revue d'un nœud en remodelant l'arbre/les " +
        "tâches (actions destructives proposées pour confirmation). Réponse 202 puis stream SSE.",
      inputSchema: {
        repo: repoParam,
        ref: nodeRefSchema.describe("Nœud dont on auto-révise les points."),
        reviewIds: z.array(z.number().int()).optional().describe("Ids des points à traiter (défaut : tous les points ouverts)."),
        model: z.enum(["sonnet", "opus", "haiku"]).optional().describe("Modèle de l'auto-revue."),
      },
    },
    guard(async ({ repo, ref, reviewIds, model }) =>
      apiFetch("POST", "/api/nodes/" + encodeURIComponent(ref) + "/reviews/auto" + qs({ repo: repoOf(repo) }), { reviewIds, model })
    )
  );
}
