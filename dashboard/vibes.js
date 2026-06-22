// vibes.js — bloc « Vibes » : arbre de nœuds, graphe SVG organique, vue détail
// + chat IA streaming (SSE). Exporte aussi toast / showCtxMenu (réutilisés par le
// gestionnaire de dépôts) et les ponts openVibes / initVibes.

import { $, esc, api, getToken, injectRepo } from "./core.js";
import { state, handleMentionInput, handleChatMention, menuKeydown, hideMenu, createIssueFromNode, openIssueInTrack } from "./issues.js";
import { openRepoView, initRepo } from "./repo.js";

// ═══════════════════════════════════════════════════════════════════════════
// Vibes v2 — arbre de NŒUDS récursif, graphe organique, chat IA streaming.
// Réutilise les helpers du Suivi ($/esc/api/getToken). N'altère PAS init().
// ═══════════════════════════════════════════════════════════════════════════

const NODE_STATUS_LABEL = { active: "🌱 Actif", paused: "⏸️ En pause", waiting: "⏳ En attente d'info", done: "🏆 Atteint", abandoned: "🪦 Abandonné" };
const NODE_COLORS = ["accent", "feature", "task", "bug", "high"];

// Palette « par cascade » : chaque sous-arbre de 1er niveau (tête de cascade =
// nœud de profondeur 1) reçoit une teinte distincte, héritée par ses descendants.
// Couleurs vives lisibles sur le thème sombre. Les nœuds de structure (profondeur 0
// : N0 + légendes) restent neutres pour faire ressortir les cascades.
const CASCADE_PALETTE = ["#4dabf7", "#69db7c", "#ffd43b", "#ff8787", "#da77f2", "#ffa94d", "#3bc9db", "#a9e34b", "#f783ac", "#9775fa"];
const CASCADE_NEUTRAL = "#868e96";

export const vibes = {
  view: "track",
  // graph | grid — grille par défaut sur petit écran (le graphe se manipule à la souris).
  layout: localStorage.getItem("meowtrack_layout") || (typeof window !== "undefined" && window.innerWidth <= 768 ? "grid" : "graph"),
  es: null,
  current: null, // ref du nœud ouvert (détail)
  currentNode: null,
  currentVersion: null,
  forest: [],
  byId: new Map(),
  links: [],            // liens de prérequis du repo : [{ id, fromId, toId, kind }]
  reqByFrom: new Map(), // fromId → Set(toId) (dérivé de links, pour le calcul « bloqué »)
  seen: new Set(), // ids de messages rendus
  streams: new Map(), // turnId → { reasoning, text, reasoningEl, bodyEl }
  dirtyTimer: null,
  forestTimer: null,
  model: "sonnet",
  user: "",
  // Chat « top level » épinglé sur toute la colonne de droite (vue graphe/grille).
  pinned: localStorage.getItem("meowtrack_forest_pin") === "1",
  // Chat « top level » en plein écran (transitoire, non persisté).
  fullscreen: false,
  wasDown: false,
  stickToBottom: true, // chat : suivre le bas tant que l'utilisateur n'a pas scrollé vers le haut
  _editing: null,
  _color: "accent",
  // Effets « waouh » sur l'arbre détail : signature des nœuds au rendu précédent
  // (diff → fx-new / fx-changed / fx-done) et drapeau « premier rendu = cascade ».
  _treeSnap: new Map(),
  _treeInitial: true,
  _fxClear: null,
  _ghostKids: [], // sous-nœuds « fantômes » (non persistés) pendant un tour IA en cours (vue détail)
  _ghostNodes: [], // nœuds « fantômes » du chat « top level » (graphe/grille) pendant un tour IA
  _notesEditing: false, // éditeur de notes markdown ouvert (ne pas écraser par les maj live)
  // spawned/pulsed/celebrated : ids de nœuds à animer au prochain rendu (créés /
  // mis à jour / venant d'atteindre « done »). fxFired : éclats déjà tirés (anti-doublon
  // si la forêt re-rend plusieurs fois dans la fenêtre d'animation).
  graph: {
    view: { x: 0, y: 0, w: 1000, h: 700 }, drag: null, userView: false,
    spawned: new Set(), pulsed: new Set(), celebrated: new Set(), fxFired: new Set(),
    despawning: new Set(), // ids en cours d'anim de suppression (encore dans les données, flétris au rendu)
    posMap: new Map(),      // id → {x,y} résolu au dernier rendu (drag live + arêtes)
    nodeDrag: null,         // déplacement d'un nœud (et de son sous-arbre) en cours
    linking: null,          // id source pendant « tirer un lien »
    linkKind: "child",      // type de lien en cours de tracé : 'child' (reparente) | 'requires' (prérequis)
    edgeDel: null,          // { childId, parentId } de l'arête dont la poubelle est affichée
    reqDel: null,           // { fromId, toId } du prérequis dont la poubelle est affichée
    pendingCreatePos: null, // position graphe où créer le prochain nœud (menu fond)
    suppressClick: false,   // ignore le prochain click (après un drag)
    hiddenStatuses: new Set(), // statuts masqués par les filtres (done/abandoned/paused)
  },
};

// ── Contexte de chat actif (nœud vs « top level » / forêt) ───────────────────
// Le rendu, le streaming et l'envoi sont mutualisés : un seul chat est actif à la
// fois (les vues sont exclusives, le flux SSE est unique). `vibes.chat` pointe vers
// la config courante : sélecteurs DOM + constructeur d'URL d'API.
const NODE_CHAT_CTX = {
  kind: "node",
  feedSel: "#chatFeed",
  inputSel: "#chatInput",
  stopSel: "#chatStopBtn",
  sessionSel: "#nodeSessionSel",
  renameSel: "#nodeSessionRename",
  delSel: "#nodeSessionDel",
  sessionId: 0, // 0 = conversation par défaut (session_id NULL)
  emptyHtml: '<div class="empty">Discute de ce nœud : décris-le, demande des sous-jalons…</div>',
  url: (sub) => `/api/nodes/${encodeURIComponent(vibes.current)}${sub || ""}`,
  ready: () => !!vibes.current,
};
const FOREST_CHAT_CTX = {
  kind: "forest",
  feedSel: "#forestChatFeed",
  inputSel: "#forestChatInput",
  stopSel: "#forestChatStopBtn",
  sessionSel: "#forestSessionSel",
  renameSel: "#forestSessionRename",
  delSel: "#forestSessionDel",
  sessionId: 0,
  emptyHtml: '<div class="empty">Discute de tes objectifs au plus haut niveau : décris une ambition, demande à créer des objectifs racines…</div>',
  url: (sub) => `/api/forest${sub || ""}`,
  ready: () => true,
};
vibes.chat = NODE_CHAT_CTX;
function chatFeedEl() {
  return $(vibes.chat.feedSel);
}

// Respecte la préférence système : pas de particules ni de bursts si réduit.
const REDUCED = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// ── Identité / utilitaires ───────────────────────────────────────────────────
function userName() {
  let u = localStorage.getItem("meowtrack_user");
  if (!u) {
    u = (window.prompt("Ton pseudo (visible dans les chats) :", "") || "anon").trim() || "anon";
    localStorage.setItem("meowtrack_user", u);
  }
  return u;
}
function changeUser() {
  const u = (window.prompt("Ton pseudo :", vibes.user) || "").trim();
  if (u) {
    vibes.user = u;
    localStorage.setItem("meowtrack_user", u);
    $("#userName").textContent = u;
  }
}
function authorColor(n) {
  let h = 0;
  for (const c of String(n)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 60% 66%)`;
}
const cssId = (s) => (window.CSS && CSS.escape ? CSS.escape(String(s)) : String(s).replace(/[^A-Za-z0-9_-]/g, "\\$&"));

let toastTimer = null;
export function toast(msg) {
  let t = $("#gvToast");
  if (!t) {
    t = document.createElement("div");
    t.id = "gvToast";
    t.className = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

// ── Effets « waouh » : éclats de particules + classes d'animation ─────────────
function ensureFxLayer() {
  let l = document.getElementById("fxLayer");
  if (!l) {
    l = document.createElement("div");
    l.id = "fxLayer";
    document.body.appendChild(l);
  }
  return l;
}
// Petit feu d'artifice d'emojis qui jaillit depuis (cx, cy) (coords écran).
// Animé via la Web Animations API → auto-nettoyage à la fin (pas de CSS à gérer).
function sparkleBurst(cx, cy, opts = {}) {
  if (REDUCED || !document.body) return;
  const layer = ensureFxLayer();
  const n = opts.count || 8;
  const emojis = opts.emojis || ["✨", "💫", "⭐"];
  const baseDist = opts.dist || 44;
  for (let i = 0; i < n; i++) {
    const s = document.createElement("span");
    s.className = "fx-spark";
    s.textContent = emojis[i % emojis.length];
    s.style.left = cx + "px";
    s.style.top = cy + "px";
    s.style.fontSize = (opts.size || 16 + Math.random() * 8) + "px";
    layer.appendChild(s);
    const ang = (Math.PI * 2 * i) / n + Math.random() * 0.6 - 0.3;
    const dist = baseDist + Math.random() * baseDist * 0.7;
    const dx = Math.cos(ang) * dist;
    const dy = Math.sin(ang) * dist - dist * 0.35; // léger biais vers le haut
    const dur = 620 + Math.random() * 420;
    const spin = (Math.random() < 0.5 ? -1 : 1) * (140 + Math.random() * 160);
    const a = s.animate(
      [
        { transform: "translate(-50%,-50%) scale(.2) rotate(0deg)", opacity: 0 },
        { transform: `translate(calc(-50% + ${dx * 0.5}px), calc(-50% + ${dy * 0.5}px)) scale(1.15) rotate(${spin * 0.5}deg)`, opacity: 1, offset: 0.35 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.35) rotate(${spin}deg)`, opacity: 0 },
      ],
      { duration: dur, easing: "cubic-bezier(.25,.6,.3,1)" }
    );
    a.onfinish = () => s.remove();
    a.oncancel = () => s.remove();
  }
}
// Éclats centrés sur un élément du DOM (lit son rect courant).
function sparkleEl(el, opts = {}) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return; // élément masqué : on s'abstient
  sparkleBurst(r.left + (opts.ox != null ? opts.ox : r.width / 2), r.top + (opts.oy != null ? opts.oy : r.height / 2), opts);
}
// Classe d'effet à appliquer à une carte/nœud selon les sets transitoires.
function nodeFxClass(id) {
  const g = vibes.graph;
  return (g.spawned.has(id) ? " spawn" : "") + (g.pulsed.has(id) ? " pulse" : "") + (g.celebrated.has(id) ? " celebrate" : "") + (g.despawning.has(id) ? " despawn" : "");
}

// ── Rendu Markdown minimal et SÛR (sans dépendance) ───────────────────────────
// Sous-ensemble : titres, gras/italique/barré, code inline + blocs ```, listes
// (puces / numérotées), citations >, règles ---, liens [..](..) + autoliens http.
// Sécurité : on échappe TOUT le HTML d'abord (esc), puis on applique les
// transformations markdown → aucune balise utilisateur n'est jamais injectée.
function mdInline(str) {
  return str
    .replace(/`([^`]+)`/g, (_, c) => `<code class="md-code">${c}</code>`)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
}
export function renderMarkdown(src) {
  const raw = String(src || "");
  if (!raw.trim()) return "";
  // 1) Extraire les blocs de code clôturés (placeholders) pour ne pas les transformer.
  const blocks = [];
  let text = raw.replace(/```[ \t]*[\w-]*\n?([\s\S]*?)```/g, (_, code) => {
    const i = blocks.push(`<pre class="md-pre"><code>${esc(code.replace(/\n+$/, ""))}</code></pre>`) - 1;
    return ` CB${i} `;
  });
  // 2) Échapper le HTML restant (les caractères markdown * _ ` [ ] ( ) > # survivent).
  text = esc(text);

  const lines = text.split("\n");
  const out = [];
  let para = [];
  let listType = null;
  let inQuote = false;
  const flushPara = () => { if (para.length) { out.push(`<p>${mdInline(para.join(" "))}</p>`); para = []; } };
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  const closeQuote = () => { if (inQuote) { out.push("</blockquote>"); inQuote = false; } };

  // Découpe une ligne de tableau en cellules (gère les | de bord optionnels).
  const tableCells = (s) => {
    let t = s.trim();
    if (t.startsWith("|")) t = t.slice(1);
    if (t.endsWith("|")) t = t.slice(0, -1);
    return t.split("|").map((c) => c.trim());
  };
  const isTableSep = (s) => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(s) && s.includes("-");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const cb = line.match(/^ CB(\d+) $/);
    if (cb) { flushPara(); closeList(); closeQuote(); out.push(blocks[Number(cb[1])]); continue; }
    if (!line.trim()) { flushPara(); closeList(); closeQuote(); continue; }

    // Tableau GFM : ligne d'en-tête avec « | » suivie d'une ligne de séparation.
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara(); closeList(); closeQuote();
      const headers = tableCells(line);
      const aligns = tableCells(lines[i + 1]).map((c) => {
        const l = c.startsWith(":"), r = c.endsWith(":");
        return r && l ? "center" : r ? "right" : l ? "left" : "";
      });
      const rows = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim() && lines[j].includes("|")) { rows.push(tableCells(lines[j])); j++; }
      const al = (k) => (aligns[k] ? ` style="text-align:${aligns[k]}"` : "");
      let html = '<table class="md-table"><thead><tr>';
      headers.forEach((h, k) => (html += `<th${al(k)}>${mdInline(h)}</th>`));
      html += "</tr></thead><tbody>";
      for (const row of rows) {
        html += "<tr>";
        for (let k = 0; k < headers.length; k++) html += `<td${al(k)}>${mdInline(row[k] || "")}</td>`;
        html += "</tr>";
      }
      html += "</tbody></table>";
      out.push(html);
      i = j - 1;
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); closeList(); closeQuote(); const l = h[1].length; out.push(`<h${l} class="md-h md-h${l}">${mdInline(h[2].trim())}</h${l}>`); continue; }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { flushPara(); closeList(); closeQuote(); out.push('<hr class="md-hr">'); continue; }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara(); closeQuote();
      const t = ul ? "ul" : "ol";
      if (listType && listType !== t) closeList();
      if (!listType) { listType = t; out.push(`<${t} class="md-list">`); }
      out.push(`<li>${mdInline((ul ? ul[1] : ol[1]).trim())}</li>`);
      continue;
    }
    closeList();

    // NB : esc() a déjà transformé « > » en « &gt; » → on matche la forme échappée.
    const bq = line.match(/^\s*&gt;\s?(.*)$/);
    if (bq) { flushPara(); if (!inQuote) { inQuote = true; out.push('<blockquote class="md-quote">'); } out.push(`<p>${mdInline(bq[1])}</p>`); continue; }
    closeQuote();

    para.push(line.trim());
  }
  flushPara(); closeList(); closeQuote();
  return out.join("\n");
}

// ── Index de forêt ───────────────────────────────────────────────────────────
function indexForest(list) {
  vibes.forest = list || [];
  vibes.byId = new Map(vibes.forest.map((n) => [n.id, n]));
  vibes._blockedCache = null; // invalidé : la hiérarchie a changé
}
function indexLinks(list) {
  vibes.links = Array.isArray(list) ? list : [];
  const m = new Map();
  for (const l of vibes.links) {
    if (l.kind !== "requires") continue;
    if (!m.has(l.fromId)) m.set(l.fromId, new Set());
    m.get(l.fromId).add(l.toId);
  }
  vibes.reqByFrom = m;
  vibes._blockedCache = null; // invalidé : les prérequis ont changé
}
// Blocage « direct » : le nœud a lui-même au moins un prérequis (requires) non atteint.
function hasDirectBlock(node) {
  if (!node) return false;
  const reqs = vibes.reqByFrom.get(node.id);
  if (reqs && reqs.size) {
    for (const toId of reqs) {
      const t = vibes.byId.get(toId);
      if (t && t.status !== "done") return true;
    }
    return false;
  }
  // Vue détail : la forêt n'est pas indexée → on s'appuie sur node.requires (withLinks).
  if (Array.isArray(node.requires)) return node.requires.some((r) => r.status !== "done");
  return false;
}
// Un nœud est « bloqué » s'il a un prérequis non atteint OU si un de ses ancêtres l'est :
// le blocage se propage à tout le sous-arbre. Mémoïsé par rebuild de forêt/liens (O(profondeur)).
function isNodeBlocked(node) {
  if (!node) return false;
  // Vue détail (forêt non indexée) : pas de propagation possible → blocage direct seul.
  if (!vibes.byId || !vibes.byId.has(node.id)) return hasDirectBlock(node);
  const cache = vibes._blockedCache || (vibes._blockedCache = new Map());
  if (cache.has(node.id)) return cache.get(node.id);
  // Remonte la chaîne d'ancêtres ; un blocage direct quelque part bloque toute la descendance.
  const chain = [];
  let blocked = false;
  let cur = node;
  while (cur) {
    if (cache.has(cur.id)) { blocked = cache.get(cur.id); break; }
    chain.push(cur.id);
    if (hasDirectBlock(cur)) { blocked = true; break; }
    cur = cur.parentId != null ? vibes.byId.get(cur.parentId) : null;
  }
  for (const id of chain) cache.set(id, blocked); // toute la chaîne visitée partage le verdict
  return blocked;
}
function childrenOf(id) {
  return vibes.forest.filter((n) => n.parentId === id).sort((a, b) => a.position - b.position || a.id - b.id);
}
function rootsOf() {
  return vibes.forest.filter((n) => n.parentId == null).sort((a, b) => a.position - b.position || a.id - b.id);
}

