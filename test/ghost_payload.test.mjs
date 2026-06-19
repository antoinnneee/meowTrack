// Test de ghostPayloadFromAction : payload de l'aperçu « fantôme » (node:ghost)
// dérivé d'une action add_node, partagé par le chat par nœud et le chat « top level ».
process.env.MEOWTRACK_NO_LISTEN = "1";
const { ghostPayloadFromAction } = await import("../server.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };

// 1. add_node racine (sans parentId) → fantôme racine
let g = ghostPayloadFromAction({ op: "add_node", title: "Objectif", emoji: "🎯" }, "g:1:0");
check("racine: key fallback", g && g.key === "g:1:0");
check("racine: parentId/parentKey null", g.parentId === null && g.parentKey === null);
check("racine: titre/emoji/statut", g.title === "Objectif" && g.emoji === "🎯" && g.status === "active");

// 2. add_node avec tmpKey → key = k:<tmpKey>
g = ghostPayloadFromAction({ op: "add_node", title: "Parent", tmpKey: "a" }, "g:1:1");
check("tmpKey: key = k:a", g.key === "k:a");

// 3. sous-jalon référençant un tmpKey parent → parentKey = k:a
g = ghostPayloadFromAction({ op: "add_node", title: "Enfant", parentId: "a" }, "g:1:2");
check("parent tmpKey: parentKey = k:a", g.parentKey === "k:a" && g.parentId === null);

// 4. sous-jalon avec parentId numérique (nœud réel) → parentId number
g = ghostPayloadFromAction({ op: "add_node", title: "Enfant2", parentId: 42 }, "g:1:3");
check("parent réel: parentId 42", g.parentId === 42 && g.parentKey === null);
g = ghostPayloadFromAction({ op: "add_node", title: "Enfant3", parentId: "42" }, "g:1:4");
check("parent réel (string num): parentId 42", g.parentId === 42 && g.parentKey === null);

// 5. actions non concernées → null (pas de fantôme)
check("update_node → null", ghostPayloadFromAction({ op: "update_node", id: 1, title: "x" }, "k") === null);
check("add_node sans titre → null", ghostPayloadFromAction({ op: "add_node" }, "k") === null);
check("null → null", ghostPayloadFromAction(null, "k") === null);

// 6. statut explicite conservé, troncatures appliquées
g = ghostPayloadFromAction({ op: "add_node", title: "T".repeat(300), status: "done", emoji: "😀😀😀😀😀" }, "k");
check("statut conservé", g.status === "done");
check("titre tronqué 200", g.title.length === 200);
check("emoji tronqué 8", g.emoji.length <= 8);

console.log(`\n${pass} OK, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
