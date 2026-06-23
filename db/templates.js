// db/templates.js — CRUD des TEMPLATES DE PRÉPROMPT nommés (NODE-339).
//
// Du texte de consigne customisable, nommé et réutilisable : on en crée plusieurs,
// on les renomme, on édite le corps, on les supprime. Indépendant du modèle de page ;
// une « page » (autre nœud) pourra référencer un template (injection traitée ailleurs).
// Per-dépôt : une table `chat_templates` par tracker.db, routée par withRepo (patron
// chat_sessions de ./messages.js).

import { db, withRepo } from "./connection.js";
import { clampStr } from "./helpers.js";

const MAX_NAME = 120;
const MAX_BODY = 100000; // ~100 Ko de consigne par template (garde-fou)

function rowToTemplate(r) {
  return r
    ? { id: r.id, name: r.name, body: r.body, createdAt: r.created_at, updatedAt: r.updated_at }
    : null;
}

// Normalise un nom : trim + repli sur « Sans titre » si vide (jamais de nom vide).
function normName(name) {
  return clampStr(String(name || "").trim() || "Sans titre", MAX_NAME);
}

export function listTemplates(repoId = null) {
  return withRepo(repoId, () =>
    db.prepare("SELECT * FROM chat_templates ORDER BY name COLLATE NOCASE, id").all().map(rowToTemplate)
  );
}

export function getTemplate(id, repoId = null) {
  return withRepo(repoId, () => rowToTemplate(db.prepare("SELECT * FROM chat_templates WHERE id = ?").get(Number(id))));
}

export function createTemplate(repoId, { name, body } = {}) {
  return withRepo(repoId, () => {
    const res = db
      .prepare("INSERT INTO chat_templates(name, body) VALUES(?,?)")
      .run(normName(name), clampStr(body || "", MAX_BODY));
    return rowToTemplate(db.prepare("SELECT * FROM chat_templates WHERE id = ?").get(Number(res.lastInsertRowid)));
  });
}

// Mise à jour partielle (name et/ou body) ; touche updated_at dès qu'un champ change.
export function updateTemplate(id, { name, body } = {}, repoId = null) {
  return withRepo(repoId, () => {
    const sets = [];
    const vals = [];
    if (name != null) { sets.push("name = ?"); vals.push(normName(name)); }
    if (body != null) { sets.push("body = ?"); vals.push(clampStr(body, MAX_BODY)); }
    if (sets.length) {
      sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')");
      db.prepare(`UPDATE chat_templates SET ${sets.join(", ")} WHERE id = ?`).run(...vals, Number(id));
    }
    return getTemplate(id, repoId);
  });
}

export function deleteTemplate(id, repoId = null) {
  return withRepo(repoId, () => db.prepare("DELETE FROM chat_templates WHERE id = ?").run(Number(id)).changes);
}
