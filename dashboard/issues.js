// issues.js — bloc « Suivi » : registre des dépôts (sélecteur), liste/détail des
// entrées, modale de création/édition, et l'autocomplete « @ » partagé (utilisé
// aussi par le bloc Vibes pour les notes et le chat). Importe le noyau et les
// ponts de navigation vers les autres vues.

import { $, esc, api, activeRepo, setActiveRepo, getToken, injectRepo } from "./core.js";
import { vibes, openVibes, openNodeInVibes } from "./vibes.js";
import { openRepoView } from "./repo.js";

const TYPE_ICON = { bug: "🐞", feature: "✨", task: "✅", chore: "🧹" };
const STATUS_LABEL = { open: "Ouvert", in_progress: "En cours", done: "Fait", wontfix: "Abandonné" };
const PRIO_LABEL = { critical: "Critique", high: "Haute", medium: "Moyenne", low: "Basse" };

export let state = { issues: [], selected: null, editing: null, refs: [], branch: "", branches: [], serverBranch: null, repos: [], nodes: null, linkNodeAfterCreate: null };

// Jalons (nœuds Vibes) du repo actif, pour le sélecteur d'import dans le détail.
// Chargés à la demande et mémorisés ; invalidés au changement de repo.
async function ensureNodesLoaded(force) {
  if (state.nodes && !force) return state.nodes;
  try {
    state.nodes = await api.get("/api/nodes?view=forest");
  } catch {
    state.nodes = [];
  }
  return state.nodes;
}

// ── Chargement & liste ───────────────────────────────────────────────────────
async function loadMeta() {
  try {
    const m = await api.get("/api/meta");
    const g = m.git || {};
    $("#meta").innerHTML =
      `repo <b>${esc((m.repoRoot || "").split(/[\\/]/).pop())}</b> · ` +
      `branche <b>${esc(g.branch || "?")}</b> @ <b>${esc(g.commit || "?")}</b>`;
  } catch (e) {
    $("#meta").textContent = "⚠ serveur injoignable : " + e.message;
  }
}

// Charge le registre des repos → sélecteur topbar. Fixe le repo actif (stocké,
// sinon le repo par défaut du serveur). Renvoie la liste.
async function loadRepos() {
  try {
    const repos = await api.get("/api/repos");
    state.repos = repos || [];
    const sel = $("#repoSel");
    if (sel) {
      sel.innerHTML = state.repos.map((r) => `<option value="${esc(r.slug)}">${esc(r.name || r.slug)}</option>`).join("");
      // Repo actif : celui stocké s'il existe encore, sinon le repo par défaut.
      let cur = activeRepo();
      if (!cur || !state.repos.some((r) => r.slug === cur)) {
        const def = state.repos.find((r) => r.isDefault) || state.repos[0];
        cur = def ? def.slug : "";
        setActiveRepo(cur);
      }
      sel.value = cur;
    }
    return state.repos;
  } catch {
    /* serveur injoignable : sélecteur laissé vide, repo par défaut serveur */
    return [];
  }
}

// Bascule de repo actif : persiste + recharge tout (méta, branches, liste, et la
// vue Vibes si elle est ouverte — forêt + flux SSE du nouveau repo).
async function onRepoChange(slug) {
  setActiveRepo(slug);
  state.branch = ""; // les branches diffèrent d'un repo à l'autre
  state.nodes = null; // les jalons sont propres au repo → rechargés à la demande
  subscribeIssues(); // le flux SSE est scopé au repo → se réabonner sur le nouveau
  await loadMeta();
  await loadBranches();
  await loadList();
  loadRuns(); // le flux des runs est scopé au repo → recharger au changement
  if (typeof vibes !== "undefined" && vibes.view === "vibes") openVibes();
  else if (typeof vibes !== "undefined" && vibes.view === "repo") openRepoView();
}

// Ajoute un repo à suivre depuis son URL git, puis bascule dessus. Le slug (identifiant
// court) est dérivé AUTOMATIQUEMENT de l'URL côté serveur : on ne le demande jamais —
// même si le clonage échoue, le repo reste enregistré (clonable plus tard via « ⟳ Mettre
// à jour »), sans nouvelle invite.
async function addRepoPrompt() {
  const url = (window.prompt("URL git du repo à suivre :", "") || "").trim();
  if (!url) return;
  try {
    const r = await api.send("POST", "/api/repos", { url });
    if (r.sync && r.sync.ok === false) alert("Repo ajouté mais clone échoué :\n" + (r.sync.output || "erreur inconnue"));
    await loadRepos();
    await onRepoChange(r.repo.slug);
  } catch (e) {
    alert("Erreur : " + e.message);
  }
}

// Retire le repo actif du meowtrack. Suppression strictement LOCALE : ses entrées et
// nœuds (base tracker du dépôt) + le clone local géré (`.repos/<slug>/`). Le dépôt
// GitHub DISTANT n'est jamais affecté. Le dernier repo ne peut pas être retiré ; on
// bascule ensuite sur le repo par défaut.
async function removeRepoPrompt() {
  const cur = activeRepo();
  const repo = state.repos.find((r) => r.slug === cur) || state.repos.find((r) => r.isDefault) || state.repos[0];
  if (!repo) return;
  if (state.repos.length <= 1) {
    alert("Impossible de retirer le dernier repo.");
    return;
  }
  const name = repo.name || repo.slug;
  if (
    !window.confirm(
      `Retirer « ${name} » du meowtrack ?\n\n` +
        "Suppression LOCALE : ses entrées, ses nœuds et le clone local (.repos/).\n" +
        "Le dépôt GitHub distant n'est PAS affecté. Irréversible."
    )
  )
    return;
  try {
    await api.send("DELETE", "/api/repos/" + encodeURIComponent(repo.slug));
    setActiveRepo(""); // bascule sur le repo par défaut au rechargement
    await loadRepos();
    await onRepoChange(activeRepo());
  } catch (e) {
    alert("Erreur : " + e.message);
  }
}

