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
//   MEOWTRACK_LOCK_REPO     VERROU mono-repo : restreint ce MCP à CE seul dépôt
//                           (rejette tout `repo` divergent, masque les autres dans
//                           meowtrack_repos). Idéal pour un MCP lancé par dépôt.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { registerMeowtrackTools } from "./mcp-tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(HERE, ".env") });

const BASE = (process.env.MEOWTRACK_SERVER_URL || "http://127.0.0.1:7702").replace(/\/+$/, "");
const TOKEN = (process.env.MEOWTRACK_TOKEN || "").trim();
const DEFAULT_REPO = (process.env.MEOWTRACK_DEFAULT_REPO || "").trim();
const LOCK_REPO = (process.env.MEOWTRACK_LOCK_REPO || "").trim();

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

const server = new McpServer({ name: "meowtrack", version: "1.0.0" });
registerMeowtrackTools(server, { apiFetch, defaultRepo: DEFAULT_REPO, lockRepo: LOCK_REPO });

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[meowtrack] MCP server prêt (stdio) → API ${BASE}.`);