// ── Navigation entre vues ────────────────────────────────────────────────────
function switchView(v) {
  if (v !== "vibes" && v !== "repo" && v !== "orch") v = "track";
  vibes.view = v;
  document.body.classList.remove("view-track", "view-vibes", "view-repo", "view-orch");
  document.body.classList.add("view-" + v);
  document.querySelectorAll(".nav-tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.view === v));
  $("#trackView").hidden = v !== "track";
  $("#repoView").hidden = v !== "repo";
  const orchView = $("#orchView");
  if (orchView) orchView.hidden = v !== "orch";
  if (v !== "vibes") {
    $("#vibesBar").hidden = true;
    $("#vibesView").hidden = true;
    $("#graphView").hidden = true;
    $("#nodeView").hidden = true;
    setForestChatVisible(false);
    closeStream();
  }
  const want = v === "track" ? "" : "#" + v;
  if (location.hash !== want && !(want === "" && location.hash === "")) location.hash = want;
  if (v === "vibes") openVibes();
  else if (v === "repo") openRepoView();
  // L'onglet Orchestrateur est un module découplé (orchestrator.js) : il s'abonne
  // à cet événement pour charger sa config + sa file de revue à l'affichage.
  document.dispatchEvent(new CustomEvent("meow:view", { detail: v }));
}

// Affiche/masque le panneau de chat « top level » (vue objectifs, hors détail nœud).
function setForestChatVisible(on) {
  const el = $("#forestChat");
  if (el) el.hidden = !on;
}

// Épingle / désépingle le chat « top level » sur toute la colonne de droite.
// La hauteur de l'en-tête est mesurée (elle varie quand la barre passe à la ligne)
// et exposée via --topbar-h pour caler le panneau pile sous l'en-tête.
function measureTopbar() {
  const tb = document.querySelector(".topbar");
  if (tb) document.documentElement.style.setProperty("--topbar-h", tb.offsetHeight + "px");
}
function setForestPinned(on) {
  // Épinglé et plein écran sont deux dispositions exclusives : épingler quitte le
  // plein écran (sinon les deux classes coexistent et la mise en page est incohérente).
  if (on && vibes.fullscreen) setForestFullscreen(false);
  vibes.pinned = on;
  localStorage.setItem("meowtrack_forest_pin", on ? "1" : "0");
  document.body.classList.toggle("forest-pinned", on);
  const chat = $("#forestChat");
  if (chat) {
    chat.classList.toggle("pinned", on);
    if (on) chat.classList.remove("collapsed"); // épinglé = toujours déployé
  }
  const btn = $("#forestChatPinBtn");
  if (btn) {
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.title = on ? "Détacher le chat (revenir au dock flottant)" : "Épingler le chat sur toute la colonne de droite";
  }
  if (on) measureTopbar();
}

// Bouton « Discuter des objectifs » : bascule l'ouverture du chat forêt. À la
// FERMETURE, sort toujours du plein écran et de l'épinglage (qui forcent l'affichage
// et rendraient la classe `collapsed` sans effet) → le chat se réduit vraiment.
function toggleForestChat() {
  const chat = $("#forestChat");
  if (!chat) return;
  const open = !chat.classList.contains("collapsed") || vibes.fullscreen || vibes.pinned;
  if (open) {
    // Mémorise le mode actif avant de fermer, pour le restaurer à la réouverture.
    vibes._lastChatMode = vibes.fullscreen ? "fullscreen" : vibes.pinned ? "pinned" : "normal";
    if (vibes.fullscreen) setForestFullscreen(false);
    if (vibes.pinned) setForestPinned(false);
    chat.classList.add("collapsed");
  } else {
    chat.classList.remove("collapsed");
    // Restaure le dernier mode (plein écran / épinglé) ; « normal » = rien de plus.
    if (vibes._lastChatMode === "fullscreen") setForestFullscreen(true);
    else if (vibes._lastChatMode === "pinned") setForestPinned(true);
  }
}

// Met la discussion « top level » en plein écran (ou l'en sort). Prioritaire sur
// l'état réduit (toujours déployé en plein écran). Transitoire (non persisté).
function setForestFullscreen(on) {
  // Exclusif avec l'épinglage : passer en plein écran détache le panneau épinglé.
  if (on && vibes.pinned) setForestPinned(false);
  vibes.fullscreen = on;
  const chat = $("#forestChat");
  if (chat) {
    chat.classList.toggle("fullscreen", on);
    if (on) chat.classList.remove("collapsed"); // plein écran = toujours déployé
  }
  const btn = $("#forestChatExpandBtn");
  if (btn) {
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.title = on ? "Quitter le plein écran" : "Mettre la discussion en plein écran";
  }
  if (on) measureTopbar();
}

export async function openVibes() {
  $("#nodeView").hidden = true;
  $("#vibesBar").hidden = false;
  vibes.current = null;
  vibes.currentNode = null;
  vibes._ghostNodes = []; // pas de fantômes hérités (turn antérieur / autre vue)
  vibes.chat = FOREST_CHAT_CTX; // chat actif = forêt
  const fm = $("#forestModelSel");
  if (fm) fm.value = vibes.model;
  applyLayoutToggle();
  setForestChatVisible(true);
  setForestPinned(vibes.pinned); // restaure l'état épinglé persisté
  setForestFullscreen(vibes.fullscreen); // état plein écran (transitoire)
  await loadForest();
  subscribeForest();
  loadForestChat();
}

function setVibesLayout(l) {
  vibes.layout = l;
  localStorage.setItem("meowtrack_layout", l);
  document.querySelectorAll(".seg-toggle .seg").forEach((b) => b.classList.toggle("active", b.dataset.layout === l));
  if (!vibes.current) applyLayoutToggle();
}
function applyLayoutToggle() {
  if (vibes.current) return; // en détail
  const graph = vibes.layout === "graph";
  $("#graphView").hidden = !graph;
  $("#vibesView").hidden = graph;
  document.querySelectorAll(".seg-toggle .seg").forEach((b) => b.classList.toggle("active", b.dataset.layout === vibes.layout));
}

// ── Chargement forêt + rendu des deux vues ───────────────────────────────────
async function loadForest() {
  try {
    const [forest, links] = await Promise.all([
      api.get("/api/nodes?view=forest"),
      api.get("/api/nodes/links").catch(() => []),
    ]);
    indexForest(forest);
    indexLinks(links);
    renderForestViews();
  } catch (e) {
    $("#graphSvg") && ($("#vibesSummary").textContent = "Erreur : " + e.message);
  }
}
function renderForestViews() {
  renderGrid();
  renderGraph();
  const roots = rootsOf().length;
  $("#vibesSummary").textContent = `· ${roots} objectif${roots > 1 ? "s" : ""} · ${vibes.forest.length} nœud${vibes.forest.length > 1 ? "s" : ""}`;
  // Purge différée des marqueurs d'effet (les animations CSS one-shot ont joué).
  const g = vibes.graph;
  if (g.spawned.size || g.pulsed.size || g.celebrated.size || g.fxFired.size) {
    clearTimeout(vibes._fxClear);
    vibes._fxClear = setTimeout(() => {
      g.spawned.clear();
      g.pulsed.clear();
      g.celebrated.clear();
      g.fxFired.clear();
    }, 1000);
  }
}
let _forestRaf = null;
function renderForestSoon() {
  if (_forestRaf) return;
  _forestRaf = requestAnimationFrame(() => {
    _forestRaf = null;
    if (!vibes.current) renderForestViews();
  });
}

// Animation de suppression : le nœud (et son sous-arbre, encore dans les données
// jusqu'au refetch) est marqué « despawning » puis flétri AU RENDU dans toutes les
// vues — graphe, grille, arbre détail. On passe par un set (et non le DOM direct)
// pour survivre aux re-rendus déclenchés entre-temps (maj de progression des
// ancêtres). Après l'anim : on purge le set et on rejoue `then` (le refetch qui
// retire vraiment les nœuds). Mouvement réduit → `then` direct, sans anim.
function animateNodeRemoval(rootId, then) {
  const run = typeof then === "function" ? then : () => {};
  if (REDUCED) return run();
  const ids = subtreeIds(rootId);
  for (const id of ids) vibes.graph.despawning.add(id);
  // Re-rendu immédiat de la vue active pour appliquer la classe « despawn ».
  if (vibes.current && vibes.currentNode) renderTree(vibes.currentNode);
  else renderForestViews();
  // Petit « pouf » sur le disque du nœud racine dans le graphe.
  if (!$("#graphView").hidden) {
    const disc = $("#graphSvg")?.querySelector(`.g-node[data-id="${cssId(rootId)}"] .g-disc`);
    if (disc) sparkleEl(disc, { count: 7, dist: 34, size: 16, emojis: ["💨", "✨", "·"] });
  }
  setTimeout(() => {
    for (const id of ids) vibes.graph.despawning.delete(id);
    run();
  }, 440);
}

// ── Grille (racines) ─────────────────────────────────────────────────────────
function nodeCardHtml(n) {
  return `<div class="goal-card status-${esc(n.status)}${nodeFxClass(n.id)}" data-ref="${esc(n.ref)}" data-id="${n.id}" style="--gc:var(--${esc(n.color || "accent")})">
    <div class="gc-top"><span class="gc-emoji">${esc(n.emoji || "🎯")}</span><span class="gc-title">${esc(n.title)}</span></div>
    <div class="gc-ref">${esc(n.ref)}</div>
    <div class="gc-bar"><div class="gc-fill" style="width:${n.progress}%"></div></div>
    <div class="gc-foot"><span>${n.progress}%</span><span>${n.childCount} sous-nœud${n.childCount > 1 ? "s" : ""}</span><span>${esc(NODE_STATUS_LABEL[n.status] || n.status)}</span></div>
  </div>`;
}
function ghostCardHtml(gh) {
  return `<div class="goal-card ghost-preview status-${esc(gh.status || "active")}">
    <div class="gc-top"><span class="gc-emoji">${esc(gh.emoji || "✨")}</span><span class="gc-title">${esc(gh.title)}</span></div>
    <div class="gc-ref">⏳ en cours…</div>
  </div>`;
}
function renderGrid() {
  const wrap = $("#goalCards");
  if (!wrap) return;
  wrap.innerHTML =
    rootsOf().map(nodeCardHtml).join("") +
    vibes._ghostNodes.map(ghostCardHtml).join("") +
    `<div class="goal-card ghost-card" id="ghostAddNode">＋ Nouvel objectif</div>`;
  wrap.querySelectorAll(".goal-card[data-ref]").forEach((c) => c.addEventListener("click", () => openNode(c.dataset.ref)));
  $("#ghostAddNode").addEventListener("click", () => openNodeModal(null, null));
  // Éclats sur les cartes fraîchement nées / atteintes (uniquement si la grille est visible).
  if (!REDUCED && !$("#vibesView").hidden) {
    wrap.querySelectorAll(".goal-card.spawn, .goal-card.celebrate").forEach((c) => {
      const id = Number(c.dataset.id);
      if (vibes.graph.fxFired.has(id)) return;
      vibes.graph.fxFired.add(id);
      const done = c.classList.contains("celebrate");
      sparkleEl(c, { oy: 26, count: done ? 14 : 8, dist: done ? 56 : 42, emojis: done ? ["🎉", "✨", "🏆", "⭐"] : ["✨", "💫"] });
    });
  }
}

// ── Arbre hiérarchique top-down (créé via DOM API : anti-XSS) ─────────────────
// Layout « tidy tree » : Y dérive de la profondeur (N0 en haut), chaque N_k+1 est
// posé sous son parent N_k, les feuilles sont alignées de gauche à droite et chaque
// parent est centré au-dessus de ses enfants. Les racines (N0) démarrent en haut à
// gauche, chaque arbre racine à la suite du précédent.
const NS = "http://www.w3.org/2000/svg";
const G_LEVEL_GAP = 138; // distance verticale entre deux niveaux (N_k → N_k+1)
const G_NODE_GAP = 134;  // largeur horizontale d'un emplacement feuille
const G_ROOT_ROW_GAP = 160; // espace vertical entre deux bandes de racines enroulées
const G_ROOT_ROW_MAX = 50;  // nombre max de racines par bande (plafond dur)
function computeGraphLayout() {
  // Layout réel : nœuds de la forêt, épinglage via posX/posY.
  return tidyForest(
    rootsOf(),
    (id) => childrenOf(id),
    (n) => (n.posX != null && n.posY != null) ? { x: n.posX, y: n.posY } : null,
  );
}
// Tidy-layout générique d'une forêt. `roots` : objets racines {id, depth, …}. `kidsOf(id)` :
// renvoie les enfants (mêmes objets). `pinOf(node)` : {x,y} si le nœud est épinglé, sinon null.
// Chaque RACINE occupe une bande horizontale = LARGEUR de son sous-arbre (≥ 1 emplacement),
// donc les sous-arbres frères ne se chevauchent jamais. (Bug corrigé : l'ancienne version
// avançait la rangée d'un G_NODE_GAP FIXE par racine et ne recalait que la racine sur son
// slot → un sous-arbre plus large qu'un slot débordait sur les feuilles du voisin.)
// ENROULEMENT : quand la somme des largeurs de racines dépasse une largeur cible (≈ aire
// totale au carré, ratio paysage), on passe à une nouvelle bande sous la précédente — évite
// une seule ligne interminable quand il y a beaucoup de projets/racines.
function tidyForest(roots, kidsOf, pinOf) {
  // Post-ordre : pose les feuilles à la suite du curseur, centre chaque parent sur
  // l'intervalle [1re … dernière feuille] de ses enfants. Y = profondeur. cur.x final =
  // largeur du sous-arbre (en pixels).
  const placeSub = (node, local, cur) => {
    const y = (node.depth || 0) * G_LEVEL_GAP;
    const kids = kidsOf(node.id);
    if (!kids.length) { local.set(node.id, { x: cur.x, y }); cur.x += G_NODE_GAP; return; }
    for (const k of kids) placeSub(k, local, cur);
    const first = local.get(kids[0].id).x, last = local.get(kids[kids.length - 1].id).x;
    local.set(node.id, { x: (first + last) / 2, y });
  };
  const tidy = new Map(); // layout auto « idéal » (relatif à la hiérarchie)
  // Pré-calcul par racine : layout local relatif + largeur + hauteur de son sous-arbre.
  const subtrees = roots.map((root) => {
    const local = new Map();
    const cur = { x: 0 };
    placeSub(root, local, cur);
    let height = 0;
    for (const p of local.values()) if (p.y > height) height = p.y;
    return { local, width: Math.max(cur.x, G_NODE_GAP), height };
  });
  // Largeur cible d'une bande : ~√(aire totale) × ratio paysage, avec un plancher pour ne
  // pas enrouler tant qu'il y a peu de racines (une longue ligne reste préférable à 2 bandes
  // quasi vides). aire = largeur totale × hauteur de bande (sous-arbre le plus haut + gap).
  const totalW = subtrees.reduce((s, st) => s + st.width, 0);
  const bandH = subtrees.reduce((m, st) => Math.max(m, st.height), 0) + G_ROOT_ROW_GAP;
  const maxRowWidth = Math.max(G_NODE_GAP * 6, Math.sqrt(totalW * bandH) * 1.7);
  let cursorX = 0, rowY = 0, rowHeight = 0, rowCount = 0;
  for (const st of subtrees) {
    // Nouvelle bande dès que la largeur cible OU le plafond de 50 racines est atteint.
    if (rowCount > 0 && (cursorX + st.width > maxRowWidth || rowCount >= G_ROOT_ROW_MAX)) {
      cursorX = 0; rowY += rowHeight + G_ROOT_ROW_GAP; rowHeight = 0; rowCount = 0;
    }
    for (const [id, p] of st.local) tidy.set(id, { x: p.x + cursorX, y: p.y + rowY });
    cursorX += st.width; // avance de la largeur réelle du sous-arbre
    if (st.height > rowHeight) rowHeight = st.height;
    rowCount++;
  }
  // Positions finales : on part du tidy-layout, mais chaque nœud ÉPINGLÉ (drag & drop
  // persisté) « entraîne » tout son sous-arbre auto en le décalant du même delta. Ainsi
  // un nouvel enfant (pos NULL = auto) d'un parent déplacé apparaît À CÔTÉ de ce parent,
  // pas à l'emplacement tidy global. Un descendant lui-même épinglé redéfinit le delta
  // pour son propre sous-arbre.
  const pos = new Map();
  const place = (node, dx, dy) => {
    const t = tidy.get(node.id) || { x: 0, y: 0 };
    const pin = pinOf(node);
    let x, y;
    if (pin) {
      x = pin.x; y = pin.y;
      dx = x - t.x; dy = y - t.y; // nouveau delta hérité par le sous-arbre
    } else {
      x = t.x + dx; y = t.y + dy;
    }
    pos.set(node.id, { x, y });
    for (const k of kidsOf(node.id)) place(k, dx, dy);
  };
  for (const root of roots) place(root, 0, 0);
  return pos;
}
// ── Couleur par cascade ──────────────────────────────────────────────────────
// Assigne une teinte stable (par id croissant) à chaque tête de cascade (profondeur 1).
function buildCascadeColors() {
  const heads = vibes.forest.filter((n) => n.depth === 1).sort((a, b) => a.id - b.id);
  const m = new Map();
  heads.forEach((h, i) => m.set(h.id, CASCADE_PALETTE[i % CASCADE_PALETTE.length]));
  vibes.graph.cascadeColors = m;
}
// Teinte d'un nœud : neutre si structure (profondeur 0) ; sinon la couleur de sa
// tête de cascade (remontée jusqu'à l'ancêtre de profondeur 1).
function cascadeColorOf(n) {
  if (!n || n.depth === 0) return CASCADE_NEUTRAL;
  let cur = n;
  while (cur && cur.depth > 1) cur = vibes.byId.get(cur.parentId);
  return (cur && vibes.graph.cascadeColors && vibes.graph.cascadeColors.get(cur.id)) || CASCADE_NEUTRAL;
}
// Ids d'un nœud + tout son sous-arbre (pour déplacer/épingler ensemble).
function subtreeIds(id) {
  const out = [id];
  const rec = (pid) => { for (const c of childrenOf(pid)) { out.push(c.id); rec(c.id); } };
  rec(id);
  return out;
}
function svgEl(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}
function edgeD(p, c) {
  // Lien vertical descendant parent (p, en haut) → enfant (c, en bas) : courbe en S
  // avec points de contrôle à mi-hauteur (style organigramme top-down). Reste valide
  // pour des nœuds déplacés à la main dans une position arbitraire.
  const my = (p.y + c.y) / 2;
  return `M ${p.x} ${p.y} C ${p.x} ${my}, ${c.x} ${my}, ${c.x} ${c.y}`;
}
function edgePath(p, c, node) {
  return svgEl("path", {
    d: edgeD(p, c),
    class: "g-edge" + (vibes.graph.spawned.has(node.id) ? " spawn" : "") + (vibes.graph.despawning.has(node.id) ? " despawn" : ""),
    "data-cid": String(node.id),
    "data-pid": String(node.parentId), // pour la maj live des arêtes pendant le drag
    stroke: cascadeColorOf(node),
  });
}
// Faisceau de rayons (célébration « jalon atteint »), dessiné derrière le nœud.
function raysGroup() {
  const g = svgEl("g", { class: "g-rays" });
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI * 2 * i) / 8;
    g.appendChild(svgEl("line", { x1: Math.cos(a) * 16, y1: Math.sin(a) * 16, x2: Math.cos(a) * 42, y2: Math.sin(a) * 42, class: "g-ray" }));
  }
  return g;
}
function nodeGroup(n, p) {
  const r = n.depth === 0 ? 26 : Math.max(12, 24 - n.depth * 3);
  const spawn = vibes.graph.spawned.has(n.id);
  const pulse = vibes.graph.pulsed.has(n.id);
  const celebrate = vibes.graph.celebrated.has(n.id);
  const despawn = vibes.graph.despawning.has(n.id);
  const fxCls = (spawn ? " spawn" : "") + (pulse ? " pulse" : "") + (celebrate ? " celebrate" : "") + (despawn ? " despawn" : "");
  const blocked = isNodeBlocked(n) ? " blocked" : "";
  // Node d'activation : porte manuelle. « activé » = status 'done' (débloque les dépendants).
  const isAct = n.kind === "activation";
  const actCls = isAct ? " kind-activation" + (n.status === "done" ? " activated" : " deactivated") : "";
  const g = svgEl("g", { transform: `translate(${p.x},${p.y})`, class: "g-node status-" + n.status + fxCls + blocked + actCls, "data-ref": n.ref, "data-id": String(n.id), "data-kind": n.kind || "normal" });
  // Tooltip natif : le label étant tronqué, le survol révèle le titre complet.
  const ttl = svgEl("title", {});
  ttl.textContent = isAct ? `${n.title} — node d'activation (${n.status === "done" ? "activé" : "inactif"})` : n.title;
  g.appendChild(ttl);
  // Onde de choc (naissance) et rayons (jalon atteint) : sous le nœud (peints en premier).
  if (spawn) g.appendChild(svgEl("circle", { r: 10, class: "g-halo", stroke: cascadeColorOf(n) }));
  if (celebrate) g.appendChild(raysGroup());
  // Groupe interne mis à l'échelle pour l'anim d'apparition (le translate reste sur g).
  const inner = svgEl("g", { class: "g-inner" });
  // Cadre « porte » du node d'activation : losange visible derrière le disque (silhouette
  // distincte du cercle normal → reconnaissable d'un coup d'œil ; lit/atténué selon l'état).
  if (isAct) {
    const s = r + 11;
    inner.appendChild(svgEl("polygon", { class: "g-act-frame", points: `0,${-s} ${s},0 0,${s} ${-s},0` }));
  }
  const circ = 2 * Math.PI * (r + 5);
  inner.appendChild(svgEl("circle", { r: r + 5, class: "g-track" }));
  inner.appendChild(svgEl("circle", { r: r + 5, class: "g-ring", "stroke-dasharray": `${(circ * n.progress) / 100} ${circ}`, transform: "rotate(-90)" }));
  inner.appendChild(svgEl("circle", { r, class: "g-disc", fill: cascadeColorOf(n) }));
  const emo = svgEl("text", { class: "g-emoji", "text-anchor": "middle", dy: "0.35em", "font-size": String(Math.round(r)) });
  emo.textContent = n.emoji || (isAct ? "⚡" : "🎯");
  inner.appendChild(emo);
  const lbl = svgEl("text", { class: "g-label", "text-anchor": "middle", y: String(r + 18) });
  lbl.textContent = n.title.length > 18 ? n.title.slice(0, 17) + "…" : n.title;
  inner.appendChild(lbl);
  // Badge d'état (coin haut-droit) : lisible d'un coup d'œil. Le blocage prime sur le statut.
  const badgeIcon = blocked ? "🔒"
    : n.runState === "running" ? "▶️"
    : n.status === "paused" ? "⏸"
    : n.status === "waiting" ? "⏳"
    : n.status === "done" ? "✓"
    : n.status === "abandoned" ? "✕"
    : null;
  if (badgeIcon) {
    const badge = svgEl("text", {
      class: "g-state-badge", x: String(r - 4), y: String(-(r - 4)),
      "text-anchor": "middle", "dominant-baseline": "middle",
      "font-size": String(Math.max(10, Math.round(r * 0.55))),
    });
    badge.textContent = badgeIcon;
    inner.appendChild(badge);
  }
  g.appendChild(inner);
  return g;
}
// Layout combiné réel + fantômes (chat « top level »). Les fantômes participent au MÊME
// tidy-layout que les vrais nœuds (comme des pseudo-nœuds), donc les parents s'écartent
// pour les accueillir et les feuilles fantômes se posent proprement sous leur parent — au
// lieu de « filer » à droite ou de se superposer. Conséquence : l'aperçu en cours de
// génération a déjà la disposition FINALE → plus de saut quand les vrais nœuds remplacent
// les fantômes. Renvoie { pos (ids réels numériques), gpos (clés fantômes) }.
// uid : id numérique pour un vrai nœud, "g:"+key pour un fantôme.
function computeLayoutWithGhosts() {
  const ghosts = vibes._ghostNodes;
  const byKey = new Map(ghosts.map((g) => [g.key, g]));
  // Parent unifié d'un fantôme : "g:"+key (parent fantôme), id numérique (parent réel) ou null.
  const ghostParentUid = (gh) => {
    if (gh.parentKey != null && byKey.has(gh.parentKey)) return "g:" + gh.parentKey;
    if (gh.parentId != null && vibes.byId.has(gh.parentId)) return gh.parentId;
    return null;
  };
  // Enfants fantômes indexés par uid de parent + liste des fantômes racines.
  const ghKids = new Map();
  const ghostRoots = [];
  for (const gh of ghosts) {
    const pu = ghostParentUid(gh);
    if (pu == null) ghostRoots.push(gh);
    else { if (!ghKids.has(pu)) ghKids.set(pu, []); ghKids.get(pu).push(gh); }
  }
  // Profondeur d'un fantôme (mémoïsée) : 0 si racine, sinon profondeur(parent)+1.
  const depthCache = new Map();
  const ghostDepth = (gh) => {
    if (depthCache.has(gh.key)) return depthCache.get(gh.key);
    const pu = ghostParentUid(gh);
    const d = pu == null ? 0
      : typeof pu === "number" ? (vibes.byId.get(pu).depth || 0) + 1
      : ghostDepth(byKey.get(pu.slice(2))) + 1;
    depthCache.set(gh.key, d);
    return d;
  };
  // Pseudo-nœud uniforme {id (uid), depth, _real?, _ghost?} pour tidyForest.
  const wrap = (uid) => {
    if (typeof uid === "number") { const n = vibes.byId.get(uid); return { id: uid, depth: n.depth || 0, _real: n }; }
    const gh = byKey.get(uid.slice(2));
    return { id: uid, depth: ghostDepth(gh), _ghost: gh };
  };
  // Enfants unifiés : vrais enfants (si parent réel) PUIS enfants fantômes (nouveaux → après).
  const kidsOf = (uid) => {
    const out = [];
    if (typeof uid === "number") for (const c of childrenOf(uid)) out.push(wrap(c.id));
    for (const gh of ghKids.get(uid) || []) out.push(wrap("g:" + gh.key));
    return out;
  };
  const roots = rootsOf().map((r) => wrap(r.id)).concat(ghostRoots.map((gh) => wrap("g:" + gh.key)));
  const pinOf = (node) => node._real && node._real.posX != null && node._real.posY != null
    ? { x: node._real.posX, y: node._real.posY } : null;
  const all = tidyForest(roots, kidsOf, pinOf);
  const pos = new Map(), gpos = new Map();
  for (const [uid, p] of all) {
    if (typeof uid === "number") pos.set(uid, p);
    else gpos.set(uid.slice(2), p);
  }
  return { pos, gpos };
}
function ghostNodeGroup(gh, p) {
  const g = svgEl("g", { transform: `translate(${p.x},${p.y})`, class: "g-node g-ghost status-" + gh.status });
  const ttl = svgEl("title", {});
  ttl.textContent = gh.title;
  g.appendChild(ttl);
  const inner = svgEl("g", { class: "g-inner" });
  const r = 18;
  inner.appendChild(svgEl("circle", { r, class: "g-disc g-ghost-disc" }));
  const emo = svgEl("text", { class: "g-emoji", "text-anchor": "middle", dy: "0.35em", "font-size": "16" });
  emo.textContent = gh.emoji || "✨";
  inner.appendChild(emo);
  const lbl = svgEl("text", { class: "g-label", "text-anchor": "middle", y: String(r + 18) });
  lbl.textContent = gh.title.length > 18 ? gh.title.slice(0, 17) + "…" : gh.title;
  inner.appendChild(lbl);
  g.appendChild(inner);
  return g;
}
function ghostEdge(p, c) {
  return svgEl("path", { d: edgeD(p, c), class: "g-edge g-ghost-edge" });
}
// Rayon visuel externe d'un nœud du graphe (disque + anneau de progression), aligné
// sur nodeGroup. Sert à rogner les arêtes de prérequis sur le bord des nœuds.
function nodeOuterR(id) {
  const n = vibes.byId.get(id);
  if (!n) return 24;
  return (n.depth === 0 ? 26 : Math.max(12, 24 - n.depth * 3)) + 5;
}
// Centre (barycentre) des positions du graphe — sert à orienter la courbure des
// prérequis vers l'EXTÉRIEUR de l'arbre. Recalculé à chaque rendu / drag.
function graphCenter(pos) {
  let sx = 0, sy = 0, n = 0;
  for (const p of pos.values()) { sx += p.x; sy += p.y; n++; }
  return n ? { x: sx / n, y: sy / n } : { x: 0, y: 0 };
}
// Géométrie partagée d'une arête de prérequis : normale unitaire (côté de courbure),
// amplitude et milieu de la corde. center : si fourni, la courbe se bombe du côté OPPOSÉ
// au centre du graphe (vers l'extérieur) — le sens de courbure suit les positions des
// nœuds et ne traverse plus l'arbre. Sans center, repli sur un côté perpendiculaire fixe.
function reqGeom(a, b, center) {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len, ny = dx / len;
  if (center && (nx * (mx - center.x) + ny * (my - center.y)) < 0) { nx = -nx; ny = -ny; }
  return { nx, ny, off: Math.min(60, len * 0.18), mx, my };
}
// Sommet visuel de la courbe (point à t=0.5) : sert à poser le bouton « supprimer ».
function reqApex(a, b, center) {
  const g = reqGeom(a, b, center);
  return { x: g.mx + g.nx * g.off / 2, y: g.my + g.ny * g.off / 2 };
}
// Arête de PRÉREQUIS : « from dépend de to ». Courbe pointillée distincte (jamais
// confondue avec la hiérarchie pleine), flèche allant du prérequis (to) vers le
// dépendant (from) — le prérequis « débloque » ce qui en dépend.
// L'arc s'écarte du segment droit pour rester lisible même entre nœuds éloignés.
// ra/rb rognent les extrémités sur le périmètre des nœuds (le long de la tangente de
// la courbe quadratique) pour que la flèche se pose VISIBLEMENT sur le bord du dépendant
// au lieu d'être cachée sous son disque (les nœuds sont peints par-dessus les arêtes).
function reqEdgeD(a, b, ra = 0, rb = 0, center = null) {
  const { nx, ny, off, mx, my } = reqGeom(a, b, center);
  const cx = mx + nx * off, cy = my + ny * off;
  let ax = a.x, ay = a.y, bx = b.x, by = b.y;
  if (ra) { const tx = cx - a.x, ty = cy - a.y, tl = Math.hypot(tx, ty) || 1; ax = a.x + (tx / tl) * ra; ay = a.y + (ty / tl) * ra; }
  if (rb) { const tx = b.x - cx, ty = b.y - cy, tl = Math.hypot(tx, ty) || 1; bx = b.x - (tx / tl) * rb; by = b.y - (ty / tl) * rb; }
  return `M ${ax} ${ay} Q ${cx} ${cy} ${bx} ${by}`;
}
// Une arête de prérequis = un groupe : une HITBOX large transparente (facile à viser à la
// souris) + le trait pointillé visible (sans capture d'événements). data-from/to et le
// tooltip portés par le groupe ; le clic est géré au niveau du groupe (.g-req-edge).
function reqEdgePath(a, b, link, blocked, center) {
  // a = position du dépendant (from), b = position du prérequis (to).
  // Tracé du prérequis (to) VERS le dépendant (from) : la pointe se pose sur le dépendant.
  const ra = nodeOuterR(link.toId) + 2;         // démarre juste hors du prérequis (to)
  const rb = nodeOuterR(link.fromId) + 9;       // laisse la place à la pointe de flèche sur le dépendant
  const d = reqEdgeD(b, a, ra, rb, center);
  const g = svgEl("g", {
    class: "g-req-edge" + (blocked ? " blocked" : ""),
    "data-from": String(link.fromId),
    "data-to": String(link.toId),
  });
  g.appendChild(svgEl("path", { d, class: "g-req-hit" }));
  g.appendChild(svgEl("path", { d, class: "g-req" + (blocked ? " blocked" : ""), "marker-end": blocked ? "url(#reqArrowBlocked)" : "url(#reqArrow)" }));
  // Tooltip natif au survol : lève l'ambiguïté du sens (la flèche va du prérequis vers le dépendant).
  const from = vibes.byId.get(link.fromId), to = vibes.byId.get(link.toId);
  if (from && to) {
    const ttl = svgEl("title", {});
    ttl.textContent = `« ${from.title} » dépend de « ${to.title} » — clic pour retirer`;
    g.appendChild(ttl);
  }
  return g;
}
// <defs> du graphe : marqueurs de flèche pour les arêtes de prérequis (définis une fois,
// une variante normale + une bloquée pour que la pointe reprenne la couleur de l'arête).
function reqArrowMarker(id, cls) {
  const m = svgEl("marker", { id, viewBox: "0 0 10 10", refX: "8", refY: "5", markerWidth: "9", markerHeight: "9", orient: "auto-start-reverse" });
  m.appendChild(svgEl("path", { d: "M 0 0 L 10 5 L 0 10 z", class: cls }));
  return m;
}
function graphDefs() {
  const defs = svgEl("defs", {});
  defs.appendChild(reqArrowMarker("reqArrow", "g-req-arrow"));
  defs.appendChild(reqArrowMarker("reqArrowBlocked", "g-req-arrow-blocked"));
  return defs;
}
// Calcule les ids de nœuds masqués par les filtres de statut.
// Un nœud est masqué si son propre statut est filtré OU si un ancêtre est masqué
// (on ne laisse pas des enfants visibles suspendus sans parent visible).
function computeHiddenNodes() {
  const hidden = new Set();
  const h = vibes.graph.hiddenStatuses;
  if (!h.size) return hidden;
  const visit = (n) => {
    if (h.has(n.status) || (n.parentId != null && hidden.has(n.parentId))) hidden.add(n.id);
    for (const c of childrenOf(n.id)) visit(c);
  };
  for (const root of rootsOf()) visit(root);
  return hidden;
}
// Dessine la minimap : vue d'ensemble de tout le graphe avec le rectangle de viewport.
function renderMinimap(pos, hiddenIds) {
  const mm = $("#graphMinimap");
  if (!mm || !pos || !pos.size) return;
  // Bounding box de tous les nœuds (visibles ET masqués, pour que la minimap reste stable).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pos.values()) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  if (!isFinite(minX)) { mm.style.display = "none"; return; }
  mm.style.display = "";
  const pad = 60;
  mm.setAttribute("viewBox", `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`);
  while (mm.firstChild) mm.removeChild(mm.firstChild);
  // Arêtes hiérarchiques (lignes fines).
  for (const n of vibes.forest) {
    if (n.parentId == null) continue;
    const pp = pos.get(n.parentId), pc = pos.get(n.id);
    if (!pp || !pc) continue;
    const dim = hiddenIds && (hiddenIds.has(n.id) || hiddenIds.has(n.parentId));
    mm.appendChild(svgEl("line", { x1: pp.x, y1: pp.y, x2: pc.x, y2: pc.y, stroke: "rgba(255,255,255,.18)", "stroke-width": "6", opacity: dim ? "0.3" : "1" }));
  }
  // Nœuds (petits disques colorés).
  for (const n of vibes.forest) {
    const p = pos.get(n.id);
    if (!p) continue;
    const dim = hiddenIds && hiddenIds.has(n.id);
    mm.appendChild(svgEl("circle", { cx: p.x, cy: p.y, r: "14", fill: cascadeColorOf(n), opacity: dim ? "0.25" : "0.9" }));
  }
  // Rectangle de viewport courant.
  const v = vibes.graph.view;
  mm.appendChild(svgEl("rect", { id: "minimapViewport", x: v.x, y: v.y, width: v.w, height: v.h, fill: "rgba(255,255,255,.07)", stroke: "rgba(255,255,255,.55)", "stroke-width": "10" }));
}
function renderGraph() {
  const svg = $("#graphSvg");
  if (!svg || $("#graphView").hidden) return;
  buildCascadeColors();         // teintes par cascade, recalculées à chaque rendu
  // Pendant un tour IA « top level », fantômes ET vrais nœuds sont disposés ensemble
  // (les parents s'écartent pour accueillir les fantômes) → l'aperçu = la disposition finale.
  const layout = vibes._ghostNodes.length ? computeLayoutWithGhosts() : { pos: computeGraphLayout(), gpos: null };
  const pos = layout.pos;
  const gpos = layout.gpos;
  vibes.graph.posMap = pos;     // réutilisé par le drag live et le recalcul des arêtes
  vibes.graph.edgeDel = null;   // les overlays poubelle (re)disparaissent au rendu
  vibes.graph.reqDel = null;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  svg.appendChild(graphDefs());
  const gEdges = svgEl("g", { class: "g-edges" });
  const gReq = svgEl("g", { class: "g-reqs" });
  const gNodes = svgEl("g", { class: "g-nodes" });
  svg.appendChild(gEdges);
  svg.appendChild(gReq);
  svg.appendChild(gNodes);
  const hiddenIds = computeHiddenNodes();
  for (const n of vibes.forest) {
    if (n.parentId == null) continue;
    if (hiddenIds.has(n.id) || hiddenIds.has(n.parentId)) continue;
    const pp = pos.get(n.parentId), pc = pos.get(n.id);
    if (pp && pc) gEdges.appendChild(edgePath(pp, pc, n));
  }
  // Arêtes de prérequis (par-dessus la hiérarchie, sous les nœuds). La courbure se
  // bombe vers l'extérieur du graphe (centre des positions) → suit les positions.
  const center = graphCenter(pos);
  for (const l of vibes.links) {
    if (l.kind !== "requires") continue;
    if (hiddenIds.has(l.fromId) || hiddenIds.has(l.toId)) continue;
    const pf = pos.get(l.fromId), pt = pos.get(l.toId);
    if (!pf || !pt) continue;
    const to = vibes.byId.get(l.toId);
    gReq.appendChild(reqEdgePath(pf, pt, l, to && to.status !== "done", center));
  }
  for (const n of vibes.forest) {
    if (hiddenIds.has(n.id)) continue;
    const pp = pos.get(n.id);
    if (pp) gNodes.appendChild(nodeGroup(n, pp));
  }
  // Aperçu fantôme (chat « top level ») : arêtes + nœuds non persistés, par-dessus.
  if (gpos) {
    for (const gh of vibes._ghostNodes) {
      const gp = gpos.get(gh.key);
      if (!gp) continue;
      let pp = null;
      if (gh.parentKey && gpos.has(gh.parentKey)) pp = gpos.get(gh.parentKey);
      else if (gh.parentId != null && pos.has(gh.parentId)) pp = pos.get(gh.parentId);
      if (pp) gEdges.appendChild(ghostEdge(pp, gp));
      gNodes.appendChild(ghostNodeGroup(gh, gp));
    }
  }
  if (!rootsOf().length && !vibes._ghostNodes.length) {
    const t = svgEl("text", { x: "0", y: "0", "text-anchor": "middle", class: "g-empty" });
    t.textContent = "Aucun objectif — clique « + Nouvel objectif »";
    gNodes.appendChild(t);
  }
  // Le fit englobe aussi les fantômes (sinon ils apparaîtraient hors cadre).
  // On exclut les nœuds masqués par le filtre pour que la vue s'adapte aux nœuds visibles.
  let fitPos = hiddenIds.size ? new Map([...pos].filter(([id]) => !hiddenIds.has(id))) : pos;
  if (gpos && gpos.size) { fitPos = new Map(fitPos); let i = 0; for (const v of gpos.values()) fitPos.set("ghost:" + i++, v); }
  // Pendant un tour de création (fantômes présents), on RECADRE toujours : l'arbre en
  // cours de génération reste centré au lieu de « filer » à droite hors cadre quand
  // l'utilisateur avait pané/zoomé (userView). Sinon on respecte sa vue manuelle.
  if (!vibes.graph.userView || vibes._ghostNodes.length) fitView(fitPos, svg);
  else applyViewBox(svg);
  renderMinimap(pos, hiddenIds);
  // Feu d'artifice sur les nœuds qui viennent d'apparaître / d'être atteints.
  if (!REDUCED) {
    for (const id of vibes.graph.spawned) sparkleNode(svg, id, false);
    for (const id of vibes.graph.celebrated) sparkleNode(svg, id, true);
  }
}
// Tire un burst d'éclats centré sur le disque d'un nœud du graphe (une fois).
function sparkleNode(svg, id, big) {
  if (vibes.graph.fxFired.has(id)) return;
  const disc = svg.querySelector(`.g-node[data-id="${cssId(id)}"] .g-disc`);
  if (!disc) return;
  vibes.graph.fxFired.add(id);
  sparkleEl(disc, big
    ? { count: 16, dist: 64, size: 20, emojis: ["🎉", "✨", "⭐", "🏆", "💫"] }
    : { count: 10, dist: 46, emojis: ["✨", "💫", "⭐"] });
}
function fitView(pos, svg) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pos.values()) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  if (!isFinite(minX)) { minX = -200; minY = -150; maxX = 200; maxY = 150; }
  const pad = 90;
  vibes.graph.view = { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
  applyViewBox(svg);
}
function applyViewBox(svg) {
  const v = vibes.graph.view;
  svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
  updateLOD(svg);
  updateMinimapViewport();
}
// LOD : masque les labels quand les nœuds sont trop petits à l'écran (dézoom extrême).
function updateLOD(svg) {
  if (!svg) svg = $("#graphSvg");
  if (!svg) return;
  const rect = svg.getBoundingClientRect();
  const v = vibes.graph.view;
  if (!rect.width || !v.w) return;
  const pxPerSvg = rect.width / v.w; // pixels réels pour 1 unité SVG
  const smallestNodeDiameter = 24;   // r=12, le plus petit nœud
  svg.classList.toggle("lod-compact", smallestNodeDiameter * pxPerSvg < 16);
}
// Met à jour uniquement le rectangle de viewport dans la minimap (sans tout reconstruire).
function updateMinimapViewport() {
  const vp = document.getElementById("minimapViewport");
  if (!vp) return;
  const v = vibes.graph.view;
  vp.setAttribute("x", v.x); vp.setAttribute("y", v.y);
  vp.setAttribute("width", v.w); vp.setAttribute("height", v.h);
}
// Zoom clavier (+ / -) : zoom centré sur le milieu de la vue courante.
// factor < 1 = zoom avant ; factor > 1 = zoom arrière.
function zoomGraph(factor) {
  const svg = $("#graphSvg");
  if (!svg || $("#graphView").hidden) return;
  const v = vibes.graph.view;
  const cx = v.x + v.w / 2, cy = v.y + v.h / 2;
  v.w *= factor; v.h *= factor;
  v.x = cx - v.w / 2; v.y = cy - v.h / 2;
  vibes.graph.userView = true;
  applyViewBox(svg);
}
// Convertit des coords écran → coords graphe via la matrice EXACTE de l'élément
// (getScreenCTM). Indispensable avec preserveAspectRatio="meet" : le viewBox est
// mis à l'échelle UNIFORMÉMENT (avec letterbox), donc rect.width/v.w ≠ rect.height/v.h.
// Le calcul manuel par ratios indépendants décalait les coords (drag plus lent que
// le curseur sur l'axe contraint). ctm.a / ctm.d sont les échelles réelles px↔SVG.
function clientToSvg(clientX, clientY) {
  const svg = $("#graphSvg");
  const ctm = svg.getScreenCTM();
  if (ctm) {
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }
  const rect = svg.getBoundingClientRect();
  const v = vibes.graph.view;
  return { x: v.x + ((clientX - rect.left) / rect.width) * v.w, y: v.y + ((clientY - rect.top) / rect.height) * v.h };
}
// Maj live (sans rebuild) des transforms de nœuds + tracé des arêtes depuis posMap.
function liveUpdateGraphPositions() {
  const svg = $("#graphSvg");
  const pos = vibes.graph.posMap;
  svg.querySelectorAll(".g-node").forEach((g) => {
    const p = pos.get(Number(g.dataset.id));
    if (p) g.setAttribute("transform", `translate(${p.x},${p.y})`);
  });
  svg.querySelectorAll(".g-edge").forEach((ed) => {
    const pp = pos.get(Number(ed.dataset.pid)), pc = pos.get(Number(ed.dataset.cid));
    if (pp && pc) ed.setAttribute("d", edgeD(pp, pc));
  });
  const center = graphCenter(pos);
  svg.querySelectorAll(".g-req-edge").forEach((g) => {
    const from = Number(g.dataset.from), to = Number(g.dataset.to);
    const pf = pos.get(from), pt = pos.get(to);
    if (!pf || !pt) return;
    const d = reqEdgeD(pt, pf, nodeOuterR(to) + 2, nodeOuterR(from) + 9, center); // to → from (flèche sur le dépendant)
    g.querySelectorAll("path").forEach((p) => p.setAttribute("d", d));
  });
  if (vibes.graph.edgeDel) positionEdgeDel();
  if (vibes.graph.reqDel) positionReqDel();
}
// Cherche une position libre proche de (ax,ay) : décale d'un slot horizontal tant
// qu'un nœud existant est à moins de `margin` px (évite les chevauchements à la
// création via le menu fond). Borné pour ne jamais boucler indéfiniment.
function findFreePos(ax, ay, { excludeId = null, margin = 120 } = {}) {
  let x = ax;
  const y = ay;
  const occupied = [];
  for (const [id, p] of vibes.graph.posMap) if (id !== excludeId && p) occupied.push(p);
  let guard = 0;
  while (occupied.some((p) => Math.hypot(p.x - x, p.y - y) < margin) && guard++ < 200) x += G_NODE_GAP;
  return { x, y };
}
// Persiste les positions manuelles d'un ensemble d'ids (depuis posMap) + maj locale.
async function persistPositions(ids) {
  const positions = [];
  for (const id of ids) {
    const p = vibes.graph.posMap.get(id);
    if (!p) continue;
    // posMap fait foi : un nœud fraîchement créé via le menu fond n'est pas encore
    // dans byId (repeuplé par loadForest) — la maj de byId est donc « best-effort »,
    // mais la position part TOUJOURS au serveur. Exiger byId ici perdait la position.
    const n = vibes.byId.get(id);
    if (n) { n.posX = p.x; n.posY = p.y; }
    positions.push({ id, x: p.x, y: p.y });
  }
  if (!positions.length) return;
  try { await api.send("POST", "/api/nodes/positions", { positions }); }
  catch (e) { toast("Positions non enregistrées : " + e.message); }
}
// Efface la position manuelle d'un nœud → il retombe dans le tidy-layout auto.
async function resetNodePosition(id) {
  try {
    await api.send("POST", "/api/nodes/positions", { positions: [{ id, x: null, y: null }] });
    const n = vibes.byId.get(id);
    if (n) { n.posX = null; n.posY = null; }
    toast("Position réinitialisée.");
    loadForest();
  } catch (e) { toast("Échec : " + e.message); }
}

