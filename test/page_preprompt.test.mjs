// Test NODE-340 : injection du préprompt de page dans le chat forêt.
//   - resolvePagePreprompt : texte inline prioritaire, sinon corps du template assigné,
//     sinon "" ; pageId null → ""
//   - buildForestPrompt injecte le préprompt HORS bloc UNTRUSTED (comme la politique) ;
//     vide → aucun bloc (rétro-compatible)
// Base isolée : MEOWTRACK_DB pointe vers un fichier temporaire.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "meowtrack-pagepre-"));
process.env.MEOWTRACK_DB = join(TMP, "meowtrack.db");
process.env.MEOWTRACK_NO_LISTEN = "1";

const { createRepo, createPage, updatePage, createTemplate, resolvePagePreprompt } = await import("../db.js");
const { buildForestPrompt } = await import("../ai/prompts.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };

try {
  const repo = createRepo({ slug: "t-pagepre", name: "Test préprompt page", localPath: TMP });
  const rid = repo.id;

  // ── resolvePagePreprompt ────────────────────────────────────────────────────
  check("pageId null → ''", resolvePagePreprompt(null, rid) === "");

  const pInline = createPage(rid, { name: "Inline", preprompt: "Consigne inline de la page." });
  check("préprompt inline résolu", resolvePagePreprompt(pInline.id, rid) === "Consigne inline de la page.");

  const tpl = createTemplate(rid, { name: "T", body: "Corps du template." });
  const pTpl = createPage(rid, { name: "Via template", templateId: tpl.id });
  check("template résolu (pas d'inline)", resolvePagePreprompt(pTpl.id, rid) === "Corps du template.");

  // Inline + template → l'inline (override) gagne.
  const pBoth = createPage(rid, { name: "Both", preprompt: "Override inline.", templateId: tpl.id });
  check("inline prioritaire sur template", resolvePagePreprompt(pBoth.id, rid) === "Override inline.");

  const pEmpty = createPage(rid, { name: "Vide" });
  check("page sans préprompt ni template → ''", resolvePagePreprompt(pEmpty.id, rid) === "");

  // Page dont le préprompt inline est effacé (vide) mais template présent → template.
  updatePage(pInline.id, { preprompt: "", templateId: tpl.id }, rid);
  check("inline vidé → repli sur template", resolvePagePreprompt(pInline.id, rid) === "Corps du template.");

  // ── buildForestPrompt : injection hors UNTRUSTED ───────────────────────────
  const args = [[], [], "bonjour", "moi", null, [], []]; // forestNodes, history, userMsg, author, repo, links, issues
  const withPre = buildForestPrompt(...args, "", "MA CONSIGNE DE PAGE");
  check("le préprompt apparaît dans le prompt", withPre.includes("MA CONSIGNE DE PAGE"));
  check("bloc 'CONSIGNE DE LA PAGE ACTIVE' présent", withPre.includes("CONSIGNE DE LA PAGE ACTIVE"));
  // Hors UNTRUSTED : la consigne doit précéder la VRAIE barrière de données (la ligne
  // exacte "<<<UNTRUSTED>>>" suivie de l'état de la forêt — pas la mention dans les règles).
  check("préprompt AVANT la barrière de données UNTRUSTED (zone de confiance)",
    withPre.indexOf("MA CONSIGNE DE PAGE") < withPre.indexOf("\n<<<UNTRUSTED>>>\n"));

  const noPre = buildForestPrompt(...args, "", "");
  check("préprompt vide → aucun bloc page (rétro-compatible)", !noPre.includes("CONSIGNE DE LA PAGE ACTIVE"));

  console.log(`\n${pass} OK, ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("Erreur de test:", e);
  process.exit(1);
}
