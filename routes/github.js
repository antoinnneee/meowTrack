// routes/github.js — auth GitHub (device flow OAuth) + credentials HTTP(S)
// génériques (Gitea/GitLab self-hosted…). Chemins exacts sous /api/git/github/* et
// /api/git/credentials* (pas de collision avec routes/git.js).

import { randomUUID } from "node:crypto";
import { send, readBody, repoOf } from "../http-util.js";
import { getSetting, setSetting } from "../db.js";
import { GITHUB_CLIENT_ID_ENV } from "../config.js";
import { githubClientId, githubPost, githubGet, githubFlows, loadCustomHosts, saveCustomHosts } from "../github.js";
import {
  githubCredentialStatusFor,
  storeGithubCredentialFor,
  clearGithubCredentialFor,
  storeCredentialFor,
  clearCredentialFor,
  credentialStatusFor,
} from "../repos.js";

export async function handle(ctx) {
  const { req, res, method, path, q } = ctx;

  // État : OAuth App configurée ? credential github.com présent ? (jamais le token)
  // `clientId` (non secret) sert à pré-remplir le champ de l'UI.
  if (method === "GET" && path === "/api/git/github/status") {
    const clientId = githubClientId();
    send(res, 200, {
      configured: !!clientId,
      clientId,
      clientIdFromEnv: !getSetting("github_client_id", "") && !!GITHUB_CLIENT_ID_ENV,
      ...githubCredentialStatusFor(repoOf(q)),
    });
    return true;
  }
  // Enregistre/efface le client_id de l'OAuth App (saisi dans l'UI, persisté en base).
  if (method === "POST" && path === "/api/git/github/client-id") {
    const body = await readBody(req);
    const clientId = setSetting("github_client_id", String(body.clientId || "").trim());
    send(res, 200, { ok: true, configured: !!clientId, clientId });
    return true;
  }
  // Démarre le device flow : renvoie le user_code + l'URL à ouvrir (device_code gardé serveur).
  if (method === "POST" && path === "/api/git/github/device/start") {
    const id = repoOf(q, await readBody(req));
    const clientId = githubClientId();
    if (!clientId)
      return send(res, 200, {
        configured: false,
        message:
          "Aucun Client ID GitHub configuré. Renseigne le Client ID de ton OAuth App " +
          "(Settings → Developer settings → OAuth Apps, « Enable Device Flow ») dans le champ ci-dessus.",
      }), true;
    const r = await githubPost("github.com", "/login/device/code", { client_id: clientId, scope: "repo" });
    if (r.status !== 200 || !r.json.device_code)
      return send(res, 502, { error: "github_error", message: r.json.error_description || "Échec du device flow GitHub." }), true;
    const flowId = randomUUID();
    const interval = Math.max(5, Number(r.json.interval) || 5);
    githubFlows.set(flowId, {
      deviceCode: r.json.device_code,
      repoId: id,
      interval,
      expiresAt: Date.now() + (Number(r.json.expires_in) || 900) * 1000,
    });
    send(res, 200, {
      configured: true,
      flowId,
      userCode: r.json.user_code,
      verificationUri: r.json.verification_uri,
      interval,
      expiresIn: r.json.expires_in,
    });
    return true;
  }
  // Poll : pending / pending+slow_down / success (token stocké) / error.
  if (method === "POST" && path === "/api/git/github/device/poll") {
    const body = await readBody(req);
    const flow = githubFlows.get(body.flowId);
    if (!flow) return send(res, 200, { status: "error", message: "Session expirée, relance la connexion." }), true;
    if (Date.now() > flow.expiresAt) {
      githubFlows.delete(body.flowId);
      return send(res, 200, { status: "error", message: "Code expiré, relance la connexion." }), true;
    }
    const r = await githubPost("github.com", "/login/oauth/access_token", {
      client_id: githubClientId(),
      device_code: flow.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    const j = r.json || {};
    if (j.error === "authorization_pending") return send(res, 200, { status: "pending" }), true;
    if (j.error === "slow_down") {
      flow.interval = Math.max(flow.interval + 5, Number(j.interval) || flow.interval + 5);
      return send(res, 200, { status: "pending", interval: flow.interval }), true;
    }
    if (j.error) {
      githubFlows.delete(body.flowId);
      return send(res, 200, { status: "error", message: j.error_description || j.error }), true;
    }
    if (!j.access_token) return send(res, 200, { status: "pending" }), true;
    // Succès : récupère le login (best-effort) puis persiste le credential.
    const token = j.access_token;
    let login = "x-access-token";
    try {
      const u = await githubGet("/user", token);
      if (u.status === 200 && u.json.login) login = u.json.login;
    } catch {
      /* login best-effort : on garde x-access-token */
    }
    githubFlows.delete(body.flowId);
    const stored = storeGithubCredentialFor(flow.repoId, { username: login, token });
    if (!stored.ok)
      return send(res, 200, { status: "error", message: "Token reçu mais échec d'enregistrement : " + (stored.output || "") }), true;
    send(res, 200, { status: "success", login });
    return true;
  }
  // Déconnexion : oublie le credential github.com.
  if (method === "POST" && path === "/api/git/github/disconnect") {
    const id = repoOf(q, await readBody(req));
    const st = githubCredentialStatusFor(id);
    const r = clearGithubCredentialFor(id, { username: st.username });
    send(res, 200, { ok: r.ok, output: r.output });
    return true;
  }
  // ── Credentials HTTP(S) génériques (Gitea/GitLab self-hosted…) ──
  // Liste enrichie de l'état de connexion en direct (jamais le mot de passe).
  if (method === "GET" && path === "/api/git/credentials") {
    const id = repoOf(q);
    const list = loadCustomHosts().map((e) => ({
      protocol: e.protocol || "https",
      host: e.host,
      username: e.username || "",
      ...credentialStatusFor(id, { protocol: e.protocol || "https", host: e.host }),
    }));
    send(res, 200, { credentials: list });
    return true;
  }
  // Enregistre un credential (host + username + mot de passe/token) + mémorise l'hôte.
  if (method === "POST" && path === "/api/git/credentials") {
    const body = await readBody(req);
    const id = repoOf(q, body);
    const protocol = String(body.protocol || "https").toLowerCase() === "http" ? "http" : "https";
    const host = String(body.host || "").trim();
    const username = String(body.username || "").trim();
    const r = storeCredentialFor(id, { protocol, host, username, password: body.password });
    if (!r.ok) return send(res, 200, { ok: false, output: r.output }), true;
    const list = loadCustomHosts().filter((e) => !(e.host === host && (e.protocol || "https") === protocol));
    list.push({ protocol, host, username });
    saveCustomHosts(list);
    send(res, 200, { ok: true });
    return true;
  }
  // Supprime un credential (reject git) + retire l'hôte de la liste mémorisée.
  if (method === "POST" && path === "/api/git/credentials/delete") {
    const body = await readBody(req);
    const id = repoOf(q, body);
    const protocol = String(body.protocol || "https").toLowerCase() === "http" ? "http" : "https";
    const host = String(body.host || "").trim();
    const r = clearCredentialFor(id, { protocol, host, username: body.username });
    saveCustomHosts(loadCustomHosts().filter((e) => !(e.host === host && (e.protocol || "https") === protocol)));
    send(res, 200, { ok: r.ok, output: r.output });
    return true;
  }

  return false;
}
