// http-util.js — primitives de transport HTTP partagées par le routeur et les
// modules de routes : réponse JSON, lecture de corps bornée, fichiers statiques
// (allowlist), et résolution du paramètre `repo`.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepoId } from "./db.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PUBLIC = join(HERE, "dashboard");

// Types servis depuis le dossier dashboard/ (SPA modulaire : un fichier par bloc).
const STATIC_MIME = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};
// Nom de fichier SÛR : un seul segment (aucun « / » ni « .. »), caractères restreints
// + extension connue → impossible de sortir de PUBLIC (anti path-traversal).
const SAFE_STATIC = /^\/[a-zA-Z0-9_-]+\.(js|css|html)$/;

export function send(res, status, body, headers = {}) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(data);
}

// Plafond de corps pour les routes de chat IA (NODE-350) : un message peut porter
// jusqu'à 4 images ≤ 5 Mo (20 Mo bruts → ~27 Mo une fois en base64 dans le JSON).
// On laisse une marge → 30 Mo. Les autres routes gardent le plafond serré par défaut.
export const CHAT_MAX_BODY = 30_000_000;

export function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("Payload trop volumineux"));
        req.destroy();
        return;
      }
      raw += c;
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("JSON invalide"));
      }
    });
    req.on("error", reject);
  });
}

export async function serveStatic(pathname, res) {
  let file;
  if (pathname === "/") file = "index.html";
  else if (SAFE_STATIC.test(pathname)) file = pathname.slice(1);
  else return false;
  const mime = STATIC_MIME[file.slice(file.lastIndexOf("."))];
  if (!mime) return false;
  try {
    const data = await readFile(join(PUBLIC, file));
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
    res.end(data);
  } catch {
    send(res, 404, { error: "not_found" });
  }
  return true;
}

// Résout le paramètre `repo` (querystring ?repo= ou body.repo) → id interne. Vide →
// repo par défaut. Lève (→ 400 par le routeur) si le repo demandé est inconnu.
export function repoOf(q, body) {
  return resolveRepoId((q && q.get("repo")) || (body && body.repo) || null);
}
