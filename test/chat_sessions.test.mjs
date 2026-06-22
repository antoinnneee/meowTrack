// Test des sessions de conversation multiples (NODE-279) :
// - session par défaut (session_id NULL) isolée des sessions nommées
// - création/renommage/suppression d'une session
// - addNodeMessage / listNodeMessages scopés par sessionId
// - clearNodeMessages ne vide QUE la session ciblée
// - deleteChatSession purge les messages de la session (et borne au propriétaire)
// - même comportement côté forêt (addForestMessage / listForestMessages)
// Base isolée : MEOWTRACK_DB pointe vers un fichier temporaire (trackers sous .trackers/).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "meowtrack-sessions-"));
process.env.MEOWTRACK_DB = join(TMP, "meowtrack.db");
process.env.MEOWTRACK_NO_LISTEN = "1";

const {
  createRepo, createNode,
  addNodeMessage, listNodeMessages, clearNodeMessages,
  addForestMessage, listForestMessages,
  listChatSessions, createChatSession, renameChatSession, deleteChatSession, getChatSession,
} = await import("../db.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };

try {
  const repo = createRepo({ slug: "t-sessions", name: "Test sessions", localPath: TMP });
  const rid = repo.id;
  const node = createNode(rid, null, { title: "Sujet" });

  // Session par défaut (sessionId omis → 0 → session_id NULL).
  addNodeMessage(node.id, { role: "user", body: "msg défaut" }, rid);
  check("message en session par défaut", listNodeMessages(node.id, { repoId: rid }).length === 1);
  check("sessionId par défaut = 0", listNodeMessages(node.id, { repoId: rid })[0].sessionId === 0);

  // Création d'une session nommée.
  const s1 = createChatSession("node", node.id, "Idées", rid);
  check("session créée avec id positif", s1 && s1.id > 0 && s1.name === "Idées");
  check("listChatSessions renvoie la session", listChatSessions("node", node.id, rid).some((s) => s.id === s1.id));

  // Messages dans la session nommée : isolés de la défaut.
  addNodeMessage(node.id, { role: "user", body: "msg s1 a", sessionId: s1.id }, rid);
  addNodeMessage(node.id, { role: "assistant", body: "msg s1 b", sessionId: s1.id }, rid);
  check("session nommée a ses 2 messages", listNodeMessages(node.id, { repoId: rid, sessionId: s1.id }).length === 2);
  check("session par défaut inchangée (1 msg)", listNodeMessages(node.id, { repoId: rid }).length === 1);
  check("messages portent le bon sessionId", listNodeMessages(node.id, { repoId: rid, sessionId: s1.id }).every((m) => m.sessionId === s1.id));

  // clearNodeMessages ne vide QUE la session ciblée.
  clearNodeMessages(node.id, rid, s1.id);
  check("clear session nommée vidée", listNodeMessages(node.id, { repoId: rid, sessionId: s1.id }).length === 0);
  check("clear n'a pas touché la défaut", listNodeMessages(node.id, { repoId: rid }).length === 1);

  // Renommage.
  const r1 = renameChatSession(s1.id, "Brainstorm", rid);
  check("renommage appliqué", r1.name === "Brainstorm" && getChatSession(s1.id, rid).name === "Brainstorm");

  // Suppression : purge les messages de la session + retire la ligne.
  addNodeMessage(node.id, { role: "user", body: "à purger", sessionId: s1.id }, rid);
  const removed = deleteChatSession(s1.id, "node", node.id, rid);
  check("deleteChatSession retourne >0", removed > 0);
  check("session disparue de la liste", !listChatSessions("node", node.id, rid).some((s) => s.id === s1.id));
  check("messages de la session purgés", listNodeMessages(node.id, { repoId: rid, sessionId: s1.id }).length === 0);
  check("session par défaut toujours intacte", listNodeMessages(node.id, { repoId: rid }).length === 1);

  // deleteChatSession borné au propriétaire : un mauvais ownerId ne supprime rien.
  const s2 = createChatSession("node", node.id, "Autre", rid);
  const otherNode = createNode(rid, null, { title: "Autre nœud" });
  const removedWrong = deleteChatSession(s2.id, "node", otherNode.id, rid);
  check("suppression hors propriétaire = 0", removedWrong === 0);
  check("session toujours présente après tentative hors scope", listChatSessions("node", node.id, rid).some((s) => s.id === s2.id));

  // Côté forêt : sessions par repo.
  const fs1 = createChatSession("forest", rid, "Vision", rid);
  addForestMessage(rid, { role: "user", body: "forêt défaut" });
  addForestMessage(rid, { role: "user", body: "forêt s1", sessionId: fs1.id });
  check("forêt : défaut isolée", listForestMessages(rid, { sessionId: 0 }).length === 1);
  check("forêt : session nommée isolée", listForestMessages(rid, { sessionId: fs1.id }).length === 1);
  check("forêt : message session porte sessionId", listForestMessages(rid, { sessionId: fs1.id })[0].sessionId === fs1.id);

  console.log(`\n${pass} OK, ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("Erreur de test:", e);
  process.exit(1);
}