// Importe en masse un dossier contenant plusieurs dépôts git : le serveur détecte
// les clones (profondeur 1) et les enregistre par local_path — utilisés SUR PLACE,
// aucune copie. Bascule sur le 1er repo ajouté si la liste en contenait. Le dernier
// dossier saisi est mémorisé (pré-rempli au prochain import).
async function importReposPrompt() {
  const last = localStorage.getItem("meowtrack_import_dir") || "";
  const dir = (window.prompt("Dossier contenant plusieurs dépôts git (utilisés SUR PLACE, sans copie ; tous détectés et ajoutés) :", last) || "").trim();
  if (!dir) return;
  localStorage.setItem("meowtrack_import_dir", dir);
  try {
    const r = await api.send("POST", "/api/repos/import", { dir });
    const parts = [`${r.added.length} ajouté(s)`, `${r.skipped.length} déjà suivi(s)`];
    if (r.errors.length) parts.push(`${r.errors.length} en erreur`);
    let msg = `Import « ${r.dir} » : ${r.found} dépôt(s) trouvé(s) → ` + parts.join(", ") + ".";
    if (r.errors.length) msg += "\n\nErreurs :\n" + r.errors.map((e) => `· ${e.name} : ${e.error}`).join("\n");
    alert(msg);
    await loadRepos();
    if (r.added.length) await onRepoChange(r.added[0].slug);
  } catch (e) {
    alert("Erreur : " + e.message);
  }
}

// Charge la liste des branches du repo serveur → sélecteur topbar.
async function loadBranches() {
  try {
    const b = await api.get("/api/branches");
    state.branches = b.branches || [];
    state.serverBranch = b.current || null;
    const sel = $("#branchSel");
    const keep = state.branch;
    sel.innerHTML =
      `<option value="">Toutes branches</option>` +
      state.branches.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
    sel.value = keep && state.branches.includes(keep) ? keep : "";
    state.branch = sel.value;
  } catch {
    /* serveur injoignable : on garde le sélecteur vide */
  }
}

// Options du select branche de la modale (valeur "" = défaut serveur / HEAD).
function branchOptions(selected) {
  const def = `(défaut${state.serverBranch ? " · " + state.serverBranch : ""})`;
  const opts = [`<option value="">${esc(def)}</option>`];
  for (const n of state.branches) opts.push(`<option value="${esc(n)}">${esc(n)}</option>`);
  if (selected && !state.branches.includes(selected))
    opts.push(`<option value="${esc(selected)}">${esc(selected)}</option>`);
  return opts.join("");
}

// Clone / met à jour le repo (git fetch + pull côté serveur) puis recharge.
async function updateRepo(btn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "⟳ Maj…";
  try {
    const r = await api.send("POST", "/api/repo/update");
    if (r.skipped) {
      alert("Aucune URL de repo configurée (MEOWTRACK_REPO_URL).");
    } else if (r.ok) {
      await loadMeta();
      await loadList();
    } else {
      alert("Mise à jour échouée :\n" + (r.output || "erreur inconnue"));
    }
  } catch (e) {
    alert("Erreur : " + e.message);
  } finally {
    btn.textContent = old;
    btn.disabled = false;
  }
}

async function loadList() {
  const params = new URLSearchParams();
  const text = $("#search").value.trim();
  if (text) params.set("text", text);
  if ($("#fType").value) params.set("type", $("#fType").value);
  const st = $("#fStatus").value;
  if (st === "__all") params.set("includeClosed", "true");
  else if (st) params.set("status", st);
  if ($("#fPriority").value) params.set("priority", $("#fPriority").value);
  if (state.branch) params.set("branch", state.branch);
  try {
    state.issues = await api.get("/api/issues?" + params.toString());
    renderList();
  } catch (e) {
    $("#issueList").innerHTML = `<li class="empty">Erreur : ${esc(e.message)}</li>`;
  }
}

function renderList() {
  const ul = $("#issueList");
  if (!state.issues.length) {
    ul.innerHTML = `<li class="empty">Aucune entrée.</li>`;
    return;
  }
  ul.innerHTML = state.issues
    .map((it) => {
      const sel = state.selected?.ref === it.ref ? "selected" : "";
      const tags = it.tags.map((t) => `<span class="badge tag">${esc(t)}</span>`).join("");
      const refBadge = it.references.length ? `<span class="badge refcount">📎 ${it.references.length}</span>` : "";
      const nodeBadge = it.nodes?.length ? `<span class="badge nodecount">🎯 ${it.nodes.length}</span>` : "";
      // Badge branche affiché seulement hors filtre branche (sinon redondant).
      const brBadge = it.branch && !state.branch ? `<span class="badge">⎇ ${esc(it.branch)}</span>` : "";
      const stBadge =
        it.status !== "open" ? `<span class="badge status-${it.status}">${STATUS_LABEL[it.status]}</span>` : "";
      return `<li class="issue-card prio-${it.priority} ${it.status} ${sel}" data-ref="${esc(it.ref)}" draggable="true">
        <div class="row1">
          <span class="code">${esc(it.ref)}</span>
          <span class="title">${esc(it.title)}</span>
        </div>
        <div class="row2">
          <span class="badge type-${it.type}">${TYPE_ICON[it.type]} ${it.type}</span>
          ${stBadge}${brBadge}${refBadge}${nodeBadge}${tags}
        </div>
      </li>`;
    })
    .join("");
  ul.querySelectorAll(".issue-card").forEach((el) =>
    el.addEventListener("click", () => selectIssue(el.dataset.ref))
  );
}

