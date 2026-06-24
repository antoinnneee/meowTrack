#!/usr/bin/env node
// server.js — point d'entrée du serveur HTTP du dashboard Meowtrack (dev-only).
//
// Sert le dashboard statique + une petite API REST JSON par-dessus db.js. Pas de
// framework : http natif + routage manuel. La logique est éclatée en modules
// cohérents ; ce fichier ne fait que : charger l'env, monter le routeur (garde
// token + statique + MCP + chaîne de modules de routes), et orchestrer le démarrage.
//
//   config.js        configuration d'instance + politique de sandbox IA
//   http-util.js     send / readBody / statique / repoOf
//   sse.js           broadcaster temps réel (rooms nœud + forêt)
//   github.js        client HTTPS GitHub + device flows
//   mcp-endpoint.js  endpoint MCP Streamable HTTP (loopback)
//   ai/              parse (fail-closed) · prompts · claude (CLI) · turns (chat)
//   routes/          repos · git · github · issues · nodes (un module par domaine)
//
// Déploiement : binder 0.0.0.0 via MEOWTRACK_HOST + protéger l'API par
// MEOWTRACK_TOKEN (Bearer). Cf. .env.example + install-service.sh.

import "dotenv/config";
import { createServer } from "node:http";
import { normalize } from "node:path";

import { TOKEN, PORT, HOST } from "./config.js";
import { send, serveStatic } from "./http-util.js";
import { repoByToken, resolveRepoId } from "./db.js";
import { handleMcp } from "./mcp-endpoint.js";
import {
  ensureAllRepos,
  trackingGitEnabled,
  syncAllTrackingStores,
  startTrackingCommitter,
  stopTrackingCommitter,
} from "./repos.js";

import { handle as reposRoutes } from "./routes/repos.js";
import { handle as gitRoutes } from "./routes/git.js";
import { handle as githubRoutes } from "./routes/github.js";
import { handle as issuesRoutes } from "./routes/issues.js";
import { handle as nodesRoutes } from "./routes/nodes.js";
import { handle as settingsRoutes } from "./routes/settings.js";
import { handle as templatesRoutes } from "./routes/templates.js";
import { handle as pagesRoutes } from "./routes/pages.js";
import { resumeQueuedTurns } from "./ai/turns.js";

// Exporté pour les tests isolés (cf. test/parse_ai_turn.test.mjs, ghost_payload.test.mjs).
export { parseAiTurn, ghostPayloadFromAction } from "./ai/parse.js";

// Extraction du token présenté (Bearer / X-Meowtrack-Token / ?token=).
function presentedToken(req, q) {
  const auth = req.headers["authorization"] || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return (bearer || req.headers["x-meowtrack-token"] || q.get("token") || "").trim();
}

// ── Auth (NODE-372) ──────────────────────────────────────────────────────────
// Deux niveaux de credential :
//   · MEOWTRACK_TOKEN global (config) → accès ADMIN cross-repo (dashboard).
//   · token PAR dépôt (repos.token)  → accès SCOPÉ à CE seul dépôt (MCP/skills).
// Renvoie { ok, admin, repoId? }. Sans MEOWTRACK_TOKEN configuré, l'API est ouverte
// (admin) — sauf si un token de DÉPÔT valide est présenté, qui scope alors l'accès
// (le verrou mono-repo NODE-301 devient effectif côté serveur, même en local).
export function resolveAuth(req, q) {
  const provided = presentedToken(req, q);
  if (provided) {
    if (TOKEN && provided === TOKEN) return { ok: true, admin: true };
    const repo = repoByToken(provided);
    if (repo) return { ok: true, admin: false, repoId: repo.id, repoSlug: repo.slug };
    // Token fourni mais inconnu : refusé si un token global est exigé ; sinon ignoré.
    if (TOKEN) return { ok: false };
  }
  // Aucun token (ou token inconnu en mode ouvert) : admin si l'API est ouverte.
  return TOKEN ? { ok: false } : { ok: true, admin: true };
}