// ── Menu contextuel générique (clic droit) ───────────────────────────────────
export function hideCtxMenu() {
  const m = document.getElementById("ctxMenu");
  if (m) m.remove();
  document.removeEventListener("mousedown", _ctxOutside, true);
}
function _ctxOutside(e) { if (!e.target.closest("#ctxMenu")) hideCtxMenu(); }
export function showCtxMenu(clientX, clientY, items) {
  hideCtxMenu();
  const m = document.createElement("div");
  m.id = "ctxMenu";
  m.className = "ctx-menu";
  for (const it of items) {
    const b = document.createElement("button");
    b.className = "ctx-item" + (it.danger ? " danger" : "");
    b.textContent = it.label;
    b.addEventListener("click", () => { hideCtxMenu(); it.onClick(); });
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(clientX, window.innerWidth - r.width - 8) + "px";
  m.style.top = Math.min(clientY, window.innerHeight - r.height - 8) + "px";
  setTimeout(() => document.addEventListener("mousedown", _ctxOutside, true), 0);
}

// ── Mode « tirer un lien » (kind='child' = reparentage | 'requires' = prérequis |
//    'gate' = depuis un node d'activation, le nœud cliqué le requiert → bloqué tant
//    que le node d'activation n'est pas activé) ──
function startLinkMode(sourceId, kind = "child") {
  cancelLinkMode();
  vibes.graph.linking = sourceId;
  vibes.graph.linkKind = kind;
  const reqLike = kind === "requires" || kind === "gate";
  const line = svgEl("path", { class: "g-link-temp" + (reqLike ? " req" : ""), d: "" });
  $("#graphSvg").insertBefore(line, $("#graphSvg").firstChild);
  vibes.graph._linkLine = line;
  toast(kind === "gate"
    ? "Clique le nœud à BLOQUER (il dépendra de ce node d'activation). Échap pour annuler."
    : kind === "requires"
    ? "Clique le nœud PRÉREQUIS (ce nœud en dépendra). Échap pour annuler."
    : "Clique le nœud PARENT (auquel rattacher ce nœud comme enfant). Échap pour annuler.");
}
function cancelLinkMode() {
  vibes.graph.linking = null;
  if (vibes.graph._linkLine) { vibes.graph._linkLine.remove(); vibes.graph._linkLine = null; }
}
function updateLinkLine(clientX, clientY) {
  if (!vibes.graph._linkLine) return;
  const src = vibes.graph.posMap.get(vibes.graph.linking);
  if (!src) return;
  const t = clientToSvg(clientX, clientY);
  vibes.graph._linkLine.setAttribute("d", `M ${src.x} ${src.y} L ${t.x} ${t.y}`);
}
async function finishLink(targetId) {
  const sourceId = vibes.graph.linking;
  const kind = vibes.graph.linkKind;
  cancelLinkMode();
  if (!sourceId || targetId == null || targetId === sourceId) return;
  if (kind === "requires" || kind === "gate") {
    // requires : source dépend de target (target = prérequis).
    // gate : INVERSÉ — le node d'activation (source) bloque la cible, donc la cible
    //        devient le dépendant (from) et le node d'activation le prérequis (to).
    const fromId = kind === "gate" ? targetId : sourceId;
    const toId = kind === "gate" ? sourceId : targetId;
    try {
      await api.send("POST", "/api/nodes/links", { fromId, toId });
      toast(kind === "gate" ? "Nœud lié au node d'activation (bloqué tant qu'il n'est pas activé)." : "Prérequis ajouté.");
      loadForest();
    } catch (e) {
      toast(/cycle/i.test(e.message) ? "Impossible : créerait un cycle de prérequis." : "Échec : " + e.message);
    }
    return;
  }
  try {
    // « Rattacher comme enfant » : A (source, clic droit) devient enfant de B (target cliqué).
    await api.send("POST", `/api/nodes/${encodeURIComponent(sourceId)}/move`, { newParentId: targetId });
    vibes.graph.spawned.add(sourceId);
    toast("Lien créé.");
    loadForest();
  } catch (e) {
    toast(/cycle|sous-arbre/i.test(e.message) ? "Impossible : créerait un cycle." : "Échec : " + e.message);
  }
}
// Supprime un lien de prérequis (from dépend de to).
async function deleteReqLink(fromId, toId) {
  try {
    await api.send("DELETE", "/api/nodes/links", { fromId, toId });
    toast("Prérequis retiré.");
    loadForest();
  } catch (e) {
    toast("Échec : " + e.message);
  }
}

// ── Poubelle de suppression d'arête (double-clic sur un lien) ─────────────────
function hideEdgeDel() {
  const el = document.getElementById("gEdgeDel");
  if (el) el.remove();
  vibes.graph.edgeDel = null;
}
function positionEdgeDel() {
  const el = document.getElementById("gEdgeDel");
  const d = vibes.graph.edgeDel;
  if (!el || !d) return;
  const pp = vibes.graph.posMap.get(d.parentId), pc = vibes.graph.posMap.get(d.childId);
  if (pp && pc) el.setAttribute("transform", `translate(${(pp.x + pc.x) / 2},${(pp.y + pc.y) / 2})`);
}
function showEdgeDel(childId, parentId) {
  hideEdgeDel();
  vibes.graph.edgeDel = { childId, parentId };
  const g = svgEl("g", { id: "gEdgeDel", class: "g-edge-del" });
  g.appendChild(svgEl("circle", { r: 13 }));
  const t = svgEl("text", { "text-anchor": "middle", dy: "0.35em", "font-size": "14" });
  t.textContent = "🗑";
  g.appendChild(t);
  g.addEventListener("click", (e) => { e.stopPropagation(); deleteEdge(childId); });
  $("#graphSvg").appendChild(g);
  positionEdgeDel();
}
async function deleteEdge(childId) {
  hideEdgeDel();
  try {
    // Supprimer le lien = détacher l'enfant → il redevient une racine.
    await api.send("POST", `/api/nodes/${encodeURIComponent(childId)}/move`, { newParentId: null });
    toast("Lien supprimé (nœud détaché).");
    loadForest();
  } catch (e) {
    toast("Échec : " + e.message);
  }
}

// ── Poubelle de suppression d'un PRÉREQUIS (clic simple sur le lien) ──────────
// Un simple clic sur l'arête (hitbox large) pose un bouton 🗑 au sommet de la courbe ;
// le clic suivant retire le lien. Plus besoin de viser un trait fin au double-clic.
function hideReqDel() {
  const el = document.getElementById("gReqDel");
  if (el) el.remove();
  vibes.graph.reqDel = null;
}
function positionReqDel() {
  const el = document.getElementById("gReqDel");
  const d = vibes.graph.reqDel;
  if (!el || !d) return;
  const pf = vibes.graph.posMap.get(d.fromId), pt = vibes.graph.posMap.get(d.toId);
  if (!pf || !pt) return;
  const ap = reqApex(pf, pt, graphCenter(vibes.graph.posMap));
  el.setAttribute("transform", `translate(${ap.x},${ap.y})`);
}
function showReqDel(fromId, toId) {
  // Re-clic sur le même lien → on referme (toggle).
  if (vibes.graph.reqDel && vibes.graph.reqDel.fromId === fromId && vibes.graph.reqDel.toId === toId) {
    hideReqDel();
    return;
  }
  hideReqDel();
  vibes.graph.reqDel = { fromId, toId };
  const g = svgEl("g", { id: "gReqDel", class: "g-edge-del g-req-del" });
  g.appendChild(svgEl("circle", { r: 13 }));
  const t = svgEl("text", { "text-anchor": "middle", dy: "0.35em", "font-size": "14" });
  t.textContent = "🗑";
  g.appendChild(t);
  g.addEventListener("click", (e) => { e.stopPropagation(); hideReqDel(); deleteReqLink(fromId, toId); });
  $("#graphSvg").appendChild(g);
  positionReqDel();
}

const NODE_DRAG_THRESHOLD = 4; // px avant de basculer click → drag
function wireGraph() {
  const svg = $("#graphSvg");

  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const v = vibes.graph.view;
    const rect = svg.getBoundingClientRect();
    const mx = v.x + ((e.clientX - rect.left) / rect.width) * v.w;
    const my = v.y + ((e.clientY - rect.top) / rect.height) * v.h;
    const f = e.deltaY < 0 ? 0.88 : 1.14;
    v.w *= f; v.h *= f;
    v.x = mx - ((e.clientX - rect.left) / rect.width) * v.w;
    v.y = my - ((e.clientY - rect.top) / rect.height) * v.h;
    vibes.graph.userView = true;
    applyViewBox(svg);
  }, { passive: false });

  // ── Tactile (Android/iOS) ─────────────────────────────────────────────────
  // Sans ces handlers + `touch-action:none` (CSS), le navigateur capte le geste
  // et zoome/scrolle la PAGE au lieu du graphe. Deux doigts = pinch-zoom + pan ;
  // un doigt = pan du fond ou drag d'un nœud (comme la souris). On laisse passer
  // le clic synthétique (pas de preventDefault sur un simple tap) pour que le
  // handler `click` existant ouvre le nœud / pose la poubelle de prérequis.
  svg.addEventListener("touchstart", (e) => {
    if (vibes.graph.linking) return; // mode lien : la sélection se fait au clic
    hideCtxMenu(); hideEdgeDel(); hideReqDel();
    if (e.touches.length === 2) {
      e.preventDefault();
      vibes.graph.nodeDrag = null;
      vibes.graph.drag = null;
      const a = e.touches[0], b = e.touches[1];
      vibes.graph.pinch = {
        dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY) || 1,
        midX: (a.clientX + b.clientX) / 2,
        midY: (a.clientY + b.clientY) / 2,
      };
      return;
    }
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const gNode = e.target.closest(".g-node");
    if (gNode) {
      const id = Number(gNode.dataset.id);
      const ids = subtreeIds(id);
      const start = new Map(ids.map((i) => [i, { ...(vibes.graph.posMap.get(i) || { x: 0, y: 0 }) }]));
      vibes.graph.nodeDrag = { id, ids, start, cx: t.clientX, cy: t.clientY, moved: false, ref: gNode.dataset.ref };
    } else {
      vibes.graph.drag = { x: t.clientX, y: t.clientY, vx: vibes.graph.view.x, vy: vibes.graph.view.y };
    }
  }, { passive: false });

  svg.addEventListener("touchmove", (e) => {
    const p = vibes.graph.pinch;
    if (p && e.touches.length >= 2) {
      e.preventDefault();
      const a = e.touches[0], b = e.touches[1];
      const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY) || 1;
      const midX = (a.clientX + b.clientX) / 2, midY = (a.clientY + b.clientY) / 2;
      const rect = svg.getBoundingClientRect();
      const v = vibes.graph.view;
      const f = p.dist / dist; // doigts qui s'écartent → f<1 → zoom avant
      const ax = v.x + ((midX - rect.left) / rect.width) * v.w;
      const ay = v.y + ((midY - rect.top) / rect.height) * v.h;
      v.w *= f; v.h *= f;
      v.x = ax - ((midX - rect.left) / rect.width) * v.w;
      v.y = ay - ((midY - rect.top) / rect.height) * v.h;
      // Pan à deux doigts : translation du milieu entre les doigts.
      v.x -= ((midX - p.midX) / rect.width) * v.w;
      v.y -= ((midY - p.midY) / rect.height) * v.h;
      p.dist = dist; p.midX = midX; p.midY = midY;
      vibes.graph.userView = true;
      applyViewBox(svg);
      return;
    }
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const nd = vibes.graph.nodeDrag;
    if (nd) {
      if (!nd.moved && Math.hypot(t.clientX - nd.cx, t.clientY - nd.cy) < NODE_DRAG_THRESHOLD) return;
      e.preventDefault();
      nd.moved = true;
      const ctm = svg.getScreenCTM();
      const dx = ctm ? (t.clientX - nd.cx) / ctm.a : 0;
      const dy = ctm ? (t.clientY - nd.cy) / ctm.d : 0;
      for (const i of nd.ids) {
        const s = nd.start.get(i);
        vibes.graph.posMap.set(i, { x: s.x + dx, y: s.y + dy });
      }
      liveUpdateGraphPositions();
      return;
    }
    const d = vibes.graph.drag;
    if (!d) return;
    e.preventDefault();
    const v = vibes.graph.view;
    const ctm = svg.getScreenCTM();
    v.x = d.vx - (ctm ? (t.clientX - d.x) / ctm.a : 0);
    v.y = d.vy - (ctm ? (t.clientY - d.y) / ctm.d : 0);
    vibes.graph.userView = true;
    applyViewBox(svg);
  }, { passive: false });

  svg.addEventListener("touchend", (e) => {
    if (vibes.graph.pinch && e.touches.length < 2) vibes.graph.pinch = null;
    const nd = vibes.graph.nodeDrag;
    if (nd && nd.moved) {
      vibes.graph.userView = true;     // on ne re-fit pas après un placement manuel
      vibes.graph.suppressClick = true; // évite l'ouverture via le clic synthétique
      persistPositions(nd.ids);
    }
    if (e.touches.length === 0) { vibes.graph.nodeDrag = null; vibes.graph.drag = null; }
  });

  // mousedown : démarre soit un drag de nœud (sur un nœud), soit un pan (sur le fond).
  svg.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return; // gauche uniquement (le clic droit → contextmenu)
    if (vibes.graph.linking) return; // en mode lien : la sélection se fait au click
    if (e.target.closest("#gEdgeDel") || e.target.closest("#gReqDel")) return; // poubelle : géré par son handler
    if (e.target.closest(".g-req-edge")) return; // clic sur un lien de prérequis : géré au click (poubelle)
    hideCtxMenu();
    hideEdgeDel();
    hideReqDel();
    const gNode = e.target.closest(".g-node");
    if (gNode) {
      const id = Number(gNode.dataset.id);
      const ids = subtreeIds(id);
      const start = new Map(ids.map((i) => [i, { ...(vibes.graph.posMap.get(i) || { x: 0, y: 0 }) }]));
      vibes.graph.nodeDrag = { id, ids, start, cx: e.clientX, cy: e.clientY, moved: false, ref: gNode.dataset.ref };
    } else {
      vibes.graph.drag = { x: e.clientX, y: e.clientY, vx: vibes.graph.view.x, vy: vibes.graph.view.y };
    }
  });

  window.addEventListener("mousemove", (e) => {
    if (vibes.graph.linking) { updateLinkLine(e.clientX, e.clientY); return; }
    const nd = vibes.graph.nodeDrag;
    if (nd) {
      if (!nd.moved && Math.hypot(e.clientX - nd.cx, e.clientY - nd.cy) < NODE_DRAG_THRESHOLD) return;
      nd.moved = true;
      svg.style.cursor = "grabbing";
      // Delta écran → SVG via les échelles RÉELLES (ctm.a/ctm.d). Avec un scaling
      // uniforme (preserveAspectRatio="meet"), diviser par rect.width/v.w sur l'axe
      // contraint sous-estimait le déplacement → le nœud « traînait » derrière le curseur.
      const ctm = svg.getScreenCTM();
      const dx = ctm ? (e.clientX - nd.cx) / ctm.a : 0;
      const dy = ctm ? (e.clientY - nd.cy) / ctm.d : 0;
      for (const i of nd.ids) {
        const s = nd.start.get(i);
        vibes.graph.posMap.set(i, { x: s.x + dx, y: s.y + dy });
      }
      liveUpdateGraphPositions();
      return;
    }
    const d = vibes.graph.drag;
    if (!d) return;
    const v = vibes.graph.view;
    // Même correction d'échelle réelle pour le pan du fond (ctm.a/ctm.d).
    const ctm = svg.getScreenCTM();
    v.x = d.vx - (ctm ? (e.clientX - d.x) / ctm.a : 0);
    v.y = d.vy - (ctm ? (e.clientY - d.y) / ctm.d : 0);
    vibes.graph.userView = true;
    applyViewBox(svg);
  });

  window.addEventListener("mouseup", () => {
    const nd = vibes.graph.nodeDrag;
    if (nd && nd.moved) {
      vibes.graph.userView = true;   // on ne re-fit pas la vue après un placement manuel
      vibes.graph.suppressClick = true; // empêche l'ouverture du nœud juste après le drag
      persistPositions(nd.ids);
      svg.style.cursor = "";
    }
    vibes.graph.nodeDrag = null;
    vibes.graph.drag = null;
  });

  // click : ouvre un nœud, finalise un lien, ou pose la poubelle sur un prérequis.
  svg.addEventListener("click", (e) => {
    if (vibes.graph.suppressClick) { vibes.graph.suppressClick = false; return; }
    const gNode = e.target.closest(".g-node");
    if (vibes.graph.linking) {
      if (gNode) finishLink(Number(gNode.dataset.id));
      else cancelLinkMode();
      return;
    }
    if (gNode) { openNode(gNode.dataset.ref); return; }
    const req = e.target.closest(".g-req-edge");
    if (req) { showReqDel(Number(req.dataset.from), Number(req.dataset.to)); return; }
  });

  // double-clic sur une arête de hiérarchie → poubelle de détachement.
  svg.addEventListener("dblclick", (e) => {
    const edge = e.target.closest(".g-edge");
    if (edge) { e.preventDefault(); showEdgeDel(Number(edge.dataset.cid), Number(edge.dataset.pid)); }
  });

  // clic droit : menu contextuel selon la cible (nœud / arête / fond).
  svg.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (vibes.graph.linking) { cancelLinkMode(); return; }
    const gNode = e.target.closest(".g-node");
    if (gNode) {
      const id = Number(gNode.dataset.id);
      const ref = gNode.dataset.ref;
      const node = vibes.byId.get(id);
      const isAct = node && node.kind === "activation";
      const items = [];
      if (isAct) {
        // Node d'activation : activer/désactiver (porte) + lier un nœud à bloquer.
        const on = node.status === "done";
        items.push({ label: on ? "⚡ Désactiver (rebloquer)" : "⚡ Activer (débloquer la séquence)", onClick: () => toggleActivation(id) });
        items.push({ label: "🔌 Bloquer un nœud (le lier)…", onClick: () => startLinkMode(id, "gate") });
      } else {
        items.push({ label: "🔒 Marquer un prérequis…", onClick: () => startLinkMode(id, "requires") });
        items.push({ label: "🔗 Rattacher comme enfant…", onClick: () => startLinkMode(id, "child") });
        items.push({ label: "⚡ Convertir en node d'activation", onClick: () => convertToActivation(id) });
      }
      if (node && node.posX != null && node.posY != null) {
        items.push({ label: "📌 Réinitialiser la position", onClick: () => resetNodePosition(id) });
      }
      items.push({ label: "✎ Ouvrir", onClick: () => openNode(ref) });
      items.push({ label: "🗑 Supprimer", danger: true, onClick: () => { if (confirm("Supprimer ce nœud et tout son sous-arbre ?")) deleteNodeById(id); } });
      showCtxMenu(e.clientX, e.clientY, items);
      return;
    }
    const req = e.target.closest(".g-req-edge");
    if (req) {
      showCtxMenu(e.clientX, e.clientY, [
        { label: "🗑 Retirer le prérequis", danger: true, onClick: () => deleteReqLink(Number(req.dataset.from), Number(req.dataset.to)) },
      ]);
      return;
    }
    const edge = e.target.closest(".g-edge");
    if (edge) {
      showCtxMenu(e.clientX, e.clientY, [
        { label: "🗑 Supprimer le lien", danger: true, onClick: () => deleteEdge(Number(edge.dataset.cid)) },
      ]);
      return;
    }
    // Fond : créer un nouveau nœud à cet endroit (objectif normal ou node d'activation).
    const at = clientToSvg(e.clientX, e.clientY);
    showCtxMenu(e.clientX, e.clientY, [
      { label: "➕ Nouvel objectif ici", onClick: () => { vibes.graph.pendingCreatePos = at; vibes._createKind = null; openNodeModal(null, null); } },
      { label: "⚡ Node d'activation ici", onClick: () => { vibes.graph.pendingCreatePos = at; vibes._createKind = "activation"; openNodeModal(null, null); } },
    ]);
  });

  $("#graphFit").addEventListener("click", () => {
    vibes.graph.userView = false;
    renderGraph();
  });

  // Boutons de filtre par statut : toggle actif/masqué, re-rendu du graphe.
  document.querySelectorAll(".graph-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const s = btn.dataset.status;
      if (vibes.graph.hiddenStatuses.has(s)) {
        vibes.graph.hiddenStatuses.delete(s);
        btn.classList.add("active");
      } else {
        vibes.graph.hiddenStatuses.add(s);
        btn.classList.remove("active");
      }
      vibes.graph.userView = true; // préserver le zoom/pan courant après le filtre
      renderGraph();
    });
  });

  // Zoom au clavier : + (ou =) zoom avant, - (ou _) zoom arrière. Actif seulement
  // en vue graphe et hors saisie dans un champ.
  document.addEventListener("keydown", (e) => {
    if ($("#graphView").hidden) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomGraph(0.85); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomGraph(1 / 0.85); }
  });
}

