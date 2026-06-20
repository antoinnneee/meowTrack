// Test de la couche « liens de prérequis » entre nœuds (db/nodes.js) :
// création/listing, anti-auto-lien, anti-cycle, idempotence, cascade à la suppression.
// Base isolée : MEOWTRACK_DB pointe vers un fichier temporaire (trackers sous .trackers/).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "meowtrack-links-"));
process.env.MEOWTRACK_DB = join(TMP, "meowtrack.db");
process.env.MEOWTRACK_NO_LISTEN = "1";

const {
  createRepo,
  createNode,
  getNode,
  updateNode,
  deleteNode,
  addNodeLink,
  removeNodeLink,
  listNodeLinks,
  listForestLinks,
} = await import("../db.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

try {
  const repo = createRepo({ slug: "t-links", name: "Test liens", localPath: TMP });
  const rid = repo.id;

  // 3 objectifs racines : réseau (prérequis partagé), chat, multi.
  const reseau = createNode(rid, null, { title: "Brique réseau" });
  const chat = createNode(rid, null, { title: "Chat" });
  const multi = createNode(rid, null, { title: "Multijoueur" });

  // chat dépend de réseau, multi dépend de réseau.
  const r1 = addNodeLink(chat.id, reseau.id, { repoId: rid });
  const r2 = addNodeLink(multi.id, reseau.id, { repoId: rid });
  check("addNodeLink crée le lien", r1.link.created === true && r1.fromId === chat.id && r1.toId === reseau.id);
  check("2e lien créé", r2.link.created === true);

  // Listing forêt : 2 liens.
  const all = listForestLinks(rid);
  check("listForestLinks = 2", all.length === 2 && all.every((l) => l.kind === "requires" && l.toId === reseau.id));

  // Du point de vue de réseau : requis par chat + multi, ne dépend de rien.
  const lr = listNodeLinks(reseau.id, rid);
  check("réseau.requiredBy = [chat, multi]", lr.requiredBy.length === 2 && lr.requires.length === 0);
  check("réseau.requiredBy contient les bons ids", new Set(lr.requiredBy.map((x) => x.id)).has(chat.id) && new Set(lr.requiredBy.map((x) => x.id)).has(multi.id));

  // Du point de vue de chat : dépend de réseau.
  const lc = listNodeLinks(chat.id, rid);
  check("chat.requires = [réseau]", lc.requires.length === 1 && lc.requires[0].id === reseau.id);
  check("chat.requiredBy vide", lc.requiredBy.length === 0);

  // getNode(withLinks) expose requires/requiredBy.
  const cn = getNode(chat.id, { repoId: rid, withLinks: true });
  check("getNode withLinks → requires", Array.isArray(cn.requires) && cn.requires[0].id === reseau.id);

  // Auto-lien interdit.
  check("auto-lien refusé", throws(() => addNodeLink(chat.id, chat.id, { repoId: rid })));

  // Cycle interdit : réseau ne peut pas dépendre de chat (chat dépend déjà de réseau).
  check("cycle refusé", throws(() => addNodeLink(reseau.id, chat.id, { repoId: rid })));

  // Idempotence : re-créer chat→réseau ne duplique pas.
  const dup = addNodeLink(chat.id, reseau.id, { repoId: rid });
  check("lien idempotent (created=false)", dup.link.created === false && listForestLinks(rid).length === 2);

  // Le statut « done » du prérequis se reflète dans le résumé.
  updateNode(reseau.id, { status: "done" }, undefined, rid);
  const lc2 = listNodeLinks(chat.id, rid);
  check("résumé reflète le statut done", lc2.requires[0].status === "done");

  // Retrait explicite d'un lien.
  const rm = removeNodeLink(multi.id, reseau.id, { repoId: rid });
  check("removeNodeLink retire", rm.removed === true && listForestLinks(rid).length === 1);

  // Cascade : supprimer réseau purge le lien restant (chat→réseau).
  deleteNode(reseau.id, rid);
  check("cascade : liens purgés", listForestLinks(rid).length === 0);
  check("chat sans prérequis après cascade", listNodeLinks(chat.id, rid).requires.length === 0);

  console.log(`\n${pass} OK, ${fail} échec(s)`);
} finally {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(fail ? 1 : 0);