// ── Activité des agents (flux repo-level des runs, GET /api/nodes/runs) ────────
// Timeline au-dessus de la liste d'entrées : un item par run (état, nœud cliquable,
// owner, branche, horodatage). Données fournies par listRecentRuns (jalon 🛰️).
const RUN_STATE_ICON = { running: "⏳", done: "✓", failed: "✕", review: "👀" };
// Horodatage compact : HH:MM si aujourd'hui, sinon JJ/MM HH:MM. Tolère les valeurs nulles.
function fmtRunTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay ? hm : `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${hm}`;
}

// Récap reçu du MCP à la clôture (NODE-320) : summary + report, en section
// collapsable. Même source que la note de récap du nœud (jalon 168) — pas de
// duplication. Vide si le run n'a encore ni récap, ni rapport, ni erreur.
function runRecapHtml(r) {
  const hasReport = r.report && typeof r.report === "object" && !Array.isArray(r.report);
  const tr = (hasReport && r.report.testResult) || r.testResult || null;
  if (!r.summary && !hasReport && !r.error) return "";
  const parts = [];
  if (r.error) parts.push(`<div class="run-error">⚠ ${esc(r.error)}</div>`);
  if (r.summary) parts.push(`<div class="run-summary">${descToHtml(r.summary).replace(/\n/g, "<br>")}</div>`);
  const badges = [];
  if (tr) badges.push(`<span class="badge test-${esc(tr)}">tests : ${esc(tr)}</span>`);
  if (hasReport) {
    const nu = Array.isArray(r.report.nodeUpdates) ? r.report.nodeUpdates.length : 0;
    const rp = Array.isArray(r.report.reviewPoints) ? r.report.reviewPoints.length : 0;
    if (nu) badges.push(`<span class="badge">${nu} maj nœud/suivi</span>`);
    if (rp) badges.push(`<span class="badge">${rp} point(s) de revue</span>`);
  }
  if (badges.length) parts.push(`<div class="run-report-meta">${badges.join(" ")}</div>`);
  if (hasReport) parts.push(`<details class="run-report"><summary>rapport JSON</summary><pre>${esc(JSON.stringify(r.report, null, 2))}</pre></details>`);
  return `<details class="run-recap"><summary>récap</summary><div class="run-recap-body">${parts.join("")}</div></details>`;
}

async function loadRuns() {
  const ul = $("#runFeed");
  if (!ul) return;
  try {
    const { runs } = await api.get("/api/nodes/runs?limit=50");
    if (!runs || !runs.length) {
      ul.innerHTML = `<li class="empty">Aucune activité d'agent pour l'instant.</li>`;
      return;
    }
    ul.innerHTML = runs
      .map((r) => {
        const icon = RUN_STATE_ICON[r.state] || "•";
        const when = r.state === "running" ? fmtRunTime(r.startedAt) : fmtRunTime(r.endedAt || r.startedAt);
        const owner = r.owner ? `· ${esc(r.owner)} ` : "";
        const branch = r.branch ? `· ⎇ ${esc(r.branch)} ` : "";
        return `<li class="run-item state-${esc(r.state)}">
          <div class="run-line">
            <span class="run-state" title="${esc(r.state)}">${icon}</span>
            <span class="run-node" data-ref="${esc(r.nodeRef)}" title="Ouvrir dans Vibes">${esc(r.nodeRef)}</span>
            <span class="run-title">${esc(r.nodeTitle || "")}</span>
            <span class="run-meta">${owner}${branch}· ${esc(when)}</span>
          </div>
          ${runRecapHtml(r)}
        </li>`;
      })
      .join("");
    ul.querySelectorAll(".run-node").forEach((el) =>
      el.addEventListener("click", () => openNodeInVibes(el.dataset.ref))
    );
  } catch (e) {
    ul.innerHTML = `<li class="empty">Erreur : ${esc(e.message)}</li>`;
  }
}

// ── Réordonnancement manuel (drag & drop) ────────────────────────────────────
// L'ordre manuel prime sur le tri statut/priorité (colonne `position` côté serveur).
// Listeners DÉLÉGUÉS sur la liste (posés une fois) → survivent aux re-render ; les
// cartes portent draggable="true". On déplace le <li> en direct pendant le survol,
// puis on persiste l'ordre du DOM à la fin du glisser.
let dragging = null;

// Carte (non draguée) sous le curseur dont on doit passer AVANT (insertion au-dessus
// de sa moitié haute). null → insérer en fin de liste.
function dragAfterElement(ul, y) {
  const els = [...ul.querySelectorAll(".issue-card:not(.dragging)")];
  let closest = { offset: -Infinity, el: null };
  for (const el of els) {
    const box = el.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, el };
  }
  return closest.el;
}

