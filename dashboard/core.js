// core.js — noyau partagé du front Meowtrack (helpers DOM, auth/token, repo actif,
// client API). Importé par tous les modules de vues (issues / vibes / repo).
// Vanilla JS, aucune dépendance.

export const $ = (sel) => document.querySelector(sel);

// Token d'accès (serveur déployé protégé par MEOWTRACK_TOKEN). Stocké localement,
// envoyé en Bearer. Sur 401 on (re)demande le token et on réessaie une fois.
export function getToken() {
  return localStorage.getItem("meowtrack_token") || "";
}
function promptToken() {
  const t = window.prompt("Token d'accès Meowtrack (MEOWTRACK_TOKEN du serveur) :", getToken());
  if (t === null) return null;
  localStorage.setItem("meowtrack_token", t.trim());
  return t.trim();
}
function authHeaders(extra = {}) {
  const t = getToken();
  return t ? { ...extra, Authorization: "Bearer " + t } : extra;
}

// ── Repo actif (multi-repos) ─────────────────────────────────────────────────
// Slug du repo courant, persisté localement. Injecté en `?repo=` sur toutes les
// requêtes /api/* SAUF la gestion du registre (/api/repos*, qui cible par chemin).
export function activeRepo() {
  return localStorage.getItem("meowtrack_repo") || "";
}
export function setActiveRepo(slug) {
  localStorage.setItem("meowtrack_repo", slug || "");
}
export function injectRepo(url) {
  if (!url.startsWith("/api/") || url.startsWith("/api/repos")) return url;
  const r = activeRepo();
  if (!r) return url;
  return url + (url.includes("?") ? "&" : "?") + "repo=" + encodeURIComponent(r);
}

export const api = {
  async _do(method, url, body, retried) {
    const r = await fetch(injectRepo(url), {
      method,
      headers: authHeaders(body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401 && !retried) {
      if (promptToken() !== null) return api._do(method, url, body, true);
    }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  },
  get(url) {
    return api._do("GET", url, undefined, false);
  },
  send(method, url, body) {
    return api._do(method, url, body, false);
  },
};

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
