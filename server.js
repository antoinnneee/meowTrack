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

// Exporté pour les tests isolés (cf. test/parse_ai_turn.test.mjs, ghost_payload.test.mjs).
export { parseAiTurn, ghostPayloadFromAction } from "./ai/parse.js";

// Token d'accès : si MEOWTRACK_TOKEN est défini, /mcp et /api/* l'exigent (Bearer,
// en-tête X-Meowtrack-Token, ou ?token=). Vide → ouvert (OK en local).
function authorized(req, q) {
  if (!TOKEN) return true;
  const auth = req.headers["authorization"] || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const provided = bearer || req.headers["x-meowtrack-token"] || q.get("token") || "";
  return provided === TOKEN;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = normalize(url.pathname).replace(/\\/g, "/");
  const q = url.searchParams;

  try {
    // ── Statique ── (toujours servi : la page doit pouvoir demander le token)
    if (req.method === "GET" && (await serveStatic(path, res))) return;

    // ── Endpoint MCP (Streamable HTTP) ── même garde token que /api/*.
    if (path === "/mcp") {
      if (!authorized(req, q)) return send(res, 401, { error: "unauthorized" });
      return handleMcp(req, res);
    }

    // ── Auth API ── si un token est configuré, /api/* l'exige.
    if (path.startsWith("/api/") && !authorized(req, q)) {
      return send(res, 401, { error: "unauthorized" });
    }

    // ── API ── chaîne de modules de routes par domaine (premier qui traite gagne).
    const ctx = { req, res, method: req.method, path, q };
    if (await reposRoutes(ctx)) return;
    if (await gitRoutes(ctx)) return;
    if (await githubRoutes(ctx)) return;
    if (await issuesRoutes(ctx)) return;
    if (await nodesRoutes(ctx)) return;

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
