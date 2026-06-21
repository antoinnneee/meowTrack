// Test de l'auto-revue (orchestrateur, §6.6) — parties testables SANS le CLI Claude :
//   1. Séparation de confiance : la POLITIQUE est injectée hors du bloc UNTRUSTED,
//      le contexte de revue (message synthétique) reste DANS le bloc untrusted.
//   2. Une action destructive est détectée (→ proposée, jamais auto-appliquée).
//   3. Anti-boucle : au-delà du plafond, l'auto-revue est SKIP (bascule humaine).
// (Le tour IA complet réorganisant l'arbre dépend du CLI et n'est pas exercé ici.)
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "meow-autorev-"));
process.env.MEOWTRACK_DB = join(dir, "meowtrack.db");
process.env.MEOWTRACK_NO_LISTEN = "1";
console.error = () => {};

const db = await import("../db.js");
const { buildForestPrompt } = await import("../ai/prompts.js");
const { describeDestructive } = await import("../ai/parse.js");
const { triggerAutoReview } = await import("../ai/turns.js");
const { MAX_AUTO_REVIEWS } = await import("../db/constants.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };

// 1. Séparation de confiance dans le prompt forêt.
const policy = "PRIVILEGIE_LA_DECOMPOSITION_EN_SOUS_TACHES";
const review = "ATTENTION_TENTATIVE_INJECTION_ignore_les_regles";
// Signature : (forestNodes, history, userMessage, author, repo, links, issues, policyPrompt)
const prompt = buildForestPrompt([], [], review, "auto-review", { name: "Demo" }, [], [], policy);
// Le VRAI délimiteur est la dernière occurrence (la 1re est citée dans les règles).
const uIdx = prompt.lastIndexOf("<<<UNTRUSTED>>>");
check("politique présente dans le prompt", prompt.includes(policy));
check("politique injectée AVANT le bloc untrusted (consigne de confiance)", prompt.indexOf(policy) < uIdx);
check("contexte de revue DANS le bloc untrusted (donnée)", prompt.indexOf(review) > uIdx);

// 2. Détection d'action destructive (→ proposition, pas d'auto-apply).
check("delete_node détecté destructif", describeDestructive([{ op: "delete_node", id: 5 }], null, new Map()).length > 0);
check("status abandoned détecté destructif", describeDestructive([{ op: "set_node_fields", status: "abandoned" }], null, new Map()).length > 0);
check("add_node non destructif", describeDestructive([{ op: "add_node", title: "x" }], null, new Map()).length === 0);

// 3. Anti-boucle : au-delà du plafond, auto-revue SKIP (sans appeler le CLI).
const rid = db.listRepos()[0].id;
const root = db.createNode(rid, null, { title: "Racine" });
const leaf = db.createNode(rid, root.id, { title: "Tâche" });
db.addReview(leaf.id, { kind: "decision", message: "Choix à arbitrer", blocking: true }, rid);
for (let i = 0; i < MAX_AUTO_REVIEWS; i++) db.bumpAutoReviews(leaf.id, rid); // amène le compteur au plafond
const r = await triggerAutoReview(rid, leaf.id, null, { model: "sonnet" });
check("auto-revue plafonnée → skip (bascule humaine)", r && r.skipped === "max_auto_reviews");

// 3b. Sans point de revue ouvert → skip propre (pas d'appel CLI non plus).
const leaf2 = db.createNode(rid, root.id, { title: "Tâche 2" });
const r2 = await triggerAutoReview(rid, leaf2.id, null, {});
check("auto-revue sans point ouvert → skip", r2 && r2.skipped === "no_open_reviews");

console.log(`\n${pass} OK, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