// Portée d'un token de DÉPÔT sur /api/* (NODE-374). Un token de dépôt n'autorise QUE
// les routes scopées à SON dépôt ; les routes de gestion du registre (création /
// suppression / import de dépôts) restent réservées à l'admin. Effet de bord : pour
// les routes scopées, force `?repo=` au dépôt du token (un repo omis ou divergent ne
// peut JAMAIS sortir de la portée — fail-safe, comme enforceLock côté MCP).
// Renvoie true si autorisé (et la query a été épinglée au besoin), false sinon.
// Exporté pour les tests (cf. test/repo_token.test.mjs).
export function enforceRepoScope(path, method, q, auth) {
  if (auth.admin) return true;
  // Gestion du registre : /api/repos/:idOrSlug(/sub) ou la collection /api/repos.
  const m = path.match(/^\/api\/repos\/([^/]+)(\/.*)?$/);
  if (m && m[1] !== "import" && m[1] !== "resolve") {
    let rid;
    try { rid = resolveRepoId(decodeURIComponent(m[1])); } catch { return false; }
    if (rid !== auth.repoId) return false;          // dépôt d'un autre : interdit
    if (method === "DELETE") return false;          // supprimer un dépôt = admin
    return true;                                     // lire / régénérer son propre token : OK
  }
  if (path === "/api/repos" && method !== "GET") return false;  // créer un dépôt = admin
  if (path === "/api/repos/import") return false;               // import en masse = admin
  // /api/repos (GET liste, filtrée en aval) et /api/repos/resolve : lecture autorisée.
  if (path === "/api/repos" || path === "/api/repos/resolve") return true;
  // Toutes les autres routes /api/* sont scopées repo : on épingle le dépôt du token
  // (rejette un ?repo= explicite divergent).
  const reqRepo = q.get("repo");
  if (reqRepo) {
    let rid;
    try { rid = resolveRepoId(reqRepo); } catch { return false; }
    if (rid !== auth.repoId) return false;
  }
  q.set("repo", String(auth.repoId));
  return true;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = normalize(url.pathname).replace(/\\/g, "/");
  const q = url.searchParams;

  try {
    // ── Statique ── (toujours servi : la page doit pouvoir demander le token)
    if (req.method === "GET" && (await serveStatic(path, res))) return;

    // ── Endpoint MCP (Streamable HTTP, loopback) ── réservé à l'admin (le MCP stdio
    // passe par /api/*, pas par ici). Un token de dépôt ne peut pas piloter /mcp.
    if (path === "/mcp") {
      const auth = resolveAuth(req, q);
      if (!auth.ok || !auth.admin) return send(res, auth.ok ? 403 : 401, { error: auth.ok ? "forbidden" : "unauthorized" });
      return handleMcp(req, res);
    }

    // ── Auth API ── token global (admin) OU token de dépôt (scopé à ce dépôt).
    let auth = { ok: true, admin: true };
    if (path.startsWith("/api/")) {
      auth = resolveAuth(req, q);
      if (!auth.ok) return send(res, 401, { error: "unauthorized" });
      if (!enforceRepoScope(path, req.method, q, auth)) return send(res, 403, { error: "forbidden_repo_scope" });
    }

    // ── API ── chaîne de modules de routes par domaine (premier qui traite gagne).
    const ctx = { req, res, method: req.method, path, q, auth };
    if (await reposRoutes(ctx)) return;
    if (await gitRoutes(ctx)) return;
    if (await githubRoutes(ctx)) return;
    if (await issuesRoutes(ctx)) return;
    if (await nodesRoutes(ctx)) return;
    if (await settingsRoutes(ctx)) return;
    if (await templatesRoutes(ctx)) return;
    if (await pagesRoutes(ctx)) return;

    send(res, 404, { error: "not_found", path });
  } catch (e) {
    // Log côté serveur AVANT de répondre : le 400 « nu » masquait jusqu'ici toute
    // erreur (stack incluse). Indispensable pour diagnostiquer p.ex. la création de nœud.
    console.error(`[meowtrack] ⚠️  ${req.method} ${path} → ${e.message || e}`);
    if (e && e.stack) console.error(e.stack);
    send(res, 400, { error: e.message || String(e) });
  }
});

// MEOWTRACK_NO_LISTEN=1 : importe le module (handlers, parseAiTurn…) sans démarrer
// le serveur — utilisé par les tests isolés.
if (process.env.MEOWTRACK_NO_LISTEN !== "1") {
  // Sync de TOUS les repos du registre au démarrage : clone si absent, sinon pull.
  // No-op pour un repo sans URL. Tolérant aux échecs (un repo cassé n'en bloque pas un autre).
  console.error("[meowtrack] Sync des repos du registre…");
  for (const r of ensureAllRepos()) {
    if (r.skipped) console.error(`[meowtrack]   ${r.slug} : clone local (pas d'URL) — ${r.branch || "?"}.`);
    else if (r.ok) console.error(`[meowtrack]   ${r.slug} : ${r.cloned ? "cloné" : "à jour"} (${r.branch || "?"} @ ${r.commit || "?"}).`);
    else console.error(`[meowtrack]   ⚠️  ${r.slug} : sync échouée — ${r.output || "erreur inconnue"}`);
  }

  // Reprise des tours de chat IA EN FILE (Option B, NODE-329) : enchaîne les messages
  // `queued` persistés survivants à un reload, et purge les placeholders orphelins
  // d'un crash. Best-effort — n'interrompt jamais le démarrage.
  try {
    const resumed = resumeQueuedTurns();
    if (resumed) console.error(`[meowtrack] Reprise de ${resumed} tour(s) de chat IA en file.`);
  } catch (e) {
    console.error(`[meowtrack] ⚠️  Reprise des tours en file impossible : ${e.message || e}`);
  }

  // Versionnement git des tracker.db (opt-in MEOWTRACK_TRACKING_GIT=1) : prépare les
  // worktrees de la branche orphan « tracking » (restore inter-machines), démarre le
  // committer périodique, et fait un flush+commit final à l'arrêt.
  if (trackingGitEnabled()) {
    console.error("[meowtrack] Versionnement tracking (branche orphan) : préparation des worktrees…");
    for (const s of syncAllTrackingStores()) {
      if (s.error) console.error(`[meowtrack]   ⚠️  ${s.slug} : ${s.error}`);
      else console.error(`[meowtrack]   ${s.slug} : ${s.mode}.`);
    }
    startTrackingCommitter();
  }
  // Commit final à l'arrêt — enregistré INCONDITIONNELLEMENT (no-op si désactivé) pour
  // couvrir une activation faite à chaud via l'UI après le démarrage.
  let _flushed = false;
  const flush = () => {
    if (_flushed) return;
    _flushed = true;
    try { stopTrackingCommitter(); } catch { /* ignore */ }
  };
  process.on("SIGINT", () => { flush(); process.exit(0); });
  process.on("SIGTERM", () => { flush(); process.exit(0); });
  process.on("exit", flush);

  server.listen(PORT, HOST, () => {
    console.error(`[meowtrack] Dashboard prêt → http://${HOST}:${PORT}`);
    if (HOST !== "127.0.0.1" && HOST !== "localhost" && !TOKEN) {
      console.error(
        "[meowtrack] ⚠️  Écoute hors localhost SANS MEOWTRACK_TOKEN : l'API est ouverte à tout le réseau. " +
          "Définir MEOWTRACK_TOKEN en production."
      );
    }
  });
}
