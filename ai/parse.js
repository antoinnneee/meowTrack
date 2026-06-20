// ai/parse.js — séparation fail-closed du texte conversationnel et des actions
// structurées renvoyées par `claude -p`. Module FEUILLE (aucune dépendance), cœur
// de sécurité verrouillé par test/parse_ai_turn.test.mjs + ghost_payload.test.mjs.
//
// Au moindre doute : zéro action, texte affiché tel quel — jamais de mutation devinée.

// Sentinelle marquant le début du bloc d'actions dans la sortie IA. Émise par les
// prompts (ai/prompts.js), détectée ici et pendant le streaming (ai/turns.js).
export const ACTIONS_SENTINEL = "<<<MEOWTRACK_ACTIONS>>>";
export const MAX_ACTIONS_CAP = 200;

// Construit le payload `node:ghost` d'une action `add_node` (ou null sinon). Partagé
// par le chat par nœud ET le chat « top level ». `fallbackKey` sert quand l'action
// n'a pas de tmpKey. `parentId` = id réel d'un parent ; `parentKey` = réf à un autre
// fantôme (tmpKey) → permet de nicher les sous-jalons dans l'aperçu. Exporté pour test.
export function ghostPayloadFromAction(a, fallbackKey) {
  if (!a || a.op !== "add_node" || !a.title) return null;
  const pidNum = a.parentId != null && Number.isFinite(Number(a.parentId)) ? Number(a.parentId) : null;
  const pidKey = a.parentId != null && pidNum == null ? "k:" + String(a.parentId) : null;
  return {
    key: a.tmpKey != null ? "k:" + String(a.tmpKey) : fallbackKey,
    title: String(a.title).slice(0, 200),
    emoji: a.emoji ? String(a.emoji).slice(0, 8) : "",
    status: typeof a.status === "string" ? a.status : "active",
    parentId: pidNum,
    parentKey: pidKey,
  };
}

// Extrait les objets d'action COMPLETS (équilibrés) du tableau "actions" d'un blob
// JSON potentiellement partiel (streaming). Ignore le dernier objet s'il n'est pas
// encore refermé. Best-effort : tente une réparation légère, saute les illisibles.
export function parseActionObjects(blob) {
  const ai = blob.indexOf('"actions"');
  if (ai < 0) return [];
  const lb = blob.indexOf("[", ai);
  if (lb < 0) return [];
  const out = [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let start = -1;
  for (let i = lb + 1; i < blob.length; i++) {
    const ch = blob[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        const frag = blob.slice(start, i + 1);
        const obj = tryParse(frag) || tryParse(repairJson(frag));
        if (obj) out.push(obj);
        start = -1;
      }
    } else if (ch === "]" && depth === 0) {
      break; // fin du tableau actions
    }
  }
  return out;
}

// Libellé court décrivant le bloc d'actions en cours de rédaction par l'IA,
// affiché à la place du JSON brut pendant le streaming.
export function actionStatusLabel(ops) {
  if (!ops || !ops.length) return "⚙️ Préparation des actions…";
  const names = {
    add_node: "Création",
    update_node: "Mise à jour",
    set_node_fields: "Mise à jour",
    delete_node: "Suppression",
    move_node: "Déplacement",
    reorder_children: "Réorganisation",
  };
  const byName = new Map();
  for (const op of ops) {
    const name = names[op] || "Action";
    byName.set(name, (byName.get(name) || 0) + 1);
  }
  const parts = [...byName].map(([name, n]) => `${name} de ${n} nœud${n > 1 ? "s" : ""}`);
  return "⚙️ " + parts.join(" · ") + " en cours…";
}

function tryParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function repairJson(s) {
  return String(s)
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, "$1");
}
// Extrait le 1er objet { … } équilibré (en respectant les chaînes JSON).
function balancedObject(s) {
  const start = s.indexOf("{");
  if (start < 0) return "";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return "";
}

// Sépare le texte conversationnel des actions. Fail-closed : au moindre doute,
// actions=[] et on affiche le texte tel quel (jamais de mutation devinée).
// Exporté pour les tests isolés (cf. test/parse_ai_turn.test.mjs).
export function parseAiTurn(stdout) {
  const raw = String(stdout || "");
  let text = raw.trim();
  let blob = "";
  const idx = raw.indexOf(ACTIONS_SENTINEL);
  if (idx >= 0) {
    text = raw.slice(0, idx).trim();
    blob = raw.slice(idx + ACTIONS_SENTINEL.length);
  } else {
    // Pas de sentinelle : on n'accepte un bloc que s'il est explicitement ```json
    // ET contient "actions" (anti faux-positif : jamais d'action devinée en prose).
    const fence = raw.match(/```json\s*([\s\S]*?)```/i);
    if (fence && /"actions"\s*:/.test(fence[1])) {
      blob = fence[1];
      text = raw.replace(fence[0], "").trim();
    }
  }
  if (!blob) return { text, actions: [], note: "", malformed: false };
  if (blob.length > 64 * 1024) return { text, actions: [], note: "", malformed: true };

  const fence = blob.match(/```json\s*([\s\S]*?)```/i) || blob.match(/```\s*([\s\S]*?)```/);
  const jsonStr = fence ? fence[1] : balancedObject(blob);
  if (!jsonStr) return { text, actions: [], note: "", malformed: true };

  let obj = tryParse(jsonStr) || tryParse(repairJson(jsonStr));
  if (!obj || !Array.isArray(obj.actions)) return { text, actions: [], note: "", malformed: true };
  const note = obj.note ? String(obj.note).slice(0, 500) : "";
  return { text: text || note, actions: obj.actions, note, malformed: false };
}

// Détecte si un tour contient une action destructive (→ proposition + confirmation
// humaine au lieu d'auto-apply). delete_node = destructif ; status abandoned aussi.
export function describeDestructive(actions, scopeNode, subtreeById) {
  const reasons = [];
  let dels = 0;
  let descTotal = 0;
  for (const a of actions || []) {
    if (!a) continue;
    if (a.op === "delete_node") {
      dels++;
      const sub = subtreeById && subtreeById.get(Number(a.id));
      descTotal += sub ? sub : 0;
    } else if ((a.op === "set_node_fields" || a.op === "update_node") && a.status === "abandoned") {
      reasons.push("abandon d'un nœud");
    }
  }
  if (dels) reasons.push(`${dels} suppression${dels > 1 ? "s" : ""} de nœud${dels > 1 ? "s" : ""}${descTotal ? ` (+${descTotal} sous-nœud${descTotal > 1 ? "s" : ""})` : ""}`);
  return reasons;
}