// ── Vue détail d'un nœud ─────────────────────────────────────────────────────
function nodeUrl(suffix) {
  return `/api/nodes/${encodeURIComponent(vibes.current)}${suffix || ""}`;
}
async function openNode(refOrId) {
  try {
    closeStream();
    const node = await api.get(`/api/nodes/${encodeURIComponent(refOrId)}?tree=true&messages=true`);
    // On accepte un code (NODE-1) OU un id numérique (chips du chat) ; l'état
    // interne s'aligne toujours sur le vrai code renvoyé par l'API.
    const ref = node.ref;
    vibes.current = ref;
    vibes.currentNode = node;
    vibes.currentVersion = node.version;
    vibes.chat = NODE_CHAT_CTX; // chat actif = ce nœud
    NODE_CHAT_CTX.sessionId = 0; // nouveau nœud → conversation par défaut (node.messages)
    setForestChatVisible(false);
    $("#vibesBar").hidden = true;
    $("#vibesView").hidden = true;
    $("#graphView").hidden = true;
    $("#nodeView").hidden = false;
    $("#modelSel").value = vibes.model;
    // Nouveau contexte d'arbre : snapshot vierge → premier rendu en cascade (sans éclats).
    vibes._treeSnap = new Map();
    vibes._treeInitial = true;
    vibes._notesEditing = false; // pas d'édition de notes héritée d'un autre nœud
    vibes._notesOpen = new Set(); // état plié/déplié des notes propre à ce nœud
    vibes._ghostKids = []; // pas de fantômes hérités d'un autre nœud
    vibes._ghostNodes = []; // ni de fantômes de la forêt (on quitte la vue objectifs)
    renderNodeHeader(node);
    renderTree(node);
    renderChat(node.messages || []);
    loadSessions(); // peuple le sélecteur de conversations du nœud
    subscribeNode(ref);
  } catch (e) {
    toast("Erreur : " + e.message);
  }
}

