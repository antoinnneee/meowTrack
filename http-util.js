// http-util.js — primitives de transport HTTP partagées par le routeur et les
// modules de routes : réponse JSON, lecture de corps bornée, fichiers statiques
// (allowlist), et résolution du paramètre `repo`.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepoId } from "./db.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PUBLIC = join(HERE, "dashboard");

// Allowlist stricte des fichiers statiques (pas de path traversal).
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/dashboard.css": ["dashboard.css", "text/css; charset=utf-8"],
  "/dashboard.js": ["dashboard.js", "text/javascript; charset=utf-8"],
};

export function send(res, status, body, headers = {}) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(data);
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1_000_000) {
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
  const entry = STATIC[pathname];
  if (!entry) return false;
  const [file, mime] = entry;
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
