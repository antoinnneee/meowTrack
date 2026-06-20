// github.js — auth GitHub (device flow OAuth) : petit client HTTPS sans dépendance,
// état des flows en cours, résolution du client_id et liste d'hôtes git custom.
// Les handlers de routes correspondants vivent dans routes/github.js.

import { request as httpsRequest } from "node:https";
import { getSetting, setSetting } from "./db.js";
import { GITHUB_CLIENT_ID_ENV } from "./config.js";

// Priorité au réglage saisi dans l'UI (table app_settings), repli sur la variable d'env.
export function githubClientId() {
  return (getSetting("github_client_id", "") || GITHUB_CLIENT_ID_ENV).trim();
}

// Liste des hôtes git custom (Gitea/GitLab self-hosted…) dont on a enregistré un
// credential HTTP(S). On ne stocke JAMAIS le mot de passe ici (il vit dans le
// credential store git) — seulement { protocol, host, username } pour l'affichage.
export function loadCustomHosts() {
  try {
    const v = JSON.parse(getSetting("custom_git_hosts", "[]"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
export function saveCustomHosts(list) {
  setSetting("custom_git_hosts", JSON.stringify(list));
}

// Device flows en cours : flowId → { deviceCode, repoId, interval, expiresAt }.
// Le device_code (secret de poll) reste côté serveur ; le client ne voit que le user_code.
export const githubFlows = new Map();

// POST form-urlencoded → JSON.
export function githubPost(host, reqPath, form) {
  const data = new URLSearchParams(form).toString();
  return new Promise((resolve, reject) => {
    const r = httpsRequest(
      {
        host,
        path: reqPath,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(data),
          "User-Agent": "meowtrack",
        },
      },
      (resp) => {
        let body = "";
        resp.on("data", (c) => (body += c));
        resp.on("end", () => {
          try {
            resolve({ status: resp.statusCode, json: body ? JSON.parse(body) : {} });
          } catch {
            resolve({ status: resp.statusCode, json: {} });
          }
        });
      }
    );
    r.on("error", reject);
    r.setTimeout(15000, () => r.destroy(new Error("Délai dépassé (GitHub)")));
    r.write(data);
    r.end();
  });
}

// GET api.github.com avec token bearer → JSON (sert à récupérer le login).
export function githubGet(reqPath, token) {
  return new Promise((resolve, reject) => {
    const r = httpsRequest(
      {
        host: "api.github.com",
        path: reqPath,
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "meowtrack",
        },
      },
      (resp) => {
        let body = "";
        resp.on("data", (c) => (body += c));
        resp.on("end", () => {
          try {
            resolve({ status: resp.statusCode, json: body ? JSON.parse(body) : {} });
          } catch {
            resolve({ status: resp.statusCode, json: {} });
          }
        });
      }
    );
    r.on("error", reject);
    r.setTimeout(15000, () => r.destroy(new Error("Délai dépassé (GitHub)")));
    r.end();
  });
}