// Pont depuis la vue Suivi : bascule sur Vibes et ouvre directement le nœud. On NE
// touche PAS au hash (sinon le handler `hashchange` rappellerait switchView → forêt,
// écrasant le détail) ; on réplique donc à la main le basculement de vue de switchView.
export async function openNodeInVibes(refOrId) {
  vibes.view = "vibes";
  document.body.classList.remove("view-track", "view-vibes", "view-repo", "issue-open");
  document.body.classList.add("view-vibes");
  document.querySelectorAll(".nav-tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.view === "vibes"));
  $("#trackView").hidden = true;
  $("#repoView").hidden = true;
  await openNode(refOrId);
}

function renderNodeHeader(n) {
  $("#ndEmoji").textContent = n.emoji || "🎯";
  $("#ndTitle").textContent = n.title;
  $("#ndRef").textContent = n.ref;
  const stEl = $("#ndStatus");
  stEl.textContent = NODE_STATUS_LABEL[n.status] || n.status;
  stEl.className = "badge status-" + n.status; // colore le badge selon le statut (ex. waiting)
  $("#ndBar").style.width = n.progress + "%";
  $("#ndPct").textContent = n.progress + "%";
  const desc = $("#ndDesc");
  desc.textContent = n.description || "";
  desc.hidden = !n.description;
  const blk = $("#ndBlocked");
  if (blk) blk.hidden = !isNodeBlocked(n);
  // Panneau « node d'activation » : porte manuelle. Visible si kind='activation'.
  const act = $("#ndActivation");
  if (act) {
    const isAct = n.kind === "activation";
    act.hidden = !isAct;
    if (isAct) {
      const on = n.status === "done";
      act.classList.toggle("on", on);
      const st = $("#ndActState");
      if (st) st.textContent = on ? "⚡ Activé — les nœuds liés sont débloqués." : "⏸ Inactif — les nœuds liés sont bloqués.";
      const btn = $("#ndActToggle");
      if (btn) btn.textContent = on ? "Désactiver (rebloquer)" : "Activer (débloquer la séquence)";
    }
  }
  // Panneau « en attente d'info » : visible uniquement au statut waiting.
  const pend = $("#ndPending");
  if (pend) {
    const waiting = n.status === "waiting";
    pend.hidden = !waiting;
    if (waiting) {
      const body = $("#ndPendingBody");
      if (body) body.innerHTML = n.pendingInfo
        ? renderMarkdown(n.pendingInfo)
        : '<span class="hint">(aucun détail fourni sur l\'info attendue)</span>';
    }
  }
  renderNotes(n);
  renderLinks(n);
  renderNodeIssues(n);
}

// ── Suivis liés (vue détail) : entrées de suivi rattachées à ce jalon ─────────
// Données fournies par getNode(withIssues). Chaque puce ouvre l'entrée dans Suivi.
const ISSUE_TYPE_ICON = { bug: "🐞", feature: "✨", task: "✅", chore: "🧹" };
const ISSUE_STATUS_LABEL = { open: "Ouvert", in_progress: "En cours", done: "Fait", wontfix: "Abandonné" };
function renderNodeIssues(n) {
  const view = $("#ndIssuesView");
  if (!view) return;
  const issues = Array.isArray(n.issues) ? n.issues : [];
  if (!issues.length) {
    view.innerHTML = '<span class="hint">Aucun suivi lié. Clique « ＋ Suivi » pour créer une entrée rattachée à ce jalon.</span>';
    return;
  }
  view.innerHTML = `<div class="nd-issue-chips">${issues
    .map(
      (i) => `<button class="issue-chip status-${esc(i.status)}" data-ref="${esc(i.ref)}" title="${esc(i.title)}">
        <span class="ic-type">${ISSUE_TYPE_ICON[i.type] || "•"}</span>
        <span class="ic-code">${esc(i.ref)}</span>
        <span class="ic-title">${esc(i.title)}</span>
        <span class="ic-status">${ISSUE_STATUS_LABEL[i.status] || esc(i.status)}</span>
      </button>`
    )
    .join("")}</div>`;
  view.querySelectorAll(".issue-chip[data-ref]").forEach((b) =>
    b.addEventListener("click", () => openIssueInTrack(b.dataset.ref))
  );
}

// ── Liens de prérequis (vue détail) ──────────────────────────────────────────
// Affiche « Dépend de » (requires, avec retrait + état) et « Requis par »
// (requiredBy, lecture seule). Données fournies par getNode(withLinks).
function linkChipHtml(l, removable) {
  const done = l.status === "done";
  const cls = "link-chip" + (done ? " done" : " pending");
  const rm = removable ? `<button class="link-chip-del" title="Retirer ce prérequis" data-to="${l.id}">✕</button>` : "";
  return `<span class="${cls}" data-ref="${esc(l.ref)}" title="${esc(l.title)} · ${l.progress}%">
    <span class="link-chip-emoji">${esc(l.emoji || "🎯")}</span>
    <span class="link-chip-title">${esc(l.title)}</span>
    <span class="link-chip-pct">${l.progress}%</span>${rm}</span>`;
}
function renderLinks(n) {
  const view = $("#ndLinksView");
  if (!view) return;
  const requires = Array.isArray(n.requires) ? n.requires : [];
  const requiredBy = Array.isArray(n.requiredBy) ? n.requiredBy : [];
  let html = "";
  if (requires.length) {
    html += `<div class="link-group"><span class="link-label">Dépend de</span><div class="link-chips">${requires.map((l) => linkChipHtml(l, true)).join("")}</div></div>`;
  }
  if (requiredBy.length) {
    html += `<div class="link-group"><span class="link-label">Requis par</span><div class="link-chips">${requiredBy.map((l) => linkChipHtml(l, false)).join("")}</div></div>`;
  }
  if (!html) html = '<span class="hint">Aucun prérequis. Clique « ＋ Prérequis » pour relier ce nœud à un autre dont il dépend.</span>';
  view.innerHTML = html;
  // Ouvre le nœud d'un chip au clic ; ✕ retire le lien (depuis le nœud courant).
  view.querySelectorAll(".link-chip[data-ref]").forEach((chip) =>
    chip.addEventListener("click", (e) => {
      if (e.target.closest(".link-chip-del")) return;
      openNode(chip.dataset.ref);
    })
  );
  view.querySelectorAll(".link-chip-del").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const toId = Number(e.currentTarget.dataset.to);
      if (vibes.currentNode) removeReqFromDetail(vibes.currentNode.id, toId);
    })
  );
}
// Retrait d'un prérequis depuis la vue détail (rafraîchit le nœud courant).
async function removeReqFromDetail(fromId, toId) {
  try {
    await api.send("DELETE", "/api/nodes/links", { fromId, toId });
    toast("Prérequis retiré.");
    refreshCurrentNode();
  } catch (e) {
    toast("Échec : " + e.message);
  }
}
// Picker « ＋ Prérequis » : liste les nœuds candidats (forêt du repo, hors soi-même
// et hors prérequis déjà posés) dans un menu contextuel. Le serveur refuse les cycles.
async function openReqPicker(clientX, clientY) {
  const cur = vibes.currentNode;
  if (!cur) return;
  let forest;
  try {
    forest = await api.get("/api/nodes?view=forest");
  } catch (e) {
    toast("Échec du chargement : " + e.message);
    return;
  }
  const already = new Set((cur.requires || []).map((l) => l.id));
  const candidates = forest.filter((n) => n.id !== cur.id && !already.has(n.id));
  if (!candidates.length) { toast("Aucun autre nœud disponible."); return; }
  showCtxMenu(clientX, clientY, candidates.slice(0, 50).map((n) => ({
    label: `${n.emoji || "🎯"} ${n.title}`,
    onClick: () => addReqFromDetail(cur.id, n.id),
  })));
}
async function addReqFromDetail(fromId, toId) {
  try {
    await api.send("POST", "/api/nodes/links", { fromId, toId });
    toast("Prérequis ajouté.");
    refreshCurrentNode();
  } catch (e) {
    toast(/cycle/i.test(e.message) ? "Impossible : créerait un cycle de prérequis." : "Échec : " + e.message);
  }
}
// Re-fetch du nœud courant (liens inclus) — après ajout/retrait de prérequis.
async function refreshCurrentNode() {
  if (!vibes.current) return;
  try {
    const node = await api.get(nodeUrl("?tree=true"));
    vibes.currentNode = node;
    vibes.currentVersion = node.version;
    renderNodeHeader(node);
    renderTree(node);
  } catch { /* ignore */ }
}

