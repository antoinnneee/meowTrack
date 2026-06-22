// Test du NODE D'ACTIVATION (kind='activation') : porte de prérequis manuelle.
// - création via createNode(kind:'activation') → kind exposé, emoji ⚡ par défaut
// - un nœud qui REQUIERT le node d'activation est bloqué tant qu'il n'est pas 'done'
// - « activer » (status='done') débloque le dépendant ; « désactiver » le rebloque
// - l'orchestrateur ne réclame JAMAIS un node d'activation (exclu par kind), même
//   quand il est une feuille active
// - création/activation via les actions de chat (applyForestActions) + conversion kind
// - kind invalide rejeté (catalogue fermé)
// Base isolée : MEOWTRACK_DB pointe vers un fichier temporaire (trackers sous .trackers/).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "meowtrack-activation-"));
process.env.MEOWTRACK_DB = join(TMP, "meowtrack.db");
process.env.MEOWTRACK_NO_LISTEN = "1";

const { createRepo, createNode, getNode, updateNode, addNodeLink, applyForestActions, claimNextNode } = await import("../db.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };

try {
  const repo = createRepo({ slug: "t-activation", name: "Test activation", localPath: TMP });
  const rid = repo.id;

  // 1) Création d'un node d'activation (OFF par défaut = status active, pas encore activé).
  const gate = createNode(rid, null, { title: "Setup environnement", kind: "activation" });
  check("kind='activation' à la création", gate.kind === "activation");
  check("emoji ⚡ par défaut", gate.emoji === "⚡");
  check("OFF par défaut (status active != done)", gate.status === "active");

  // 2) Un nœud dépendant qui REQUIERT la porte (from=dépendant, to=node d'activation).
  const dep = createNode(rid, null, { title: "Déployer" });
  addNodeLink(dep.id, gate.id, { repoId: rid });
  let d = getNode(dep.id, { repoId: rid, withLinks: true });
  check("dépendant a 1 prérequis (la porte)", d.requires.length === 1 && d.requires[0].id === gate.id);
  check("prérequis NON satisfait tant que la porte est OFF", d.requires[0].status !== "done");

  // 3) L'orchestrateur ne réclame PAS la porte (feuille active mais kind='activation'),
  //    ET ne réclame pas le dépendant (bloqué par prérequis non satisfait).
  const claimedOff = claimNextNode(rid, "worker-test");
  check("orchestrateur ignore la porte + le dépendant bloqué", claimedOff === null);

  // 4) Activation : status='done' → débloque la séquence.
  let g = updateNode(gate.id, { status: "done" }, undefined, rid);
  check("porte activée (status done)", g.status === "done");
  d = getNode(dep.id, { repoId: rid, withLinks: true });
  check("prérequis satisfait une fois activée", d.requires[0].status === "done");

  // 5) Désormais l'orchestrateur peut réclamer le DÉPENDANT (pas la porte).
  const claimedOn = claimNextNode(rid, "worker-test");
  check("orchestrateur réclame le dépendant débloqué", claimedOn != null && claimedOn.id === dep.id);

  // 6) Désactivation : retour à active → rebloque.
  g = updateNode(gate.id, { status: "active" }, undefined, rid);
  d = getNode(dep.id, { repoId: rid, withLinks: true });
  check("désactivation rebloque le dépendant", d.requires[0].status !== "done");

  // 7) Conversion d'un nœud normal en node d'activation.
  const normal = createNode(rid, null, { title: "À convertir" });
  let c = updateNode(normal.id, { kind: "activation" }, undefined, rid);
  check("conversion normal → activation", c.kind === "activation");

  // 8) Création + activation via les actions de chat (forêt). add_node kind=activation.
  const res = applyForestActions(rid, [
    { op: "add_node", title: "Porte IA", kind: "activation", tmpKey: "g1" },
  ]);
  check("action add_node kind=activation appliquée", res.applied.length === 1);
  const created = getNode(res.applied[0].id, { repoId: rid });
  check("node d'activation créé par l'IA", created.kind === "activation" && created.emoji === "⚡");

  // 9) kind invalide rejeté (set fermé).
  let threw = false;
  try { updateNode(normal.id, { kind: "bogus" }, undefined, rid); } catch { threw = true; }
  check("kind invalide rejeté", threw);

  console.log(`\n${pass} OK, ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("Erreur de test:", e);
  process.exit(1);
}