async function persistOrder(ul) {
  const order = [...ul.querySelectorAll(".issue-card")].map((el) => el.dataset.ref);
  // Reflète l'ordre localement (évite un saut visuel avant la confirmation serveur).
  state.issues.sort((a, b) => order.indexOf(a.ref) - order.indexOf(b.ref));
  try {
    await api.send("POST", "/api/issues/reorder", { order });
  } catch (e) {
    // Échec → on resynchronise depuis le serveur (vérité).
    await loadList();
  }
}

// Pose les listeners de glisser-déposer sur la liste (une seule fois).
function initDragReorder() {
  const ul = $("#issueList");
  if (!ul || ul._dndWired) return;
  ul._dndWired = true;
  ul.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".issue-card");
    if (!card) return;
    dragging = card;
    card.classList.add("dragging");
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", card.dataset.ref || ""); } catch { /* ignore */ }
    }
  });
  ul.addEventListener("dragover", (e) => {
    if (!dragging) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const after = dragAfterElement(ul, e.clientY);
    if (after == null) ul.appendChild(dragging);
    else ul.insertBefore(dragging, after);
  });
  ul.addEventListener("drop", (e) => e.preventDefault());
  ul.addEventListener("dragend", () => {
    if (!dragging) return;
    dragging.classList.remove("dragging");
    dragging = null;
    persistOrder(ul);
  });
}

