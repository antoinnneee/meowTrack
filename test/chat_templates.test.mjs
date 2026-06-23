// Test NODE-339 : CRUD des TEMPLATES DE PRÉPROMPT nommés (db/templates.js).
//   - createTemplate appende (nom + corps), getTemplate / listTemplates relisent
//   - liste triée par nom (insensible casse)
//   - updateTemplate partiel (name seul, body seul) + bascule updated_at
//   - nom vide → « Sans titre » (jamais de nom vide)
//   - deleteTemplate retire et devient introuvable
//   - cloisonnement par dépôt (un template d'un repo n'apparaît pas dans l'autre)
// Base isolée : MEOWTRACK_DB pointe vers un fichier temporaire (trackers sous .trackers/).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "meowtrack-tpl-"));
process.env.MEOWTRACK_DB = join(TMP, "meowtrack.db");
process.env.MEOWTRACK_NO_LISTEN = "1";

const { createRepo, listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate } = await import("../db.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };

try {
  const repo = createRepo({ slug: "t-tpl", name: "Test templates", localPath: TMP });
  const rid = repo.id;
  const other = createRepo({ slug: "t-tpl2", name: "Autre", localPath: join(TMP, "o") });
  const oid = other.id;

  // ── Création + relecture ────────────────────────────────────────────────────
  check("liste vide au départ", listTemplates(rid).length === 0);
  const t1 = createTemplate(rid, { name: "Revue", body: "Tu es un relecteur strict." });
  check("createTemplate renvoie id + champs", t1.id > 0 && t1.name === "Revue" && t1.body === "Tu es un relecteur strict.");
  check("getTemplate relit", getTemplate(t1.id, rid).body === "Tu es un relecteur strict.");

  const t2 = createTemplate(rid, { name: "Analyse", body: "Décris le code." });
  const t3 = createTemplate(rid, { name: "brainstorm", body: "Propose des idées." });
  check("listTemplates renvoie les 3", listTemplates(rid).length === 3);
  // Tri par nom insensible à la casse : Analyse, brainstorm, Revue.
  check("tri par nom (NOCASE)", listTemplates(rid).map((t) => t.name).join(",") === "Analyse,brainstorm,Revue");

  // ── Mise à jour partielle ───────────────────────────────────────────────────
  const before = getTemplate(t1.id, rid).updatedAt;
  const r1 = updateTemplate(t1.id, { name: "Revue stricte" }, rid);
  check("update name seul (body conservé)", r1.name === "Revue stricte" && r1.body === "Tu es un relecteur strict.");
  const r2 = updateTemplate(t1.id, { body: "Nouveau corps." }, rid);
  check("update body seul (name conservé)", r2.name === "Revue stricte" && r2.body === "Nouveau corps.");
  check("updated_at présent après update", typeof r2.updatedAt === "string" && r2.updatedAt.length >= 10);

  // ── Nom vide → « Sans titre » ───────────────────────────────────────────────
  const tEmpty = createTemplate(rid, { name: "   ", body: "" });
  check("nom vide → « Sans titre »", tEmpty.name === "Sans titre");
  const rEmpty = updateTemplate(tEmpty.id, { name: "" }, rid);
  check("update nom vide → « Sans titre »", rEmpty.name === "Sans titre");

  // ── Suppression ─────────────────────────────────────────────────────────────
  check("deleteTemplate retire 1 ligne", deleteTemplate(t2.id, rid) === 1);
  check("introuvable après suppression", getTemplate(t2.id, rid) === null);
  check("delete d'un id absent → 0", deleteTemplate(99999, rid) === 0);

  // ── Cloisonnement par dépôt ─────────────────────────────────────────────────
  createTemplate(oid, { name: "Autre repo", body: "x" });
  check("template de l'autre repo isolé", listTemplates(oid).length === 1 && listTemplates(oid)[0].name === "Autre repo");
  check("le repo d'origine ne voit pas celui de l'autre", !listTemplates(rid).some((t) => t.name === "Autre repo"));

  console.log(`\n${pass} OK, ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("Erreur de test:", e);
  process.exit(1);
}