// ── Notes markdown : liste de sections collapsables (lecture + édition) ────────
// notes = [{title, body}]. Vue : un <details> par note. Édition : liste dynamique.
function notesOf(n) {
  return Array.isArray(n && n.notes) ? n.notes : [];
}
// Mémorise l'état plié/déplié par index (réinitialisé au changement de nœud).
function renderNotes(n) {
  if (vibes._notesEditing) return; // édition en cours : ne pas écraser
  const view = $("#ndNotesView");
  if (!view) return;
  const notes = notesOf(n);
  view.hidden = false;
  $("#ndNotesEditor").hidden = true;
  $("#ndNotesEditBtn").hidden = false;
  if (!notes.length) {
    view.classList.add("empty");
    view.innerHTML = '<span class="hint">Aucune note. Clique « ✎ Éditer » ou demande à Claude d\'en rédiger.</span>';
    return;
  }
  view.classList.remove("empty");
  const open = vibes._notesOpen || new Set();
  view.innerHTML = notes
    .map((note, i) => {
      const title = (note.title || "").trim() || `Note ${i + 1}`;
      const isOpen = open.size ? open.has(i) : false; // tout replié par défaut
      return `<details class="note-item"${isOpen ? " open" : ""} data-i="${i}">
        <summary class="note-summary"><span class="note-title">${esc(title)}</span></summary>
        <div class="note-body markdown-body">${renderMarkdown(note.body) || '<span class="hint">(vide)</span>'}</div>
      </details>`;
    })
    .join("");
  // Suit l'état plié/déplié (persisté en mémoire le temps de la session du nœud).
  view.querySelectorAll(".note-item").forEach((d) =>
    d.addEventListener("toggle", () => {
      vibes._notesOpen = vibes._notesOpen || new Set();
      const i = Number(d.dataset.i);
      if (d.open) vibes._notesOpen.add(i);
      else vibes._notesOpen.delete(i);
    })
  );
}

// Construit un éditeur pour une note (titre + corps markdown + aperçu live + @).
function buildNoteEditor(note) {
  const row = document.createElement("div");
  row.className = "note-editor";
  row.innerHTML = `
    <div class="note-editor-head">
      <input type="text" class="note-edit-title" placeholder="Titre de la note (optionnel)" />
      <button type="button" class="ghost danger note-edit-del" title="Supprimer cette note">🗑</button>
    </div>
    <div class="ta-wrap">
      <textarea class="note-edit-body" rows="6" placeholder="Markdown : # Titre, **gras**, - listes, | tableaux |, > citation, @chemin/fichier…"></textarea>
      <ul class="mention-menu" hidden></ul>
    </div>
    <details class="note-edit-preview"><summary>👁 Aperçu</summary><div class="markdown-body note-edit-preview-body"></div></details>`;
  const titleEl = row.querySelector(".note-edit-title");
  const bodyEl = row.querySelector(".note-edit-body");
  const menuEl = row.querySelector(".mention-menu");
  const prevEl = row.querySelector(".note-edit-preview-body");
  titleEl.value = (note && note.title) || "";
  bodyEl.value = (note && note.body) || "";
  const preview = () => { prevEl.innerHTML = renderMarkdown(bodyEl.value) || '<span class="hint">(aperçu vide)</span>'; };
  preview();
  bodyEl.addEventListener("input", () => { preview(); handleMentionInput(bodyEl, menuEl, state.branch || "", preview); });
  bodyEl.addEventListener("blur", () => setTimeout(() => hideMenu(menuEl), 150));
  bodyEl.addEventListener("keydown", (e) => {
    if (menuKeydown(menuEl, e)) return;
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); saveNotes(); }
  });
  row.querySelector(".note-edit-del").addEventListener("click", () => row.remove());
  return row;
}
function addNoteEditor(note) {
  $("#ndNotesList").appendChild(buildNoteEditor(note || { title: "", body: "" }));
}
function collectNotesFromEditor() {
  return [...$("#ndNotesList").querySelectorAll(".note-editor")]
    .map((row) => ({
      title: row.querySelector(".note-edit-title").value.trim(),
      body: row.querySelector(".note-edit-body").value,
    }))
    .filter((n) => n.title || n.body.trim());
}
function openNotesEditor() {
  if (!vibes.currentNode) return;
  vibes._notesEditing = true;
  vibes._notesBaseVersion = vibes.currentNode.version; // pivot CAS figé au début de l'édition
  const list = $("#ndNotesList");
  list.innerHTML = "";
  const notes = notesOf(vibes.currentNode);
  if (notes.length) notes.forEach(addNoteEditor);
  else addNoteEditor({ title: "", body: "" }); // une note vide pour démarrer
  $("#ndNotesView").hidden = true;
  $("#ndNotesEditBtn").hidden = true;
  $("#ndNotesEditor").hidden = false;
  const first = list.querySelector(".note-edit-body");
  if (first) first.focus();
}
function closeNotesEditor() {
  vibes._notesEditing = false;
  renderNotes(vibes.currentNode);
}
async function saveNotes() {
  if (!vibes.current) return;
  const notes = collectNotesFromEditor();
  const payload = { notes };
  if (vibes._notesBaseVersion != null) payload.expectedVersion = vibes._notesBaseVersion;
  try {
    const n = await api.send("PATCH", `/api/nodes/${encodeURIComponent(vibes.current)}`, payload);
    vibes._notesEditing = false;
    applyNodeUpdate(n); // met à jour currentNode + header → renderNotes
    scheduleSubtreeRefetch();
    toast("Notes enregistrées.");
  } catch (e) {
    if (/version_conflict/.test(e.message)) toast("Nœud modifié entre-temps — rouvre-le pour repartir de la version à jour.");
    else toast("Échec : " + e.message);
  }
}
// Petit « waouh » quand les notes changent à distance (ex : le bot vient d'écrire).
function flashNotes() {
  const el = $("#ndNotes");
  if (!el || REDUCED) return;
  el.classList.remove("fx-note");
  void el.offsetWidth; // reflow → rejoue l'animation
  el.classList.add("fx-note");
  sparkleEl($("#ndNotesView"), { oy: 24, count: 8, dist: 36, emojis: ["📝", "✨", "💫"] });
}
// Signature d'un nœud pour le diff visuel (champs qui méritent une animation).
function nodeSig(n) {
  return `${n.status}|${n.progress}|${n.title}|${n.emoji || ""}|${n.color || ""}`;
}
// Compare l'arbre courant au snapshot précédent → Map(id → {cls, si}) :
//   fx-new (apparu), fx-done (vient d'être atteint), fx-changed (autre modif).
// `si` est l'ordre d'apparition (stagger) parmi les seuls nœuds animés.
function computeTreeFx(node) {
  const fx = new Map();
  const next = new Map();
  const prev = vibes._treeSnap || new Map();
  let order = 0;
  const walk = (n) => {
    const sig = nodeSig(n);
    next.set(n.id, sig);
    const before = prev.get(n.id);
    if (before === undefined) fx.set(n.id, { cls: "fx-new", si: order++ });
    else if (before !== sig) {
      const wasDone = before.split("|")[0] === "done";
      fx.set(n.id, { cls: !wasDone && n.status === "done" ? "fx-done" : "fx-changed", si: order++ });
    }
    (n.children || []).forEach(walk);
  };
  (node.children || []).forEach(walk);
  vibes._treeSnap = next;
  return fx;
}
// Arbre récursif des sous-nœuds (chaque ligne ouvre son propre chat).
function treeHtml(n, depth, fx) {
  const kids = n.children || [];
  const childrenHtml = kids.map((k) => treeHtml(k, depth + 1, fx)).join("");
  const f = fx.get(n.id);
  const fxCls = f ? " " + f.cls : "";
  const si = f ? f.si : 0;
  const liCls = "tnode" + (vibes.graph.despawning.has(n.id) ? " despawn" : "");
  return `<li class="${liCls}" data-ref="${esc(n.ref)}" data-id="${n.id}" style="--d:${depth}">
    <div class="trow ms-${esc(n.status)}${fxCls}" style="--si:${si}">
      <span class="tdot" style="background:var(--${esc(n.color || "accent")})"></span>
      <span class="temoji">${esc(n.emoji || "🎯")}</span>
      <span class="ttitle" title="Ouvrir le chat de ce nœud">${esc(n.title)}</span>
      <span class="tpct">${n.progress}%</span>
      <select class="tstatus" title="Statut">${["active", "paused", "waiting", "done", "abandoned"].map((s) => `<option value="${s}" ${s === n.status ? "selected" : ""}>${esc(NODE_STATUS_LABEL[s])}</option>`).join("")}</select>
      <button class="tadd" title="Ajouter un sous-jalon">＋</button>
      <button class="tdel danger" title="Supprimer">🗑</button>
    </div>
    ${childrenHtml ? `<ul class="tchildren">${childrenHtml}</ul>` : ""}
  </li>`;
}
function renderTree(node) {
  const wrap = $("#nodeTree");
  const kids = node.children || [];
  const fx = computeTreeFx(node);
  wrap.innerHTML = kids.length
    ? `<ul class="tree-root">${kids.map((k) => treeHtml(k, 0, fx)).join("")}</ul>`
    : `<div class="empty">Aucun sous-jalon. Ajoute-en un, ou demande à Claude.</div>`;
  // Éclats sur les jalons ajoutés / atteints en live (pas au tout premier rendu = cascade silencieuse).
  if (!REDUCED && !vibes._treeInitial) {
    wrap.querySelectorAll(".trow.fx-new, .trow.fx-done").forEach((row) => {
      const done = row.classList.contains("fx-done");
      sparkleEl(row, { ox: 28, count: done ? 12 : 6, dist: done ? 42 : 30, emojis: done ? ["🎉", "✨", "🏆", "⭐"] : ["✨", "💫"] });
    });
  }
  vibes._treeInitial = false;
  wrap.querySelectorAll(".tnode").forEach((li) => {
    const ref = li.dataset.ref;
    const id = Number(li.dataset.id);
    const row = li.querySelector(":scope > .trow");
    row.querySelector(".ttitle").addEventListener("click", () => openNode(ref));
    row.querySelector(".tstatus").addEventListener("change", (e) => patchNode(id, { status: e.target.value }));
    row.querySelector(".tadd").addEventListener("click", () => openNodeModal(null, id));
    row.querySelector(".tdel").addEventListener("click", () => {
      if (confirm("Supprimer ce nœud et tout son sous-arbre ?")) deleteNodeById(id);
    });
  });
}

// ── Nœuds fantômes : aperçu des sous-nœuds que l'IA est en train de créer ─────
// Reçus via SSE (node:ghost) pendant un tour, AVANT persistance. Rendus en bas de
// l'arbre détail, puis remplacés par les vrais nœuds au refetch de fin de tour.
function applyGhostDetail(d) {
  if (!d || !d.key || !vibes.current) return;
  const gh = {
    key: String(d.key),
    title: d.title || "…",
    emoji: d.emoji || "✨",
    status: d.status || "active",
  };
  const i = vibes._ghostKids.findIndex((g) => g.key === gh.key);
  if (i >= 0) vibes._ghostKids[i] = gh;
  else vibes._ghostKids.push(gh);
  paintGhostKids();
}
function clearGhostsDetail() {
  if (!vibes._ghostKids.length) return;
  vibes._ghostKids = [];
  // Si un refetch d'arbre est déjà programmé (les vrais nœuds arrivent), on laisse
  // renderTree remplacer les fantômes → pas de clignotement « disparition/réapparition ».
  if (vibes.dirtyTimer) return;
  paintGhostKids();
}
function paintGhostKids() {
  const wrap = $("#nodeTree");
  if (!wrap) return;
  wrap.querySelectorAll(".tghost").forEach((el) => el.remove());
  if (!vibes._ghostKids.length) return;
  let ul = wrap.querySelector(".tree-root");
  if (!ul) {
    const empty = wrap.querySelector(".empty");
    if (empty) empty.remove();
    ul = document.createElement("ul");
    ul.className = "tree-root";
    wrap.appendChild(ul);
  }
  for (const gh of vibes._ghostKids) {
    const li = document.createElement("li");
    li.className = "tghost"; // volontairement PAS .tnode (pas d'écouteurs/contrôles)
    const row = document.createElement("div");
    row.className = "trow tghost-row ms-" + gh.status;
    const emo = document.createElement("span");
    emo.className = "temoji";
    emo.textContent = gh.emoji;
    const ttl = document.createElement("span");
    ttl.className = "ttitle";
    ttl.textContent = gh.title; // textContent → anti-XSS (jamais d'innerHTML de données IA)
    const spin = document.createElement("span");
    spin.className = "tghost-spin";
    spin.textContent = "⏳";
    row.append(emo, ttl, spin);
    li.appendChild(row);
    ul.appendChild(li);
  }
}

// Fantômes du chat « top level » : nœuds non persistés diffusés (node:ghost) sur le
// canal forêt pendant un tour. Rendus en aperçu dans le graphe ET la grille, puis
// remplacés par les vrais nœuds (node:updated / rechargement) en fin de tour.
function applyGhostForest(d) {
  if (!d || !d.key) return;
  // Premier fantôme du tour → on abandonne la vue manuelle figée pour recadrer la
  // création (et le résultat final reste cadré aussi, une fois les fantômes remplacés).
  if (!vibes._ghostNodes.length) vibes.graph.userView = false;
  const gh = {
    key: String(d.key),
    title: d.title || "…",
    emoji: d.emoji || "✨",
    status: d.status || "active",
    parentId: d.parentId != null ? Number(d.parentId) : null,
    parentKey: d.parentKey != null ? String(d.parentKey) : null,
  };
  const i = vibes._ghostNodes.findIndex((g) => g.key === gh.key);
  if (i >= 0) vibes._ghostNodes[i] = gh;
  else vibes._ghostNodes.push(gh);
  renderForestSoon();
}
function clearGhostsForest() {
  if (!vibes._ghostNodes.length) return;
  vibes._ghostNodes = [];
  renderForestSoon();
}

// Réconcilie le nœud courant reçu en live (par version monotone) + re-fetch arbre.
function applyNodeUpdate(n) {
  if (!n || !vibes.current) return;
  if (vibes.currentNode && n.id === vibes.currentNode.id) {
    if (vibes.currentVersion != null && n.version != null && n.version < vibes.currentVersion) return;
    const notesChanged = !vibes._notesEditing && n.notes != null && JSON.stringify(vibes.currentNode.notes || []) !== JSON.stringify(n.notes || []);
    vibes.currentVersion = n.version;
    Object.assign(vibes.currentNode, n);
    renderNodeHeader(vibes.currentNode);
    if (notesChanged) flashNotes(); // ex : le bot vient d'écrire les notes
  }
}
function scheduleSubtreeRefetch() {
  clearTimeout(vibes.dirtyTimer);
  vibes.dirtyTimer = setTimeout(async () => {
    if (!vibes.current) return;
    if (vibes.graph.despawning.size) return; // anim de suppression en cours : le refetch final est rejoué après
    try {
      const node = await api.get(nodeUrl("?tree=true"));
      vibes.currentNode = node;
      vibes.currentVersion = node.version;
      renderNodeHeader(node);
      renderTree(node);
    } catch {
      /* ignore */
    }
  }, 250);
}

async function patchNode(id, fields) {
  try {
    const ref = (vibes.byId.get(id) || {}).ref || id;
    const n = await api.send("PATCH", `/api/nodes/${encodeURIComponent(ref)}`, fields);
    applyNodeUpdate(n);
    scheduleSubtreeRefetch();
  } catch (e) {
    toast(e.message);
  }
}
// waiting → active : le nœud redevient implémentable (le data layer efface pending_info).
async function markNodeReady(id) {
  await patchNode(id, { status: "active" });
}
// PATCH un nœud par son ref puis recharge la forêt (rendu graphe + états « bloqué » des
// dépendants). Utilisé par les actions du node d'activation depuis le graphe.
async function patchNodeAndReload(id, fields) {
  try {
    const ref = (vibes.byId.get(id) || {}).ref || id;
    await api.send("PATCH", `/api/nodes/${encodeURIComponent(ref)}`, fields);
    loadForest();
  } catch (e) {
    toast("Échec : " + e.message);
  }
}
// Active / désactive un node d'activation : « activé » = status 'done' (débloque les nœuds
// qui le requièrent) ; « inactif » = status 'active' (les rebloque). En détail on rafraîchit
// le nœud ouvert ; depuis le graphe on recharge la forêt (états « bloqué » des dépendants).
async function toggleActivation(id) {
  const n = (vibes.currentNode && vibes.currentNode.id === id ? vibes.currentNode : null) || vibes.byId.get(id);
  if (!n) return;
  const next = n.status === "done" ? "active" : "done";
  if (vibes.current) await patchNode(id, { status: next });
  else await patchNodeAndReload(id, { status: next });
  toast(next === "done" ? "⚡ Activé — séquence débloquée." : "⚡ Désactivé — séquence rebloquée.");
}
// Convertit un nœud normal en node d'activation (porte de prérequis manuelle).
async function convertToActivation(id) {
  if (vibes.current) await patchNode(id, { kind: "activation" });
  else await patchNodeAndReload(id, { kind: "activation" });
  toast("Converti en node d'activation ⚡.");
}
async function deleteNodeById(id) {
  try {
    const ref = (vibes.byId.get(id) || {}).ref || id;
    await api.send("DELETE", `/api/nodes/${encodeURIComponent(ref)}`);
    if (vibes.currentNode && id === vibes.currentNode.id) {
      // on a supprimé le nœud courant → remonter à la forêt
      backToForest();
    } else scheduleSubtreeRefetch();
  } catch (e) {
    toast(e.message);
  }
}
async function deleteCurrentNode() {
  if (!vibes.currentNode) return;
  if (!confirm(`Supprimer ${vibes.currentNode.ref} et tout son sous-arbre ?`)) return;
  await deleteNodeById(vibes.currentNode.id);
}
function backToForest() {
  closeStream();
  vibes.current = null;
  vibes.currentNode = null;
  vibes._ghostNodes = []; // pas de fantômes hérités (turn antérieur / autre vue)
  vibes.chat = FOREST_CHAT_CTX; // chat actif = forêt
  $("#nodeView").hidden = true;
  $("#vibesBar").hidden = false;
  applyLayoutToggle();
  setForestChatVisible(true);
  loadForest();
  subscribeForest();
  loadForestChat();
}