// ── Synchro temps réel des entrées (SSE, canal forêt du repo) ─────────────────
// Les chats IA (Vibes) peuvent créer/modifier/réordonner des entrées de suivi ; le
// serveur diffuse alors `issues:changed` sur le canal forêt du repo, auquel on
// s'abonne ici pour recharger la liste (et rafraîchir le détail ouvert) en direct.
let issuesEs = null;
let issuesReloadTimer = null;
function issueStreamUrl() {
  const p = injectRepo("/api/nodes/stream");
  return p + (getToken() ? (p.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(getToken()) : "");
}
async function refreshSelected() {
  if (!state.selected) return;
  try {
    state.selected = await api.get("/api/issues/" + encodeURIComponent(state.selected.ref));
    renderDetail();
  } catch {
    /* entrée supprimée entre-temps → ignoré (la liste reflètera la disparition) */
  }
}
function subscribeIssues() {
  if (issuesEs) { try { issuesEs.close(); } catch { /* ignore */ } issuesEs = null; }
  let es;
  try { es = new EventSource(issueStreamUrl()); } catch { return; }
  issuesEs = es;
  es.addEventListener("issues:changed", () => {
    if (dragging) return; // ne pas perturber un glisser en cours
    clearTimeout(issuesReloadTimer);
    issuesReloadTimer = setTimeout(() => {
      loadList();
      refreshSelected();
    }, 150);
  });
}

// ── Détail ───────────────────────────────────────────────────────────────────
async function selectIssue(ref) {
  try {
    state.selected = await api.get("/api/issues/" + encodeURIComponent(ref));
    await ensureNodesLoaded(); // alimente le sélecteur d'import de jalons du détail
    renderList();
    renderDetail();
    // Mobile (master-détail) : bascule sur le panneau détail plein écran.
    document.body.classList.add("issue-open");
  } catch (e) {
    $("#detail").innerHTML = `<div class="empty">Erreur : ${esc(e.message)}</div>`;
  }
}

function descToHtml(desc) {
  return esc(desc).replace(/@([A-Za-z0-9_./-]+(?::\d+(?:-\d+)?)?)/g, '<span class="mention">@$1</span>');
}

function renderDetail() {
  const it = state.selected;
  if (!it) return;
  const refsHtml = it.references.length
    ? it.references
        .map(
          (r) => `<li class="${r.existed ? "" : "missing"}">
            <span class="kind">${r.kind === "dir" ? "📁" : "📄"}</span>
            <span class="path">${esc(r.path)}</span>
            ${r.lineStart ? `<span class="lines">:${r.lineStart}${r.lineEnd ? "-" + r.lineEnd : ""}</span>` : ""}
            ${r.existed ? "" : '<span class="badge type-bug">absent</span>'}
          </li>`
        )
        .join("")
    : '<li class="empty">Aucune référence.</li>';

  const commentsHtml = (it.comments || []).length
    ? it.comments
        .map((c) => `<li>${esc(c.body)}<time>${esc(c.createdAt)}</time></li>`)
        .join("")
    : '<li class="empty">Aucun commentaire.</li>';

  const statusBtns = Object.keys(STATUS_LABEL)
    .map(
      (s) => `<button data-status="${s}" class="${it.status === s ? "active" : ""}">${STATUS_LABEL[s]}</button>`
    )
    .join("");

  // Jalons liés (lien vivant vers des nœuds Vibes) + sélecteur d'import.
  const linkedNodes = it.nodes || [];
  const nodesHtml = linkedNodes.length
    ? linkedNodes
        .map(
          (n) => `<li class="node-link color-${esc(n.color || "accent")}">
            <button class="nl-open" data-ref="${esc(n.ref)}" title="Ouvrir dans Vibes">
              <span class="nl-emoji">${esc(n.emoji || "🎯")}</span>
              <span class="nl-title">${esc(n.title)}</span>
              <span class="code">${esc(n.ref)}</span>
              <span class="nl-prog">${n.progress}%</span>
            </button>
            <button class="nl-remove ghost" data-id="${n.id}" title="Détacher ce jalon">✕</button>
          </li>`
        )
        .join("")
    : '<li class="empty">Aucun jalon lié.</li>';
  const linkedIds = new Set(linkedNodes.map((n) => n.id));
  const nodeOpts = (state.nodes || [])
    .filter((n) => !linkedIds.has(n.id))
    .map((n) => {
      const indent = "  ".repeat(Math.max(0, n.depth || 0));
      return `<option value="${esc(n.ref)}">${indent}${esc((n.emoji || "🎯") + " " + n.title)} (${esc(n.ref)})</option>`;
    })
    .join("");

  $("#detail").innerHTML = `
    <div class="detail-head">
      <button id="detailBack" class="ghost detail-back" title="Retour à la liste">←</button>
      <div style="flex:1">
        <h1>${esc(it.title)}</h1>
        <div class="detail-sub">
          <span class="code">${esc(it.ref)}</span>
          <span class="badge type-${it.type}">${TYPE_ICON[it.type]} ${it.type}</span>
          <span class="badge">priorité : ${PRIO_LABEL[it.priority]}</span>
          ${it.branch ? `<span class="badge">${esc(it.branch)} @ ${esc(it.commit || "?")}</span>` : ""}
          ${it.tags.map((t) => `<span class="badge tag">${esc(t)}</span>`).join("")}
        </div>
      </div>
      <button id="editBtn" class="ghost">✎ Éditer</button>
      <button id="delBtn" class="danger">🗑</button>
    </div>

    <div class="detail-section">
      <h3>Statut</h3>
      <div class="status-buttons">${statusBtns}</div>
    </div>

    <div class="detail-section">
      <h3>Description</h3>
      <div class="desc-body">${it.description ? descToHtml(it.description) : '<span class="hint">—</span>'}</div>
    </div>

    <div class="detail-section">
      <h3>Fichiers / dossiers (${it.references.length})</h3>
      <ul class="ref-list">${refsHtml}</ul>
    </div>

    <div class="detail-section">
      <h3>Jalons liés (${linkedNodes.length})</h3>
      <ul class="node-link-list">${nodesHtml}</ul>
      <div class="add-node-link">
        <select id="nodeLinkSel" ${nodeOpts ? "" : "disabled"}>
          <option value="">${nodeOpts ? "➕ Importer un jalon…" : "Aucun jalon disponible"}</option>
          ${nodeOpts}
        </select>
      </div>
    </div>

    <div class="detail-section">
      <h3>Commentaires</h3>
      <ul class="comment-list">${commentsHtml}</ul>
      <div class="add-comment">
        <input id="commentInput" type="text" placeholder="Ajouter une note…" />
        <button id="commentBtn">Ajouter</button>
      </div>
    </div>`;

  $("#detailBack")?.addEventListener("click", () => document.body.classList.remove("issue-open"));
  $("#editBtn").addEventListener("click", () => openModal(it));
  $("#delBtn").addEventListener("click", () => deleteIssue(it.ref));
  $("#detail").querySelectorAll(".status-buttons button").forEach((b) =>
    b.addEventListener("click", () => setStatus(it.ref, b.dataset.status))
  );
  const ci = $("#commentInput");
  const submitComment = async () => {
    if (!ci.value.trim()) return;
    await api.send("POST", `/api/issues/${encodeURIComponent(it.ref)}/comments`, { body: ci.value.trim() });
    await selectIssue(it.ref);
  };
  $("#commentBtn").addEventListener("click", submitComment);
  ci.addEventListener("keydown", (e) => e.key === "Enter" && submitComment());

  // Jalons liés : ouverture dans Vibes, détachement, et import via le sélecteur.
  $("#detail").querySelectorAll(".nl-open").forEach((b) =>
    b.addEventListener("click", () => openNodeInVibes(b.dataset.ref))
  );
  $("#detail").querySelectorAll(".nl-remove").forEach((b) =>
    b.addEventListener("click", () => unlinkNode(it.ref, b.dataset.id))
  );
  const nsel = $("#nodeLinkSel");
  nsel?.addEventListener("change", () => {
    if (nsel.value) linkNode(it.ref, nsel.value);
  });
}

// Lie / détache un jalon puis rafraîchit le détail (lien vivant) et la liste (badge).
async function linkNode(ref, nodeRef) {
  try {
    await api.send("POST", `/api/issues/${encodeURIComponent(ref)}/nodes`, { nodeRef });
    await Promise.all([selectIssue(ref), loadList()]);
  } catch (e) {
    alert("Échec de la liaison : " + e.message);
  }
}
async function unlinkNode(ref, nodeId) {
  try {
    await api.send("DELETE", `/api/issues/${encodeURIComponent(ref)}/nodes/${encodeURIComponent(nodeId)}`);
    await Promise.all([selectIssue(ref), loadList()]);
  } catch (e) {
    alert("Échec du détachement : " + e.message);
  }
}

async function setStatus(ref, status) {
  await api.send("PATCH", "/api/issues/" + encodeURIComponent(ref), { status });
  await Promise.all([selectIssue(ref), loadMeta()]);
  await loadList();
}

async function deleteIssue(ref) {
  if (!confirm(`Supprimer ${ref} ?`)) return;
  await api.send("DELETE", "/api/issues/" + encodeURIComponent(ref));
  state.selected = null;
  document.body.classList.remove("issue-open"); // mobile : revient à la liste
  $("#detail").innerHTML = '<div class="empty">Entrée supprimée.</div>';
  await Promise.all([loadList(), loadMeta()]);
}

// ── Modale création / édition ────────────────────────────────────────────────
function openModal(issue) {
  state.editing = issue || null;
  state.linkNodeAfterCreate = null; // armé seulement par createIssueFromNode()
  state.refs = issue ? issue.references.map((r) => ({ path: r.path, lineStart: r.lineStart, lineEnd: r.lineEnd })) : [];
  $("#modalTitle").textContent = issue ? `Éditer ${issue.ref}` : "Nouvelle entrée";
  $("#mType").value = issue?.type || "bug";
  $("#mPriority").value = issue?.priority || "medium";
  $("#mStatus").value = issue?.status || "open";
  $("#mTitle").value = issue?.title || "";
  $("#mDesc").value = issue?.description || "";
  $("#mTags").value = (issue?.tags || []).join(", ");
  // Branche : celle de l'entrée éditée, sinon la branche de contexte (topbar).
  const branch = issue ? issue.branch || "" : state.branch || "";
  $("#mBranch").innerHTML = branchOptions(branch);
  $("#mBranch").value = branch;
  renderRefEditor();
  $("#backdrop").hidden = false;
  $("#mTitle").focus();
}

function closeModal() {
  $("#backdrop").hidden = true;
  hideMenu($("#mentionMenu"));
}

// Synchronise la liste de refs : on conserve les ajouts manuels + les @mentions.
function syncMentionsFromDesc() {
  const desc = $("#mDesc").value;
  const re = /@([A-Za-z0-9_./-]+(?::\d+(?:-\d+)?)?)/g;
  const mentioned = new Set();
  let m;
  while ((m = re.exec(desc)) !== null) {
    const spec = m[1];
    const mm = spec.match(/^(.*?):(\d+)(?:-(\d+))?$/);
    const path = mm ? mm[1] : spec;
    const lineStart = mm ? Number(mm[2]) : null;
    const lineEnd = mm && mm[3] ? Number(mm[3]) : null;
    const key = `${path}:${lineStart ?? ""}:${lineEnd ?? ""}`;
    mentioned.add(key);
    if (!state.refs.some((r) => `${r.path}:${r.lineStart ?? ""}:${r.lineEnd ?? ""}` === key))
      state.refs.push({ path, lineStart, lineEnd, fromMention: true });
  }
  // Retire les anciennes refs issues de mentions qui ne sont plus dans le texte.
  state.refs = state.refs.filter(
    (r) => !r.fromMention || mentioned.has(`${r.path}:${r.lineStart ?? ""}:${r.lineEnd ?? ""}`)
  );
  renderRefEditor();
}

// Affichage seul : les références sont entièrement dérivées des @mentions de la
// description (pour en retirer une, supprimer le @ correspondant dans le texte).
function renderRefEditor() {
  const ul = $("#refList");
  if (!state.refs.length) {
    ul.innerHTML = '<li class="empty" style="font-family:inherit">Aucun fichier associé (tape <kbd>@</kbd> dans la description).</li>';
    return;
  }
  ul.innerHTML = state.refs
    .map(
      (r) => `<li>
        <span class="path">${esc(r.path)}${r.lineStart ? `<span class="lines">:${r.lineStart}${r.lineEnd ? "-" + r.lineEnd : ""}</span>` : ""}</span>
      </li>`
    )
    .join("");
}

// Améliore la description courante via Claude (Sonnet), côté serveur (claude -p).
async function improveDescription() {
  const btn = $("#improveBtn");
  const desc = $("#mDesc");
  const base = desc.value.trim();
  if (!base) {
    alert("Écris d'abord une description à améliorer.");
    return;
  }
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "✨ Amélioration…";
  try {
    const r = await api.send("POST", "/api/improve-description", {
      title: $("#mTitle").value,
      description: base,
    });
    if (r.description) {
      desc.value = r.description;
      syncMentionsFromDesc(); // re-détecte les @chemin après réécriture
    }
  } catch (e) {
    alert("Échec de l'amélioration IA : " + e.message);
  } finally {
    btn.textContent = old;
    btn.disabled = false;
  }
}

async function saveIssue() {
  const payload = {
    type: $("#mType").value,
    priority: $("#mPriority").value,
    status: $("#mStatus").value,
    branch: $("#mBranch").value || undefined,
    title: $("#mTitle").value.trim(),
    description: $("#mDesc").value,
    tags: $("#mTags").value.split(",").map((s) => s.trim()).filter(Boolean),
    // On envoie la liste de refs explicite (remplace tout) + on désactive
    // l'auto-mention serveur pour ne pas dédoubler (la liste contient déjà les @).
    paths: state.refs.map((r) => (r.lineStart ? `${r.path}:${r.lineStart}${r.lineEnd ? "-" + r.lineEnd : ""}` : r.path)),
    autoMention: false,
  };
  if (!payload.title) {
    alert("Titre requis.");
    return;
  }
  // Création depuis un jalon (vue Vibes) : on liera l'entrée au nœud puis on
  // basculera sur la vue Suivi pour la montrer.
  const fromNode = !state.editing && state.linkNodeAfterCreate != null;
  const nodeToLink = state.linkNodeAfterCreate;
  try {
    const saved = state.editing
      ? await api.send("PATCH", "/api/issues/" + encodeURIComponent(state.editing.ref), payload)
      : await api.send("POST", "/api/issues", payload);
    if (fromNode) {
      try {
        await api.send("POST", `/api/issues/${encodeURIComponent(saved.ref)}/nodes`, { nodeRef: nodeToLink });
      } catch (e) {
        alert("Entrée créée mais liaison au jalon échouée : " + e.message);
      }
    }
    state.linkNodeAfterCreate = null;
    closeModal();
    await Promise.all([loadList(), loadMeta()]);
    if (fromNode && location.hash !== "") location.hash = ""; // → vue Suivi (switchView via hashchange)
    await selectIssue(saved.ref);
  } catch (e) {
    alert("Échec : " + e.message);
  }
}

// ── Ponts depuis la vue Vibes (jalon → suivi) ────────────────────────────────
// Ouvre la modale de création d'entrée pré-remplie depuis un jalon ; l'entrée sera
// automatiquement liée au nœud à l'enregistrement (cf. saveIssue).
export function createIssueFromNode(node) {
  if (!node) return;
  openModal(null);
  state.linkNodeAfterCreate = node.id;
  $("#modalTitle").textContent = `Nouveau suivi — jalon ${node.ref}`;
  $("#mType").value = "task";
  $("#mTitle").value = node.title || "";
  $("#mDesc").value = `Suivi rattaché au jalon ${node.ref} — ${node.title || ""}`;
  $("#mTitle").focus();
  $("#mTitle").select();
}

// Bascule sur la vue Suivi puis ouvre une entrée (depuis un suivi listé sur un jalon).
export async function openIssueInTrack(ref) {
  if (location.hash !== "") location.hash = ""; // → switchView('track') via hashchange
  await selectIssue(ref);
}

// ── Autocomplete partagé (@ fichier, # nœud, …) ───────────────────────────────
// Moteur générique piloté par des « modes » : chaque mode décrit un caractère
// déclencheur (@/#), comment chercher les suggestions, comment rendre un item et
// quel texte insérer. target = textarea cible ; menu = <ul> piloté ; onChoose =
// callback post-insertion ; mode = mode actif courant.
let menuState = { items: [], active: 0, target: null, menu: null, onChoose: null, mode: null };

export function hideMenu(menu) {
  menu.hidden = true;
  menu.innerHTML = "";
}

function renderMenu(menu, items) {
  menuState.items = items;
  menuState.active = 0;
  if (!items.length) {
    hideMenu(menu);
    return;
  }
  const mode = menuState.mode;
  menu.innerHTML = items
    .map((it, i) => `<li class="${i === 0 ? "active" : ""}" data-i="${i}">${mode.renderItem(it)}</li>`)
    .join("");
  menu.hidden = false;
  menu.querySelectorAll("li").forEach((li) =>
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      chooseMenuItem(Number(li.dataset.i));
    })
  );
}

