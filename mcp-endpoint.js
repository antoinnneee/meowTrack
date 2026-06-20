// mcp-endpoint.js — endpoint MCP distant (POST/GET/DELETE /mcp).
//
// Expose le MÊME jeu d'outils que mcp.js (module partagé mcp-tools.js), mais via le
// transport Streamable HTTP du SDK — pour un client configuré en `type: http` sans
// relais local. Les outils tapent l'API REST du serveur lui-même en loopback (avec
// le token interne) : une seule source de vérité, aucun accès direct à db.js depuis
// le module d'outils.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerMeowtrackTools } from "./mcp-tools.js";
import { TOKEN, PORT, MCP_DEFAULT_REPO } from "./config.js";
import { readBody } from "./http-util.js";

async function loopbackApiFetch(method, path, body) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (TOKEN) headers["Authorization"] = "Bearer " + TOKEN;
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${PORT}` + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(`API meowtrack injoignable (loopback) : ${e.message || e}`);
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

// Mode stateless : un McpServer + un transport neufs par requête (pas de session
// persistée). Simple et robuste derrière un service systemd / multi-clients.
export async function handleMcp(req, res) {
  const mcp = new McpServer({ name: "meowtrack", version: "1.0.0" });
  registerMeowtrackTools(mcp, { apiFetch: loopbackApiFetch, defaultRepo: MCP_DEFAULT_REPO });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => {});
    mcp.close().catch(() => {});
  });
  await mcp.connect(transport);
  // Le SDK attend le corps déjà parsé pour les POST (body-parser-like) ; GET/DELETE
  // n'en ont pas. readBody renvoie {} sur corps vide — neutre pour la négociation.
  const parsedBody = req.method === "POST" ? await readBody(req) : undefined;
  await transport.handleRequest(req, res, parsedBody);
}