// ── Chat streaming ───────────────────────────────────────────────────────────
function opLabel(o) {
  switch (o.op) {
    case "set_node_fields":
    case "update_node": return "✎ nœud" + (o.id ? " #" + o.id : "");
    case "add_node": return "➕ " + (o.title || "nœud");
    case "delete_node": return "🗑 nœud supprimé";
    case "move_node": return "↦ déplacé";
    case "reorder_children": return "↕ réordonné";
    case "add_link": return "🔒 prérequis lié";
    case "remove_link": return "🔓 prérequis retiré";
    case "add_issue": return "🐞 " + (o.ref ? o.ref + " · " : "") + (o.title || "entrée créée");
    case "update_issue": return "✎ " + (o.ref || "entrée");
    case "delete_issue": return "🗑 " + (o.ref ? o.ref + " supprimée" : "entrée supprimée");
    case "reorder_issues": return "↕ entrées réordonnées";
    default: return o.op || "action";
  }
}
// Id de nœud ouvrable porté par une op APPLIQUÉE (les propositions n'ont pas
// encore d'id réel). On n'ouvre pas un nœud supprimé (il n'existe plus), ni un
// simple réordonnancement (pas de cible unique), ni les ops du domaine SUIVI
// (leur `id` est un id d'ENTRÉE, pas de nœud → ne pas tenter d'ouvrir un nœud).
const ISSUE_OP_SET = new Set(["add_issue", "update_issue", "delete_issue", "reorder_issues"]);
function openableNodeId(o) {
  if (!o || o.op === "delete_node" || o.op === "reorder_children" || ISSUE_OP_SET.has(o.op)) return null;
  return o.id != null ? o.id : null;
}
function actionChipsHtml(m) {
  if (!Array.isArray(m.actions) || !m.actions.length) return "";
  const entry = m.actions[0] || {};
  const ops = entry.ops || [];
  if (!ops.length && !entry.proposed) return "";
  const openable = !!entry.applied; // seules les actions appliquées portent un id réel
  const chips = ops
    .map((o) => {
      const oid = openable ? openableNodeId(o) : null;
      const cls = "action-chip" + (o.op === "delete_node" || o.op === "delete_issue" ? " danger" : "") + (oid != null ? " clickable" : "");
      const attr = oid != null ? ` data-open-node="${esc(String(oid))}" role="button" tabindex="0" title="Ouvrir le nœud"` : "";
      return `<span class="${cls}"${attr}>${esc(opLabel(o))}</span>`;
    })
    .join("");
  const confirm = entry.proposed ? `<button class="confirm-actions" type="button">Confirmer</button>` : "";
  // Annulation du placement : possible tant que des nœuds créés (add_node) subsistent.
  const canUndo = entry.applied && !entry.undone && ops.some((o) => o.op === "add_node" && o.id != null);
  const undo = canUndo ? `<button class="undo-actions" type="button" title="Supprimer les nœuds créés par ce message">↩️ Annuler le placement</button>` : "";
  const undone = entry.undone ? `<span class="actions-undone">↩️ placement annulé</span>` : "";
  return `<div class="action-chips">${chips}${confirm}${undo}${undone}</div>`;
}
function messageEl(m) {
  const div = document.createElement("div");
  const mine = m.role !== "assistant" && m.author === vibes.user;
  const streaming = m.state === "pending" || m.state === "streaming";
  div.className = "msg" + (m.role === "assistant" ? " ai" : mine ? " mine" : "") + (streaming ? " streaming" : "") + (m.state === "error" ? " error" : "");
  if (m.id) div.dataset.mid = String(m.id);
  if (m.clientNonce) div.dataset.nonce = m.clientNonce;
  const who = m.role === "assistant" ? `🤖 Claude${m.model ? " · " + esc(m.model) : ""}` : esc(m.author || "anon");
  const color = m.role === "assistant" ? "var(--accent)" : authorColor(m.author || "anon");

  const head = document.createElement("div");
  head.className = "msg-head";
  head.style.color = color;
  head.textContent = "";
  head.innerHTML = who;
  div.appendChild(head);

  // Bouton « retirer ce message » (visible au survol) — messages finalisés uniquement.
  if (m.id && !streaming) {
    const del = document.createElement("button");
    del.className = "msg-delete";
    del.title = "Retirer ce message";
    del.setAttribute("aria-label", "Retirer ce message");
    del.textContent = "✕";
    del.addEventListener("click", () => deleteMessage(m.id));
    div.appendChild(del);
  }

  // Zone réflexion repliable (repliée par défaut) — pour l'IA.
  let reasoningBody = null;
  if (m.role === "assistant") {
    const det = document.createElement("details");
    det.className = "msg-reasoning";
    const sum = document.createElement("summary");
    sum.textContent = "💭 Réflexion";
    det.appendChild(sum);
    reasoningBody = document.createElement("div");
    reasoningBody.className = "reasoning-body";
    reasoningBody.textContent = m.reasoning || "";
    det.appendChild(reasoningBody);
    if (!m.reasoning && !streaming) det.hidden = true; // pas de réflexion → masqué
    div.appendChild(det);
  }

  const body = document.createElement("div");
  body.className = "msg-body";
  // Indicateur d'action en cours (« Création de nœuds… ») affiché à la place du
  // JSON brut pendant que l'IA rédige son bloc d'actions.
  let statusEl = null;
  if (streaming) {
    // Pendant le streaming on interprète le markdown au fil de l'eau (même rendu
    // qu'à la finalisation). renderMarkdown échappe tout le HTML d'abord, donc le
    // markdown incomplet (** non fermé, fence ouverte) reste juste non transformé.
    if (m.body) {
      body.classList.add("markdown-body");
      body.innerHTML = renderMarkdown(m.body);
    } else {
      const dots = document.createElement("span");
      dots.className = "dots";
      dots.textContent = "Claude rédige";
      body.appendChild(dots);
    }
    statusEl = document.createElement("div");
    statusEl.className = "msg-action-status";
    statusEl.hidden = true;
    if (m.id) vibes.streams.set(m.id, { reasoning: m.reasoning || "", text: m.body || "", reasoningEl: reasoningBody, bodyEl: body, statusEl });
  } else {
    // Message finalisé : rendu markdown (tableaux, listes, code…) pour l'IA ;
    // texte simple pour les humains (on n'interprète pas leur frappe comme du markdown).
    if (m.role === "assistant") {
      body.classList.add("markdown-body");
      body.innerHTML = renderMarkdown(m.body || "");
    } else {
      body.innerHTML = esc(m.body || "").replace(/\n/g, "<br>");
    }
    if (m.id) vibes.streams.delete(m.id);
  }
  div.appendChild(body);
  if (statusEl) div.appendChild(statusEl);

  if (!streaming) {
    const chips = actionChipsHtml(m);
    if (chips) {
      const c = document.createElement("div");
      c.innerHTML = chips;
      const node = c.firstElementChild;
      const btn = node.querySelector(".confirm-actions");
      if (btn && m.id) btn.addEventListener("click", () => confirmActions(m.id));
      const ub = node.querySelector(".undo-actions");
      if (ub && m.id) ub.addEventListener("click", () => undoPlacement(m.id));
      // Chips d'actions appliquées : clic / Entrée → ouvre le nœud concerné.
      node.querySelectorAll(".action-chip.clickable[data-open-node]").forEach((chip) => {
        const open = () => openNode(chip.dataset.openNode);
        chip.addEventListener("click", open);
        chip.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
        });
      });
      div.appendChild(node);
    }
  }
  return div;
}
function appendMessage(m) {
  const feed = chatFeedEl();
  if (!feed) return;
  // Filtre par session active : les events SSE arrivent pour TOUTES les sessions du
  // nœud/repo (une seule room) → on n'affiche que celles de la conversation ouverte.
  if (m && (m.sessionId || 0) !== (vibes.chat.sessionId || 0)) return;
  const emptyEl = feed.querySelector(".empty");
  if (emptyEl) emptyEl.remove();
  if (m.id) {
    const existing = feed.querySelector(`[data-mid="${cssId(m.id)}"]`);
    if (existing) {
      existing.replaceWith(messageEl(m));
      scrollFeed();
      return;
    }
  }
  if (m.clientNonce) {
    const pend = feed.querySelector(`[data-nonce="${cssId(m.clientNonce)}"]`);
    if (pend) {
      pend.replaceWith(messageEl(m));
      if (m.id) vibes.seen.add(m.id);
      scrollFeed();
      return;
    }
  }
  if (m.id && vibes.seen.has(m.id)) return;
  if (m.id) vibes.seen.add(m.id);
  feed.appendChild(messageEl(m));
  scrollFeed();
}
// Repeint le corps d'un message en streaming en interprétant le markdown.
// Throttlé par requestAnimationFrame : les deltas arrivent token par token, mais
// renderMarkdown re-parse tout le texte → on coalesce à au plus un rendu par frame.
function paintStreamBody(s) {
  if (!s.bodyEl || s._raf) return;
  s._raf = requestAnimationFrame(() => {
    s._raf = null;
    if (!s.bodyEl) return;
    if (s.text) {
      s.bodyEl.classList.add("markdown-body");
      // Le rendu markdown re-parse tout le texte à chaque frame sur un état
      // intermédiaire (markdown incomplet). Si renderMarkdown lève, on retombe sur
      // le texte brut : le streaming continue d'avancer au lieu de figer l'affichage
      // au dernier bon rendu (bug NODE-292). textContent neutralise aussi tout HTML.
      try {
        s.bodyEl.innerHTML = renderMarkdown(s.text);
      } catch {
        s.bodyEl.classList.remove("markdown-body");
        s.bodyEl.textContent = s.text;
      }
    } else {
      s.bodyEl.textContent = "";
    }
    scrollFeed();
  });
}
function onStreamDelta(d) {
  const s = vibes.streams.get(d.turnId);
  if (!s) return;
  if (d.kind === "thinking") {
    s.reasoning += d.delta;
    if (s.reasoningEl) {
      s.reasoningEl.textContent = s.reasoning;
      const det = s.reasoningEl.closest("details");
      if (det) det.hidden = false;
    }
  } else if (d.kind === "text") {
    s.text += d.delta;
    paintStreamBody(s); // rendu markdown live (throttlé via rAF)
  } else if (d.kind === "status") {
    // Libellé d'action en cours (remplace, ne concatène pas) — affiché à la
    // place du JSON brut pendant que l'IA rédige son bloc d'actions.
    if (s.statusEl) {
      s.statusEl.textContent = d.text || "";
      s.statusEl.hidden = !d.text;
    }
  }
  scrollFeed();
}
function renderChat(messages) {
  const feed = chatFeedEl();
  if (!feed) return;
  feed.innerHTML = "";
  vibes.seen.clear();
  vibes.streams.clear();
  if (!messages.length) feed.innerHTML = vibes.chat.emptyHtml;
  for (const m of messages) appendMessage(m);
  scrollFeed(true);
}
// Vrai si le feed est (quasi) collé en bas — tolérance pour arrondis sous-pixel.
function isFeedAtBottom(feed) {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 24;
}
// Ne défile en bas que si on « suit » (utilisateur en bas). `force` réactive le suivi
// (envoi d'un message, ouverture d'un nœud) puis défile.
function scrollFeed(force) {
  const feed = chatFeedEl();
  if (!feed) return;
  if (force) vibes.stickToBottom = true;
  if (vibes.stickToBottom) feed.scrollTop = feed.scrollHeight;
}
// Agrandit le textarea du chat selon son contenu (borné par le max-height CSS, puis scroll).
function autoGrowChat(ta) {
  if (!ta) return;
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
}
async function sendChat() {
  const ctx = vibes.chat;
  const ta = $(ctx.inputSel);
  if (!ta) return;
  const text = ta.value.trim();
  if (!text || !ctx.ready()) return;
  const nonce = crypto.randomUUID ? crypto.randomUUID() : "n" + Date.now() + Math.floor(Math.random() * 1e6);
  vibes.stickToBottom = true; // envoyer un message réactive le suivi du bas
  appendMessage({ id: 0, role: "user", author: vibes.user, body: text, state: "complete", clientNonce: nonce, sessionId: ctx.sessionId });
  ta.value = "";
  autoGrowChat(ta);
  try {
    await api.send("POST", ctx.url("/chat"), { author: vibes.user, model: vibes.model, body: text, clientNonce: nonce, session: ctx.sessionId });
  } catch (e) {
    if (/ai_busy/.test(e.message)) toast(ctx.kind === "forest" ? "Claude répond déjà au niveau objectifs — attends la fin du tour." : "Claude répond déjà sur ce nœud — attends la fin du tour.");
    else if (/ai_overloaded/.test(e.message)) toast("Trop de discussions IA en cours, réessaie dans un instant.");
    else toast("Échec : " + e.message);
    chatFeedEl()?.querySelector(`[data-nonce="${cssId(nonce)}"]`)?.remove();
    ta.value = text;
    autoGrowChat(ta);
  }
}
async function confirmActions(messageId) {
  try {
    await api.send("POST", vibes.chat.url("/chat/confirm"), { messageId });
  } catch (e) {
    toast(e.message);
  }
}
// Annule le placement d'un message IA : supprime les nœuds qu'il a créés.
async function undoPlacement(messageId) {
  if (!messageId) return;
  if (!confirm("Annuler le placement ? Les nœuds créés par ce message seront supprimés (irréversible).")) return;
  try {
    await api.send("POST", vibes.chat.url(`/chat/${encodeURIComponent(messageId)}/undo`));
    toast("Placement annulé.");
  } catch (e) {
    if (/ai_busy/.test(e.message)) toast("Claude répond en ce moment — réessaie après le tour.");
    else if (/rien_a_annuler/.test(e.message)) toast("Rien à annuler pour ce message.");
    else toast("Échec : " + e.message);
  }
}
// Vidage suite à l'event SSE `chat:cleared` — uniquement si la session ciblée est
// celle ouverte (l'event est diffusé sur la room du nœud/repo, toutes sessions confondues).
function onChatCleared(e) {
  let sid = 0;
  try { sid = JSON.parse(e.data).sessionId || 0; } catch { /* payload absent → défaut */ }
  if (sid === (vibes.chat.sessionId || 0)) renderChat([]);
}
// Retrait DOM d'un message suite à l'event SSE `message:deleted` (autre client).
function removeMessageEl(e) {
  let id = null;
  try { id = JSON.parse(e.data).id; } catch {}
  if (id != null) chatFeedEl()?.querySelector(`[data-mid="${cssId(id)}"]`)?.remove();
}
// Retire un seul message (node ou forêt selon le chat actif). Refusé pendant un tour IA.
async function deleteMessage(messageId) {
  if (!messageId || !confirm("Retirer ce message ? (irréversible)")) return;
  try {
    await api.send("DELETE", vibes.chat.url("/messages/" + encodeURIComponent(messageId)));
    chatFeedEl()?.querySelector(`[data-mid="${cssId(messageId)}"]`)?.remove(); // retrait local immédiat
  } catch (e) {
    if (/ai_busy/.test(e.message)) toast("Claude répond en ce moment — réessaie après le tour.");
    else toast("Échec : " + e.message);
  }
}
async function clearChatHistory() {
  const ctx = vibes.chat;
  if (!ctx.ready()) return;
  const what = ctx.kind === "forest" ? "de la discussion des objectifs" : "de la discussion de ce nœud";
  if (!confirm(`Vider tout l'historique ${what} ? (irréversible)`)) return;
  try {
    await api.send("DELETE", ctx.url("/messages") + sessionQS(ctx));
    renderChat([]); // vidage local immédiat (l'événement chat:cleared confirmera aux autres)
    toast("Historique vidé.");
  } catch (e) {
    if (/ai_busy/.test(e.message)) toast("Claude répond en ce moment — réessaie après le tour.");
    else toast("Échec : " + e.message);
  }
}
// Charge l'historique du chat « top level » (forêt) et le rend (session active).
async function loadForestChat() {
  await loadSessions();
  await loadSessionMessages();
}

// ── Sessions de conversation (plusieurs historiques nommés) ───────────────────
// Fragment de requête `?session=` (omis pour la conversation par défaut, id 0).
function sessionQS(ctx) {
  return ctx.sessionId ? `?session=${encodeURIComponent(ctx.sessionId)}` : "";
}
// Active/désactive les boutons renommer/supprimer (interdits sur la session par défaut).
function updateSessionButtons() {
  const ctx = vibes.chat;
  const isDefault = !ctx.sessionId;
  const rn = $(ctx.renameSel);
  const dl = $(ctx.delSel);
  if (rn) rn.disabled = isDefault;
  if (dl) dl.disabled = isDefault;
}
// Charge la liste des sessions du chat actif et peuple son sélecteur.
async function loadSessions() {
  const ctx = vibes.chat;
  const sel = $(ctx.sessionSel);
  if (!sel || !ctx.ready()) return;
  let sessions;
  try { sessions = await api.get(ctx.url("/chat/sessions")); }
  catch { sessions = [{ id: 0, name: "Conversation", isDefault: true }]; }
  ctx._sessions = sessions;
  // Si la session courante a disparu (supprimée ailleurs), retombe sur la défaut.
  if (!sessions.some((s) => s.id === ctx.sessionId)) ctx.sessionId = 0;
  sel.innerHTML = "";
  for (const s of sessions) {
    const o = document.createElement("option");
    o.value = String(s.id);
    o.textContent = s.name;
    sel.appendChild(o);
  }
  sel.value = String(ctx.sessionId);
  updateSessionButtons();
}
// Charge les messages de la session active du chat actif.
async function loadSessionMessages() {
  const ctx = vibes.chat;
  if (!ctx.ready()) return;
  try { renderChat(await api.get(ctx.url("/messages") + sessionQS(ctx))); }
  catch { renderChat([]); }
}
// Bascule sur une autre session (recharge ses messages).
async function switchSession(id) {
  const ctx = vibes.chat;
  ctx.sessionId = Number(id) || 0;
  const sel = $(ctx.sessionSel);
  if (sel) sel.value = String(ctx.sessionId);
  updateSessionButtons();
  await loadSessionMessages();
}
async function newSession() {
  const ctx = vibes.chat;
  if (!ctx.ready()) return;
  const name = (window.prompt("Nom de la nouvelle conversation :", "") || "").trim();
  if (!name) return;
  try {
    const s = await api.send("POST", ctx.url("/chat/sessions"), { name });
    await loadSessions();
    await switchSession(s.id);
  } catch (e) { toast("Échec : " + e.message); }
}
async function renameSession() {
  const ctx = vibes.chat;
  if (!ctx.sessionId) return;
  const cur = (ctx._sessions || []).find((s) => s.id === ctx.sessionId);
  const name = (window.prompt("Renommer la conversation :", cur ? cur.name : "") || "").trim();
  if (!name) return;
  try { await api.send("PATCH", ctx.url("/chat/sessions/" + ctx.sessionId), { name }); await loadSessions(); }
  catch (e) { toast("Échec : " + e.message); }
}
async function deleteSession() {
  const ctx = vibes.chat;
  if (!ctx.sessionId) return;
  if (!confirm("Supprimer cette conversation et tous ses messages ? (irréversible)")) return;
  try {
    await api.send("DELETE", ctx.url("/chat/sessions/" + ctx.sessionId));
    ctx.sessionId = 0;
    await loadSessions();
    await loadSessionMessages();
    toast("Conversation supprimée.");
  } catch (e) {
    if (/ai_busy/.test(e.message)) toast("Claude répond en ce moment — réessaie après le tour.");
    else toast("Échec : " + e.message);
  }
}

