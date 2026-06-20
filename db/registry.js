// db/registry.js — base de REGISTRE (par machine) : registre des dépôts (CRUD pur,
// aucune dépendance git ; cf. ../repos.js pour le clone), réglages d'instance
// (app_settings) et résolution du paramètre `repo` (id/slug → id).
//
// N'utilise que la connexion `registry` (importée de ./connection.js). Import
// circulaire SÛR avec ./connection.js (resolveRepoId y est consommé) et
// ../repos.js (removeTrackerStoreFor) : usages en corps de fonction uniquement.

import { registry, closeTrackerDb } from "./connection.js";
import { removeTrackerStoreFor } from "../repos.js";

// ── Réglages globaux (clé/valeur) — base de REGISTRE (instance, par machine) ───
export function getSetting(key, fallback = "") {
  const row = registry.prepare("SELECT value FROM app_settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}
export function setSetting(key, value) {
  registry
    .prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, String(value ?? ""));
  return getSetting(key);
}

// Slug dérivé d'une URL git : dernier segment sans .git, normalisé.
export function deriveSlug(url) {
  if (!url) return null;
  const cleaned = String(url).trim().replace(/\.git$/i, "").replace(/[/]+$/, "");
  const seg = cleaned.split(/[/:]/).filter(Boolean).pop();
  if (!seg) return null;
  return seg.toLowerCase().replace(/[^a-z0-9._-]/g, "-") || null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Registre des repos (CRUD pur — aucune dépendance git ; cf. repos.js pour le clone).
// ═══════════════════════════════════════════════════════════════════════════
function parseHiddenBranches(raw) {
  if (!raw) return [];
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function rowToRepo(r) {
  if (!r) return null;
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    url: r.url,
    localPath: r.local_path,
    defaultBranch: r.default_branch,
    isDefault: !!r.is_default,
    hiddenBranches: parseHiddenBranches(r.hidden_branches),
    createdAt: r.created_at,
  };
}
// Ligne brute par id (numérique) ou slug (chaîne). Utilisé par repos.js.
export function getRepoRow(idOrSlug) {
  if (idOrSlug == null || idOrSlug === "") return null;
  if (typeof idOrSlug === "number" || /^\d+$/.test(String(idOrSlug)))
    return registry.prepare("SELECT * FROM repos WHERE id = ?").get(Number(idOrSlug));
  return registry.prepare("SELECT * FROM repos WHERE slug = ? COLLATE NOCASE").get(String(idOrSlug));
}
export function listRepoRows() {
  return registry.prepare("SELECT * FROM repos ORDER BY is_default DESC, id").all();
}
export function listRepos() {
  return listRepoRows().map(rowToRepo);
}
export function getRepo(idOrSlug) {
  return rowToRepo(getRepoRow(idOrSlug));
}
function defaultRepoRow() {
  return registry.prepare("SELECT * FROM repos WHERE is_default = 1").get() || registry.prepare("SELECT * FROM repos ORDER BY id LIMIT 1").get();
}
// Résout le paramètre `repo` (id ou slug, ou vide) → id. Vide → repo par défaut.
// Lève si le repo demandé est inconnu (jamais de fallback silencieux sur défaut).
export function resolveRepoId(param) {
  if (param == null || param === "") {
    const d = defaultRepoRow();
    if (!d) throw new Error("Aucun repo configuré");
    return d.id;
  }
  const r = getRepoRow(param);
  if (!r) throw new Error(`Repo inconnu : ${param}`);
  return r.id;
}
function sanitizeSlug(slug) {
  return String(slug || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
}
export function createRepo({ slug, name, url, localPath, defaultBranch, isDefault } = {}) {
  let s = sanitizeSlug(slug) || deriveSlug(url);
  if (!s) throw new Error("slug requis (ou URL permettant de le dériver)");
  if (getRepoRow(s)) throw new Error(`slug déjà utilisé : ${s}`);
  const tx = registry.transaction(() => {
    if (isDefault) registry.prepare("UPDATE repos SET is_default = 0").run();
    const res = registry
      .prepare("INSERT INTO repos(slug, name, url, local_path, default_branch, is_default) VALUES(?,?,?,?,?,?)")
      .run(s, String(name || s), url || null, localPath || null, defaultBranch || null, isDefault ? 1 : 0);
    // Premier repo du registre → forcément défaut.
    if (registry.prepare("SELECT COUNT(*) c FROM repos WHERE is_default = 1").get().c === 0)
      registry.prepare("UPDATE repos SET is_default = 1 WHERE id = ?").run(res.lastInsertRowid);
    return Number(res.lastInsertRowid);
  });
  return getRepo(tx());
}
export function updateRepo(idOrSlug, fields = {}) {
  const row = getRepoRow(idOrSlug);
  if (!row) throw new Error(`Repo introuvable : ${idOrSlug}`);
  const sets = [];
  const vals = [];
  if (fields.name != null) { sets.push("name = ?"); vals.push(String(fields.name)); }
  if ("url" in fields) { sets.push("url = ?"); vals.push(fields.url || null); }
  if ("localPath" in fields) { sets.push("local_path = ?"); vals.push(fields.localPath || null); }
  if ("defaultBranch" in fields) { sets.push("default_branch = ?"); vals.push(fields.defaultBranch || null); }
  if ("hiddenBranches" in fields && Array.isArray(fields.hiddenBranches)) {
    sets.push("hidden_branches = ?");
    vals.push(JSON.stringify([...new Set(fields.hiddenBranches.filter((x) => typeof x === "string" && x.trim()))]));
  }
  const tx = registry.transaction(() => {
    if (sets.length) registry.prepare(`UPDATE repos SET ${sets.join(", ")} WHERE id = ?`).run(...vals, row.id);
    if (fields.isDefault === true) {
      registry.prepare("UPDATE repos SET is_default = 0").run();
      registry.prepare("UPDATE repos SET is_default = 1 WHERE id = ?").run(row.id);
    }
  });
  tx();
  return getRepo(row.id);
}
export function deleteRepo(idOrSlug) {
  const row = getRepoRow(idOrSlug);
  if (!row) return { deleted: false };
  if (registry.prepare("SELECT COUNT(*) c FROM repos").get().c <= 1) throw new Error("Impossible de supprimer le dernier repo");
  const wasDefault = row.is_default;
  registry.prepare("DELETE FROM repos WHERE id = ?").run(row.id);
  if (wasDefault) {
    const n = registry.prepare("SELECT id FROM repos ORDER BY id LIMIT 1").get();
    if (n) registry.prepare("UPDATE repos SET is_default = 1 WHERE id = ?").run(n.id);
  }
  // Les données de tracking de ce dépôt vivent dans SA base tracker.db (plus de
  // cascade FK) : on ferme la connexion et on supprime son magasin (dossier/worktree).
  closeTrackerDb(row.id);
  try {
    removeTrackerStoreFor(row.id, row);
  } catch (e) {
    console.error(`[meowtrack] suppression tracker (repo ${row.id}) : ${e.message || e}`);
  }
  return { deleted: true, id: row.id, slug: row.slug };
}

// ── Branches masquées (par dépôt) ────────────────────────────────────────────
// Liste explicite des branches masquées dans les sélecteurs. La branche de suivi
// est ajoutée par-dessus côté repos.js (toujours cachée, hors de cette liste).
export function getHiddenBranches(idOrSlug) {
  const row = getRepoRow(idOrSlug);
  return row ? parseHiddenBranches(row.hidden_branches) : [];
}
function writeHiddenBranches(row, list) {
  const arr = [...new Set(list.filter((x) => typeof x === "string" && x.trim()))];
  registry.prepare("UPDATE repos SET hidden_branches = ? WHERE id = ?").run(JSON.stringify(arr), row.id);
  return arr;
}
export function hideBranch(idOrSlug, name) {
  const row = getRepoRow(idOrSlug);
  if (!row) throw new Error(`Repo introuvable : ${idOrSlug}`);
  if (!name || !String(name).trim()) throw new Error("Nom de branche requis");
  const list = writeHiddenBranches(row, [...parseHiddenBranches(row.hidden_branches), String(name).trim()]);
  return { repo: row.slug, hiddenBranches: list };
}
export function unhideBranch(idOrSlug, name) {
  const row = getRepoRow(idOrSlug);
  if (!row) throw new Error(`Repo introuvable : ${idOrSlug}`);
  const list = writeHiddenBranches(
    row,
    parseHiddenBranches(row.hidden_branches).filter((b) => b !== String(name).trim())
  );
  return { repo: row.slug, hiddenBranches: list };
}