let searchTimer = null;
// Mode @ : fichiers/dossiers du repo (arbre git), scopés à une branche.
const PATH_MODE = {
  trigger: "@",
  re: /@([A-Za-z0-9_./-]*)$/,
  search(query, cb, ctx) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      try {
        // Scope par branche : celle passée par l'appelant, sinon la branche d'édition.
        const b = ctx.branch != null ? ctx.branch : ($("#mBranch") ? $("#mBranch").value : "") || "";
        const url =
          "/api/paths?q=" + encodeURIComponent(query) + "&limit=20" + (b ? "&branch=" + encodeURIComponent(b) : "");
        cb(await api.get(url));
      } catch {
        cb([]);
      }
    }, 120);
  },
  renderItem(it) {
    const slash = it.path.lastIndexOf("/");
    const dir = slash >= 0 ? it.path.slice(0, slash + 1) : "";
    const base = slash >= 0 ? it.path.slice(slash + 1) : it.path;
    return `<span class="kind">${it.kind === "dir" ? "📁" : "📄"}</span>
        <span><span class="dir">${esc(dir)}</span><span class="base">${esc(base)}</span></span>`;
  },
  insert: (it) => "@" + it.path,
};

// Mode # : nœuds Vibes du repo courant. La forêt est petite : on la charge une
// fois (cache court de 5 s) et on filtre côté client par ref/titre.
let nodeCache = { items: null, at: 0 };
async function fetchForestNodes() {
  const now = performance.now();
  if (nodeCache.items && now - nodeCache.at < 5000) return nodeCache.items;
  const items = await api.get("/api/nodes?view=forest");
  nodeCache = { items: Array.isArray(items) ? items : [], at: now };
  return nodeCache.items;
}
const NODE_MODE = {
  trigger: "#",
  re: /#([A-Za-z0-9_-]*)$/,
  search(query, cb) {
    fetchForestNodes()
      .then((nodes) => {
        const q = (query || "").toLowerCase().replace(/^node-/, "");
        const items = nodes
          .filter((n) => {
            if (!q) return true;
            return String(n.ref).includes(q) || (n.title || "").toLowerCase().includes(q);
          })
          .slice(0, 20);
        cb(items);
      })
      .catch(() => cb([]));
  },
  renderItem(it) {
    return `<span class="kind">${esc(it.emoji || "🎯")}</span>
        <span><span class="dir">NODE-${it.ref} </span><span class="base">${esc(it.title || "")}</span></span>`;
  },
  insert: (it) => "#NODE-" + it.ref,
};