// ── Temps réel (SSE) ─────────────────────────────────────────────────────────
function setLive(on) {
  document.querySelectorAll(".live-dot").forEach((d) => d.classList.toggle("on", !!on));
}
function streamUrl(p) {
  p = injectRepo(p); // SSE forêt/nœud scopés sur le repo actif
  return p + (getToken() ? (p.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(getToken()) : "");
}
function closeStream() {
  if (vibes.es) {
    try { vibes.es.close(); } catch { /* ignore */ }
    vibes.es = null;
  }
  setLive(false);
}
// Reflète l'état de génération IA du chat ACTIF (nœud ou forêt) sur le bouton Stop.
function applyAiTurnEvent(d) {
  // L'indicateur de frappe « ✨ Claude travaille… » a été retiré : l'état de
  // génération est désormais reflété uniquement par le bouton Stop (visible pendant
  // un tour, masqué sinon) et par l'animation « Claude rédige » dans la bulle.
  const stop = $(vibes.chat.stopSel);
  if (stop) stop.hidden = d.state !== "start";
}
// Interrompt la réponse IA en cours pour le chat actif (nœud ou forêt).
async function stopChat() {
  const ctx = vibes.chat;
  if (!ctx.ready()) return;
  const stop = $(ctx.stopSel);
  if (stop) stop.disabled = true;
  try { await api.send("POST", ctx.url("/chat/stop"), {}); }
  catch (e) { toast("Échec : " + e.message); }
  finally { if (stop) stop.disabled = false; }
}
function subscribeForest() {
  closeStream();
  const es = new EventSource(streamUrl("/api/nodes/stream"));
  vibes.es = es;
  es.onopen = () => { setLive(true); if (vibes.wasDown) { clearGhostsForest(); loadForest(); loadForestChat(); } vibes.wasDown = false; };
  es.onerror = () => { setLive(false); vibes.wasDown = true; };
  // Chat « top level » : mêmes events que la room d'un nœud, sur le canal forêt.
  es.addEventListener("message", (e) => appendMessage(JSON.parse(e.data)));
  es.addEventListener("ai:stream", (e) => onStreamDelta(JSON.parse(e.data)));
  es.addEventListener("ai:turn", (e) => {
    const d = JSON.parse(e.data);
    applyAiTurnEvent(d);
    if (d.state === "start") {
      clearGhostsForest(); // nouveau tour → on repart d'une forêt sans fantômes résiduels
    } else if (d.state === "end") {
      // Fin de tour : refetch AUTORITATIF de la forêt si un aperçu fantôme était affiché.
      // L'aperçu streaming (parse permissif) peut montrer des nœuds que le tour n'a PAS
      // persistés (parse final fail-closed, proposition destructive en attente de
      // confirmation, cap d'actions atteint) ; à l'inverse l'ajout incrémental via
      // node:updated peut manquer un nœud. Sans ce refetch, les fantômes s'effacent
      // sans que les vrais nœuds prennent leur place. loadForest reflète la vérité serveur.
      const hadGhosts = vibes._ghostNodes.length > 0;
      vibes._ghostNodes = [];
      if (hadGhosts) loadForest();
      else renderForestSoon();
    }
  });
  es.addEventListener("node:ghost", (e) => applyGhostForest(JSON.parse(e.data)));
  es.addEventListener("chat:cleared", (e) => onChatCleared(e));
  es.addEventListener("chat:sessions", () => loadSessions()); // liste des conversations modifiée ailleurs
  es.addEventListener("message:deleted", (e) => removeMessageEl(e)); // un autre client a retiré un message
  const applyNode = (raw, kind) => {
    if (!raw) return;
    const ex = vibes.byId.get(raw.id);
    const wasDone = ex && ex.status === "done";
    if (ex) Object.assign(ex, raw);
    else { vibes.forest.push(raw); vibes.byId.set(raw.id, raw); }
    const node = vibes.byId.get(raw.id);
    if (kind === "created" || !ex) {
      vibes.graph.spawned.add(node.id);
    } else {
      vibes.graph.pulsed.add(node.id);
      if (!wasDone && node.status === "done") vibes.graph.celebrated.add(node.id); // jalon atteint → fête
    }
    renderForestSoon();
  };
  es.addEventListener("node:created", (e) => applyNode(JSON.parse(e.data), "created"));
  es.addEventListener("node:updated", (e) => applyNode(JSON.parse(e.data), "updated"));
  es.addEventListener("node:deleted", (e) => {
    let id = null;
    try { id = JSON.parse(e.data).id; } catch {}
    if (id != null && vibes.byId.has(id)) animateNodeRemoval(id, loadForest);
    else loadForest();
  });
  es.addEventListener("node:reparented", () => loadForest());
  es.addEventListener("nodes:reordered", () => loadForest());
  es.addEventListener("links:changed", () => loadForest()); // prérequis ajouté/retiré ailleurs
  // Positions manuelles déplacées ailleurs : maj locale + re-rendu (sauf si on drague).
  es.addEventListener("nodes:moved", (e) => {
    if (vibes.graph.nodeDrag) return;
    const d = JSON.parse(e.data);
    for (const p of d.positions || []) {
      const n = vibes.byId.get(p.id);
      if (n) { n.posX = p.x; n.posY = p.y; }
    }
    renderForestSoon();
  });
}
function subscribeNode(ref) {
  closeStream();
  const es = new EventSource(streamUrl(`/api/nodes/${encodeURIComponent(ref)}/stream`));
  vibes.es = es;
  es.onopen = () => { setLive(true); if (vibes.wasDown && vibes.current === ref) openNode(ref); vibes.wasDown = false; };
  es.onerror = () => { setLive(false); vibes.wasDown = true; };
  es.addEventListener("message", (e) => appendMessage(JSON.parse(e.data)));
  es.addEventListener("ai:stream", (e) => onStreamDelta(JSON.parse(e.data)));
  es.addEventListener("ai:turn", (e) => {
    const d = JSON.parse(e.data);
    applyAiTurnEvent(d); // état de génération (bouton Stop) du chat actif
    if (d.state === "start" || d.state === "end") clearGhostsDetail(); // fin/début → les vrais nœuds (refetch) remplacent les fantômes
  });
  es.addEventListener("node:ghost", (e) => applyGhostDetail(JSON.parse(e.data)));
  es.addEventListener("node:updated", (e) => applyNodeUpdate(JSON.parse(e.data)));
  es.addEventListener("subtree:dirty", () => scheduleSubtreeRefetch());
  es.addEventListener("links:changed", () => refreshCurrentNode()); // prérequis du nœud modifié
  es.addEventListener("chat:cleared", (e) => onChatCleared(e)); // un autre client a vidé l'historique
  es.addEventListener("chat:sessions", () => loadSessions()); // liste des conversations modifiée ailleurs
  es.addEventListener("message:deleted", (e) => removeMessageEl(e)); // un autre client a retiré un message
  es.addEventListener("node:deleted", (e) => {
    const d = JSON.parse(e.data);
    if (vibes.currentNode && d.id === vibes.currentNode.id) { toast("Ce nœud a été supprimé."); backToForest(); }
    else animateNodeRemoval(d.id, scheduleSubtreeRefetch); // flétrit la ligne d'arbre avant le refetch
  });
}

// ── Modale nœud (création / édition) ─────────────────────────────────────────
function buildColorChips() {
  const wrap = $("#nColors");
  wrap.innerHTML = NODE_COLORS.map((c) => `<button type="button" class="color-chip" data-color="${c}" style="background:var(--${c})" title="${c}"></button>`).join("");
  wrap.querySelectorAll(".color-chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      vibes._color = chip.dataset.color;
      wrap.querySelectorAll(".color-chip").forEach((c) => c.classList.toggle("sel", c === chip));
    })
  );
}
function selectColorChip(color) {
  vibes._color = NODE_COLORS.includes(color) ? color : "accent";
  $("#nColors").querySelectorAll(".color-chip").forEach((c) => c.classList.toggle("sel", c.dataset.color === vibes._color));
}
// node=édition ; parentId=création d'un enfant ; les deux null = nouvelle racine.
// vibes._createKind (posé par le menu fond) pré-sélectionne le type à la création.
function openNodeModal(node, parentId) {
  vibes._editing = node || null;
  vibes._parentId = node ? null : parentId != null ? parentId : null;
  const kind = node?.kind || vibes._createKind || "normal";
  const isAct = kind === "activation";
  $("#nodeModalTitle").textContent = node
    ? `Éditer ${node.ref}`
    : isAct ? "Nouveau node d'activation" : parentId != null ? "Nouveau sous-jalon" : "Nouvel objectif";
  $("#nEmoji").value = node?.emoji || (isAct ? "⚡" : "🎯");
  $("#nStatus").value = node?.status || "active";
  if ($("#nKind")) $("#nKind").value = kind;
  $("#nTitle").value = node?.title || "";
  $("#nDesc").value = node?.description || "";
  selectColorChip(node?.color || "accent");
  $("#nodeBackdrop").hidden = false;
  $("#nTitle").focus();
}
async function saveNode() {
  const payload = {
    emoji: $("#nEmoji").value.trim() || "🎯",
    status: $("#nStatus").value,
    kind: $("#nKind") ? $("#nKind").value : "normal", // normal | activation
    title: $("#nTitle").value.trim(),
    description: $("#nDesc").value,
    color: vibes._color,
  };
  vibes._createKind = null; // consommé
  if (!payload.title) { toast("Titre requis."); return; }
  try {
    if (vibes._editing) {
      payload.expectedVersion = vibes._editing.version;
      const n = await api.send("PATCH", `/api/nodes/${encodeURIComponent(vibes._editing.ref)}`, payload);
      $("#nodeBackdrop").hidden = true;
      applyNodeUpdate(n);
      scheduleSubtreeRefetch();
      if (!vibes.current) loadForest();
    } else {
      if (vibes._parentId != null) payload.parentId = vibes._parentId;
      console.log("[vibes] createNode POST /api/nodes", payload);
      const n = await api.send("POST", "/api/nodes", payload);
      console.log("[vibes] createNode OK", n);
      $("#nodeBackdrop").hidden = true;
      vibes.graph.spawned.add(n.id); // anime aussi la naissance pour le créateur local
      // Création via le menu contextuel du fond → épingle le nœud à l'endroit cliqué.
      const at = vibes.graph.pendingCreatePos;
      vibes.graph.pendingCreatePos = null;
      if (at) {
        // Évite de superposer le nouveau nœud à un nœud déjà présent à cet endroit.
        const free = findFreePos(at.x, at.y, { excludeId: n.id });
        n.posX = free.x; n.posY = free.y;
        vibes.graph.posMap.set(n.id, free);
        // Attendre la persistance AVANT loadForest, sinon le rechargement récupère le
        // nœud avec posX/posY encore NULL (course) → il atterrit en auto-layout, pas au clic.
        await persistPositions([n.id]);
      }
      if (vibes.current) scheduleSubtreeRefetch();
      else if (at) loadForest(); // créé via le menu fond → rester sur le graphe pour le voir apparaître
      else { vibes.layout === "graph" ? openNode(n.ref) : loadForest(); }
    }
  } catch (e) {
    console.error("[vibes] saveNode échec", e);
    if (/version_conflict/.test(e.message)) toast("Nœud modifié entre-temps — rouvre-le.");
    else toast("Échec : " + e.message);
  }
}

// ── Wiring ───────────────────────────────────────────────────────────────────
export function initVibes() {
  vibes.user = userName();
  $("#userName").textContent = vibes.user;
  $("#userBtn").addEventListener("click", changeUser);
  document.querySelectorAll(".nav-tabs .tab").forEach((t) => t.addEventListener("click", () => switchView(t.dataset.view)));
  document.querySelectorAll(".seg-toggle .seg").forEach((b) => b.addEventListener("click", () => setVibesLayout(b.dataset.layout)));
  $("#newNodeBtn").addEventListener("click", () => openNodeModal(null, null));
  $("#ndBack").addEventListener("click", backToForest);
  $("#ndEdit").addEventListener("click", () => openNodeModal(vibes.currentNode, null));
  $("#ndDel").addEventListener("click", deleteCurrentNode);
  $("#ndAddChild").addEventListener("click", () => openNodeModal(null, vibes.currentNode ? vibes.currentNode.id : null));
  // « Prêt à implémenter » : sort le nœud de l'attente (waiting → active). Le data
  // layer efface alors l'info en attente. Secours manuel quand on ne passe pas par l'IA.
  $("#ndReadyBtn").addEventListener("click", () => { if (vibes.currentNode) markNodeReady(vibes.currentNode.id); });
  // Node d'activation : activer/désactiver depuis la vue détail (porte de prérequis).
  $("#ndActToggle").addEventListener("click", () => { if (vibes.currentNode) toggleActivation(vibes.currentNode.id); });
  // Crée une entrée de suivi pré-remplie et auto-liée à ce jalon (puis bascule sur Suivi).
  $("#ndAddIssue").addEventListener("click", () => { if (vibes.currentNode) createIssueFromNode(vibes.currentNode); });
  // Notes markdown : éditeur multi-notes (chaque éditeur gère son @ / aperçu).
  $("#ndNotesEditBtn").addEventListener("click", openNotesEditor);
  $("#ndNotesCancelBtn").addEventListener("click", closeNotesEditor);
  $("#ndNotesSaveBtn").addEventListener("click", saveNotes);
  $("#ndNotesAddBtn").addEventListener("click", () => addNoteEditor());
  $("#ndAddReqBtn").addEventListener("click", (e) => openReqPicker(e.clientX, e.clientY));
  $("#chatSend").addEventListener("click", sendChat);
  $("#chatClearBtn").addEventListener("click", clearChatHistory);
  // Sessions de conversation du nœud.
  $("#nodeSessionSel").addEventListener("change", (e) => switchSession(e.target.value));
  $("#nodeSessionNew").addEventListener("click", newSession);
  $("#nodeSessionRename").addEventListener("click", renameSession);
  $("#nodeSessionDel").addEventListener("click", deleteSession);
  $("#chatStopBtn").addEventListener("click", stopChat);
  // Suivi du scroll : on coupe l'auto-défilement dès que l'utilisateur remonte,
  // on le rétablit quand il revient en bas (pendant la génération comme après).
  $("#chatFeed").addEventListener("scroll", () => { vibes.stickToBottom = isFeedAtBottom($("#chatFeed")); });
  // Autocomplete dans le chat : @ fichier + # nœud (même UX que la modale d'entrée).
  const chatInput = $("#chatInput");
  const chatMenu = $("#chatMentionMenu");
  chatInput.addEventListener("input", () => { handleChatMention(chatInput, chatMenu, state.branch || "", null); autoGrowChat(chatInput); });
  chatInput.addEventListener("blur", () => setTimeout(() => hideMenu(chatMenu), 150));
  chatInput.addEventListener("keydown", (e) => {
    if (menuKeydown(chatMenu, e)) return; // menu ouvert : flèches / Entrée / Tab / Échap pour lui
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  $("#modelSel").addEventListener("change", (e) => (vibes.model = e.target.value));
  // Chat « top level » (vue objectifs) — même rendu/flux, contexte forêt.
  $("#forestChatSend").addEventListener("click", sendChat);
  $("#forestChatClearBtn").addEventListener("click", clearChatHistory);
  // Sessions de conversation de la forêt.
  $("#forestSessionSel").addEventListener("change", (e) => switchSession(e.target.value));
  $("#forestSessionNew").addEventListener("click", newSession);
  $("#forestSessionRename").addEventListener("click", renameSession);
  $("#forestSessionDel").addEventListener("click", deleteSession);
  $("#forestChatStopBtn").addEventListener("click", stopChat);
  $("#forestChatToggle").addEventListener("click", toggleForestChat);
  $("#forestChatPinBtn").addEventListener("click", () => setForestPinned(!vibes.pinned));
  $("#forestChatExpandBtn").addEventListener("click", () => setForestFullscreen(!vibes.fullscreen));
  // En-tête redimensionné (barre qui passe à la ligne) : recale le panneau épinglé.
  window.addEventListener("resize", () => { if (vibes.pinned && !$("#forestChat").hidden) measureTopbar(); });
  $("#forestChatFeed").addEventListener("scroll", () => { vibes.stickToBottom = isFeedAtBottom($("#forestChatFeed")); });
  const forestChatInput = $("#forestChatInput");
  const forestChatMenu = $("#forestChatMentionMenu");
  forestChatInput.addEventListener("input", () => { handleChatMention(forestChatInput, forestChatMenu, state.branch || "", null); autoGrowChat(forestChatInput); });
  forestChatInput.addEventListener("blur", () => setTimeout(() => hideMenu(forestChatMenu), 150));
  forestChatInput.addEventListener("keydown", (e) => {
    if (menuKeydown(forestChatMenu, e)) return; // menu ouvert : flèches / Entrée / Tab / Échap pour lui
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  $("#forestModelSel").addEventListener("change", (e) => (vibes.model = e.target.value));
  const closeNodeModal = () => { $("#nodeBackdrop").hidden = true; vibes.graph.pendingCreatePos = null; };
  $("#nodeCancelBtn").addEventListener("click", closeNodeModal);
  $("#nodeSaveBtn").addEventListener("click", saveNode);
  $("#nodeBackdrop").addEventListener("mousedown", (e) => { if (e.target === $("#nodeBackdrop")) closeNodeModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (vibes.graph.linking) { cancelLinkMode(); return; }
    if (document.getElementById("ctxMenu")) { hideCtxMenu(); return; }
    if (vibes.graph.edgeDel) { hideEdgeDel(); return; }
    if (vibes._notesEditing && !$("#nodeView").hidden) { closeNotesEditor(); return; }
    if (!$("#nodeBackdrop").hidden) { $("#nodeBackdrop").hidden = true; vibes.graph.pendingCreatePos = null; }
  });
  buildColorChips();
  wireGraph();
  setVibesLayout(vibes.layout);
  window.addEventListener("beforeunload", closeStream);
  const viewFromHash = () =>
    location.hash === "#vibes" ? "vibes" : location.hash === "#repo" ? "repo" : location.hash === "#orch" ? "orch" : "track";
  window.addEventListener("hashchange", () => switchView(viewFromHash()));
  initRepo();
  switchView(viewFromHash()); // état de vue cohérent dès le départ (masque les vues inactives)
}
