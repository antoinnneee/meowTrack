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
    add_link: "Lien de prérequis",
    remove_link: "Retrait de prérequis",
    add_issue: "Création",
    update_issue: "Mise à jour",
    delete_issue: "Suppression",
    reorder_issues: "Réorganisation",
  };
  // Unité comptée selon le domaine de l'op : « lien », « entrée » (suivi) ou « nœud ».
  const LINK_OPS = new Set(["add_link", "remove_link"]);
  const ISSUE_OPS = new Set(["add_issue", "update_issue", "delete_issue", "reorder_issues"]);
  const unit = (op) => (LINK_OPS.has(op) ? "lien" : ISSUE_OPS.has(op) ? "entrée" : "nœud");
  // Regroupe par (libellé, unité) pour ne pas mélanger « 2 nœuds » et « 1 entrée ».
  const byKey = new Map();
  for (const op of ops) {
    const name = names[op] || "Action";
    const u = unit(op);
    const cur = byKey.get(name + "|" + u) || { name, u, n: 0 };
    cur.n++;
    byKey.set(name + "|" + u, cur);
  }
  const parts = [...byKey.values()].map(({ name, u, n }) => `${name} de ${n} ${u}${n > 1 ? "s" : ""}`);
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
// Échappe les caractères de contrôle bruts (saut de ligne, CR, tab) présents À
// L'INTÉRIEUR des chaînes JSON. Le modèle insère du markdown multi-ligne dans les
// notes (`notes[].body`), produisant de vrais \n non échappés — invalides en JSON,
// ce qui faisait échouer JSON.parse (bug de création de nœuds par le chat IA). On
// respecte l'état de chaîne (les sauts de ligne de mise en forme ENTRE tokens sont
// laissés tels quels), donc on n'invente jamais d'action : reste fail-closed.
function escapeCtrlInStrings(s) {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === "\\") { out += ch; esc = true; continue; }
      if (ch === '"') { out += ch; inStr = false; continue; }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      out += ch;
    } else {
      out += ch;
      if (ch === '"') inStr = true;
    }
  }
  return out;
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
      // On capture DEPUIS l'ouverture ```json jusqu'à la fin du brut (et non fence[1],
      // que tronquerait un ``` imbriqué dans un body markdown) — balancedObject isolera
      // ensuite l'objet équilibré.
      const at = raw.indexOf(fence[0]);
      blob = raw.slice(at);
      text = raw.slice(0, at).trim();
    }
  }
  if (!blob) return { text, actions: [], note: "", malformed: false };
  if (blob.length > 64 * 1024) return { text, actions: [], note: "", malformed: true };

  // Isolement de l'objet JSON via le scanner conscient des chaînes (et non un regex de
  // fence) : il traverse sans broncher les ``` imbriqués ET les sauts de ligne bruts des
  // notes markdown. Tentatives de parsing, de la plus stricte à la plus tolérante :
  // brut → smart-quotes/virgules → \n bruts échappés → les deux combinés.
  const jsonStr = balancedObject(blob);
  if (!jsonStr) return { text, actions: [], note: "", malformed: true };

  let obj =
    tryParse(jsonStr) ||
    tryParse(repairJson(jsonStr)) ||
    tryParse(escapeCtrlInStrings(jsonStr)) ||
    tryParse(repairJson(escapeCtrlInStrings(jsonStr)));
  if (!obj || !Array.isArray(obj.actions)) return { text, actions: [], note: "", malformed: true };
  const note = obj.note ? String(obj.note).slice(0, 500) : "";
  return { text: text || note, actions: obj.actions, note, malformed: false };
}

// Détecte si un tour contient une action destructive (→ proposition + confirmation
// humaine au lieu d'auto-apply). delete_node / delete_issue = destructifs ; statut
// abandoned aussi.
export function describeDestructive(actions, scopeNode, subtreeById) {
  const reasons = [];
  let dels = 0;
  let descTotal = 0;
  let issueDels = 0;
  for (const a of actions || []) {
    if (!a) continue;
    if (a.op === "delete_node") {
      dels++;
      const sub = subtreeById && subtreeById.get(Number(a.id));
      descTotal += sub ? sub : 0;
    } else if (a.op === "delete_issue") {
      issueDels++;
    } else if ((a.op === "set_node_fields" || a.op === "update_node") && a.status === "abandoned") {
      reasons.push("abandon d'un nœud");
    }
  }
  if (dels) reasons.push(`${dels} suppression${dels > 1 ? "s" : ""} de nœud${dels > 1 ? "s" : ""}${descTotal ? ` (+${descTotal} sous-nœud${descTotal > 1 ? "s" : ""})` : ""}`);
  if (issueDels) reasons.push(`${issueDels} suppression${issueDels > 1 ? "s" : ""} d'entrée${issueDels > 1 ? "s" : ""} de suivi`);
  return reasons;
}