function chooseMenuItem(i) {
  const item = menuState.items[i];
  if (!item) return;
  const mode = menuState.mode;
  if (!mode) return;
  // Remplace le token déclencheur en cours par le texte du mode, dans le textarea ciblé.
  const ta = menuState.target;
  if (!ta) return;
  const pos = ta.selectionStart;
  const before = ta.value.slice(0, pos);
  const at = before.lastIndexOf(mode.trigger);
  const text = mode.insert(item);
  ta.value = before.slice(0, at) + text + " " + ta.value.slice(pos);
  const newPos = at + text.length + 1;
  ta.setSelectionRange(newPos, newPos);
  ta.focus();
  if (menuState.menu) hideMenu(menuState.menu);
  if (typeof menuState.onChoose === "function") menuState.onChoose();
}

// Cœur générique : essaie chaque mode (un seul peut matcher en fin de saisie,
// les tokens @… et #… sont mutuellement exclusifs) et pilote le menu donné.
function runMention(ta, menu, modes, ctx, onChoose) {
  const before = ta.value.slice(0, ta.selectionStart);
  for (const mode of modes) {
    const match = before.match(mode.re);
    if (!match) continue;
    menuState.target = ta;
    menuState.menu = menu;
    menuState.onChoose = onChoose || null;
    menuState.mode = mode;
    // Ignore une réponse périmée si le mode a changé entre-temps.
    mode.search(match[1], (items) => { if (menuState.mode === mode) renderMenu(menu, items); }, ctx);
    return;
  }
  hideMenu(menu);
}

