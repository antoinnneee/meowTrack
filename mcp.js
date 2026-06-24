#!/usr/bin/env node
// mcp.js — serveur MCP (stdio) du suivi Meowtrack.
//
// Client de l'API HTTP du dashboard déployé : toutes les requêtes passent par le
// serveur distant (server.js), qui est la SEULE source de vérité (base SQLite +
// repos clonés). Le MCP ne touche JAMAIS de base locale — il relaie vers le serveur.
// Lancement : node mcp.js (configuré dans .mcp.json racine). Aucune dépendance à
// l'app Qt.
//
// Les outils eux-mêmes sont déclarés dans mcp-tools.js (module PARTAGÉ avec
// l'endpoint HTTP `POST /mcp` de server.js). Ce fichier ne fait que câbler le
// transport stdio et fournir un `apiFetch` distant.
//
// MULTI-REPOS : le suivi gère plusieurs dépôts git distincts. Chaque entrée /
// nœud appartient à UN repo. Le paramètre `repo` (slug ou id, ex. 'meownopoly')
// cible le repo ; omis, le serveur retombe sur le repo par défaut. Un défaut local
// peut être fixé via MEOWTRACK_DEFAULT_REPO (injecté si l'appel n'en fournit pas).
//
// Config (env ou meowtrack/.env, chargé explicitement quel que soit le cwd) :
//   MEOWTRACK_SERVER_URL    base de l'API (défaut http://127.0.0.1:7702 ; en prod
//                           ex. http://pattounecorp.ovh:7702).
//   MEOWTRACK_TOKEN         jeton Bearer si le serveur en exige un (sinon vide).
//   MEOWTRACK_DEFAULT_REPO  repo (slug/id) appliqué quand un appel n'en précise pas.
//   MEOWTRACK_LOCK_REPO     VERROU mono-repo OVERRIDE optionnel (slug/id) : restreint
//                           ce MCP à CE seul dépôt. Normalement INUTILE — le verrou est
//                           auto-détecté depuis le cwd (le MCP est lancé par dépôt) ;
//                           cette variable ne sert qu'à forcer un dépôt explicitement.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { dirname, join, parse as parsePath } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import dotenv from "dotenv";
import { registerMeowtrackTools } from "./mcp-tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(HERE, ".env") });

// NODE-372/377 : token PAR dépôt, lu depuis `.meowtrack/token` à la racine du clone
// (le MCP est lancé PAR dépôt → process.cwd() est dans le clone). On remonte les
// dossiers parents (comme la résolution d'un `.git`). Ce fichier prime sur l'env :
// il SCOPE l'accès à CE seul dépôt côté serveur (remplace le verrou par cwd).
function readLocalToken(startDir) {
  let dir = startDir;
  const root = parsePath(dir).root;
  for (let i = 0; i < 64; i++) {
    const f = join(dir, ".meowtrack", "token");
    try {
      if (existsSync(f)) {
        const t = readFileSync(f, "utf8").trim();
        if (t) return { token: t, path: f };
      }
    } catch { /* illisible : on continue de remonter */ }
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const BASE = (process.env.MEOWTRACK_SERVER_URL || "http://127.0.0.1:7702").replace(/\/+$/, "");
const _localToken = readLocalToken(process.cwd());
// Le fichier local prime sur l'env (token de DÉPÔT > token global éventuel).
const TOKEN = (_localToken ? _localToken.token : process.env.MEOWTRACK_TOKEN || "").trim();
const DEFAULT_REPO = (process.env.MEOWTRACK_DEFAULT_REPO || "").trim();
const LOCK_REPO = (process.env.MEOWTRACK_LOCK_REPO || "").trim();

if (_localToken) console.error(`[meowtrack] MCP : token de dépôt lu depuis ${_localToken.path} (accès scopé à ce dépôt).`);
else if (!TOKEN) console.error(
  "[meowtrack] MCP : aucun token (.meowtrack/token absent du cwd et MEOWTRACK_TOKEN vide). " +
  "Si le serveur exige un token, copie celui du dépôt depuis le dashboard (bouton 🔑) dans .meowtrack/token."
);

// ── Client HTTP de l'API du serveur distant ──────────────────────────────────
async function apiFetch(method, path, body) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (TOKEN) headers["Authorization"] = "Bearer " + TOKEN;
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(`Serveur meowtrack injoignable (${BASE}) : ${e.message || e}`);
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = (data && data.error) || res.statusText || `HTTP ${res.status}`;
    throw new Error(`${msg} (HTTP ${res.status})`);
  }
  return data;
}

// Verrou mono-repo SANS config (NODE-301) : le MCP est lancé PAR dépôt (.mcp.json à
// la racine du clone) → process.cwd() identifie le dépôt. On demande au serveur de
// résoudre ce cwd vers un repo ; le repo trouvé devient le verrou. MEOWTRACK_LOCK_REPO
// reste un override explicite optionnel (rétro-compat). Aucun match (ex. serveur
// distant, FS différent) → mode non verrouillé (cross-repo) + avertissement stderr.
async function resolveLockRepo() {
  if (LOCK_REPO) return LOCK_REPO; // override explicite
  const cwd = process.cwd();
  try {
    const r = await apiFetch("GET", "/api/repos/resolve?path=" + encodeURIComponent(cwd));
    if (r && r.slug) {
      console.error(`[meowtrack] MCP verrouillé sur « ${r.slug} » (déduit du cwd ${cwd}).`);
      return r.slug;
    }
    console.error(`[meowtrack] MCP NON verrouillé : le cwd (${cwd}) ne correspond à aucun dépôt connu — accès cross-repo.`);
  } catch (e) {
    console.error(`[meowtrack] MCP NON verrouillé : résolution du dépôt depuis le cwd impossible (${e.message || e}).`);
  }
  return "";
}

const server = new McpServer({ name: "meowtrack", version: "1.0.0" });
const lockRepo = await resolveLockRepo();
registerMeowtrackTools(server, { apiFetch, defaultRepo: DEFAULT_REPO, lockRepo });

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[meowtrack] MCP server prêt (stdio) → API ${BASE}.`);
