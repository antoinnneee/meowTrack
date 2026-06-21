// Test du statut `waiting` (en attente d'info utilisateur) + champ `pending_info` :
// - set status=waiting + pendingInfo via updateNode → exposé par getNode
// - sortie de waiting (→ active) efface automatiquement pending_info
// - une nouvelle valeur pendingInfo fournie en même temps que la sortie est respectée
// - l'orchestrateur ne réclame PAS un nœud waiting (claimNextNode exige status='active')
// - l'action de chat set_node_fields peut poser/lever l'attente
// Base isolée : MEOWTRACK_DB pointe vers un fichier temporaire (trackers sous .trackers/).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "meowtrack-waiting-"));
process.env.MEOWTRACK_DB = join(TMP, "meowtrack.db");
process.env.MEOWTRACK_NO_LISTEN = "1";

const { createRepo, createNode, getNode, updateNode, applyNodeActions, claimNextNode } = await import("../db.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };

try {
  const repo = createRepo({ slug: "t-waiting", name: "Test attente", localPath: TMP });
  const rid = repo.id;

  const node = createNode(rid, null, { title: "Intégration Stripe" });
  check("nœud créé status=active", node.status === "active" && node.pendingInfo === null);

  // Mise en attente d'info utilisateur.
  let n = updateNode(node.id, { status: "waiting", pendingInfo: "Il manque la clé API Stripe et l'URL du webhook." }, undefined, rid);
  check("status passé à waiting", n.status === "waiting");
  check("pendingInfo stocké", n.pendingInfo === "Il manque la clé API Stripe et l'URL du webhook.");

  // getNode relit fidèlement.
  n = getNode(node.id, { repoId: rid });
  check("getNode expose pendingInfo", n.pendingInfo && n.status === "waiting");

  // L'orchestrateur ignore un nœud waiting (feuille, mais status != active).
  const claimed = claimNextNode(rid, "worker-test");
  check("claimNextNode ignore un nœud waiting", claimed === null);

  // Sortie de waiting → active : pending_info effacé automatiquement.
  n = updateNode(node.id, { status: "active" }, undefined, rid);
  check("retour active", n.status === "active");
  check("pendingInfo effacé en quittant waiting", n.pendingInfo === null);

  // L'orchestrateur peut maintenant réclamer le nœud (active, feuille, pas de prérequis).
  const claimed2 = claimNextNode(rid, "worker-test");
  check("claimNextNode réclame le nœud redevenu active", claimed2 != null && claimed2.id === node.id);

  // Une valeur pendingInfo fournie EN MÊME TEMPS que la sortie de waiting est respectée
  // (pas écrasée par l'effacement automatique).
  const n2nd = createNode(rid, null, { title: "Autre" });
  updateNode(n2nd.id, { status: "waiting", pendingInfo: "manque X" }, undefined, rid);
  let m = updateNode(n2nd.id, { status: "paused", pendingInfo: "nouvelle note" }, undefined, rid);
  check("pendingInfo explicite préservé en quittant waiting", m.pendingInfo === "nouvelle note");

  // Action de chat : set_node_fields peut poser l'attente sur le nœud courant.
  const cur = createNode(rid, null, { title: "Paiement" });
  const res = applyNodeActions(cur.id, [{ op: "set_node_fields", status: "waiting", pendingInfo: "config Paypal manquante" }], rid);
  check("action set_node_fields applique waiting", res.applied.length === 1);
  m = getNode(cur.id, { repoId: rid });
  check("nœud en attente via action de chat", m.status === "waiting" && m.pendingInfo === "config Paypal manquante");

  // Statut invalide toujours rejeté (le set fermé n'est pas élargi par erreur).
  let threw = false;
  try { updateNode(cur.id, { status: "bogus" }, undefined, rid); } catch { threw = true; }
  check("statut invalide rejeté", threw);

  console.log(`\n${pass} OK, ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("Erreur de test:", e);
  process.exit(1);
}