// Autocomplete @ fichier (description d'entrée, éditeur de notes…).
export function handleMentionInput(ta, menu, branch, onChoose) {
  runMention(ta, menu, [PATH_MODE], { branch }, onChoose);
}

// Autocomplete de chat : @ fichier + # nœud.
export function handleChatMention(ta, menu, branch, onChoose) {
  runMention(ta, menu, [PATH_MODE, NODE_MODE], { branch }, onChoose);
}

function moveMenu(menu, dir) {
  const lis = menu.querySelectorAll("li");
  if (!lis.length) return;
  lis[menuState.active]?.classList.remove("active");
  menuState.active = (menuState.active + dir + lis.length) % lis.length;
  lis[menuState.active]?.classList.add("active");
  lis[menuState.active]?.scrollIntoView({ block: "nearest" });
}

// Description (modale entrée) : maj des refs + autocomplete @ scopé à la branche éditée.
function onDescInput() {
  syncMentionsFromDesc();
  handleMentionInput($("#mDesc"), $("#mentionMenu"), $("#mBranch").value || "", syncMentionsFromDesc);
}

export function menuKeydown(menu, e) {
  if (menu.hidden) return false;
  if (e.key === "ArrowDown") { e.preventDefault(); moveMenu(menu, 1); return true; }
  if (e.key === "ArrowUp") { e.preventDefault(); moveMenu(menu, -1); return true; }
  if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); chooseMenuItem(menuState.active); return true; }
  if (e.key === "Escape") { hideMenu(menu); return true; }
  return false;
}

// ── Wiring ───────────────────────────────────────────────────────────────────
export function init() {
  $("#newBtn").addEventListener("click", () => openModal(null));
  $("#updateBtn").addEventListener("click", (e) => updateRepo(e.currentTarget));
  $("#cancelBtn").addEventListener("click", closeModal);
  $("#saveBtn").addEventListener("click", saveIssue);
  $("#backdrop").addEventListener("mousedown", (e) => {
    if (e.target === $("#backdrop")) closeModal();
  });

  let filterTimer = null;
  const onFilter = () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(loadList, 180);
  };
  $("#search").addEventListener("input", onFilter);
  ["#fType", "#fStatus", "#fPriority"].forEach((s) => $(s).addEventListener("change", loadList));
  // Sélecteur de branche (topbar) : filtre la liste + défaut des nouvelles entrées.
  $("#branchSel").addEventListener("change", (e) => {
    state.branch = e.target.value;
    loadList();
  });
  // Sélecteur de repo (topbar, multi-repos) + ajout d'un repo.
  $("#repoSel")?.addEventListener("change", (e) => onRepoChange(e.target.value));
  $("#addRepoBtn")?.addEventListener("click", addRepoPrompt);
  $("#importReposBtn")?.addEventListener("click", importReposPrompt);
  $("#removeRepoBtn")?.addEventListener("click", removeRepoPrompt);

  const desc = $("#mDesc");
  desc.addEventListener("input", onDescInput);
  desc.addEventListener("keydown", (e) => menuKeydown($("#mentionMenu"), e));
  desc.addEventListener("blur", () => setTimeout(() => hideMenu($("#mentionMenu")), 150));

  // Changer la branche dans la modale ré-cible l'autocomplete @ (rien d'autre à faire).
  $("#improveBtn").addEventListener("click", improveDescription);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#backdrop").hidden) closeModal();
  });

  initDragReorder(); // glisser-déposer de la liste (ordre manuel)

  // Bouton ⟳ du panneau « Activité des agents » (dans le <summary> → empêcher le toggle).
  $("#runRefresh")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    loadRuns();
  });

  // loadRepos d'abord (fixe le repo actif), puis le reste utilise ?repo=.
  loadRepos().then(() => {
    loadMeta();
    loadBranches();
    loadList();
    loadRuns(); // flux d'activité des agents (runs repo-level)
    subscribeIssues(); // flux temps réel des entrées (issues:changed) du repo actif
  });
}
