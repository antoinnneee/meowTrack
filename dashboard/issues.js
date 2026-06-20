// issues.js — bloc « Suivi » : registre des dépôts (sélecteur), liste/détail des
// entrées, modale de création/édition, et l'autocomplete « @ » partagé (utilisé
// aussi par le bloc Vibes pour les notes et le chat). Importe le noyau et les
// ponts de navigation vers les autres vues.

import { $, esc, api, activeRepo, setActiveRepo } from "./core.js";
import { vibes, openVibes } from "./vibes.js";
import { openRepoView } from "./repo.js";

const TYPE_ICON = { bug: "🐞", feature: "✨", task: "✅", chore: "🧹" };
const STATUS_LABEL = { open: "Ouvert", in_progress: "En cours", done: "Fait", wontfix: "Abandonné" };
const PRIO_LABEL = { critical: "Critique", high: "Haute", medium: "Moyenne", low: "Basse" };

export let state = { issues: [], selected: null, editing: null, refs: [], branch: "", branches: [], serverBranch: null, repos: [] };

// ── Chargement & liste ───────────────────────────────────────────────────────
async function loadMeta() {
  try {
    const m = await api.get("/api/meta");
    const g = m.git || {};
    $("#meta").innerHTML =
      `repo <b>${esc((m.repoRoot || "").split(/[\\/]/).pop())}</b> · ` +
      `branche <b>${esc(g.branch || "?")}</b> @ <b>${esc(g.commit || "?")}</b> · ` +
      `<b>${m.total || 0}</b> entrées (${m.byStatus?.in_progress || 0} en cours, ${m.byStatus?.open || 0} ouvertes)`;
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
  await loadMeta();
  await loadBranches();
  await loadList();
  if (typeof vibes !== "undefined" && vibes.view === "vibes") openVibes();
  else if (typeof vibes !== "undefined" && vibes.view === "repo") openRepoView();
}

// Ajoute un repo via une petite invite (slug + url) puis bascule dessus.
async function addRepoPrompt() {
  const url = (window.prompt("URL git du repo à suivre (laisser vide pour un clone local géré à la main) :", "") || "").trim();
  const slug = (window.prompt("Slug court (identifiant, ex. 'chatserver'). Vide = dérivé de l'URL :", "") || "").trim();
  if (!slug && !url) return;
  try {
    const r = await api.send("POST", "/api/repos", { slug: slug || undefined, url: url || undefined });
    if (r.sync && r.sync.ok === false) alert("Repo ajouté mais clone échoué :\n" + (r.sync.output || "erreur inconnue"));
    await loadRepos();
    await onRepoChange(r.repo.slug);
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
      // Badge branche affiché seulement hors filtre branche (sinon redondant).
      const brBadge = it.branch && !state.branch ? `<span class="badge">⎇ ${esc(it.branch)}</span>` : "";
      const stBadge =
        it.status !== "open" ? `<span class="badge status-${it.status}">${STATUS_LABEL[it.status]}</span>` : "";
      return `<li class="issue-card prio-${it.priority} ${it.status} ${sel}" data-ref="${esc(it.ref)}">
        <div class="row1">
          <span class="code">${esc(it.ref)}</span>
          <span class="title">${esc(it.title)}</span>
        </div>
        <div class="row2">
          <span class="badge type-${it.type}">${TYPE_ICON[it.type]} ${it.type}</span>
          ${stBadge}${brBadge}${refBadge}${tags}
        </div>
      </li>`;
    })
    .join("");
  ul.querySelectorAll(".issue-card").forEach((el) =>
    el.addEventListener("click", () => selectIssue(el.dataset.ref))
  );
}

// ── Détail ───────────────────────────────────────────────────────────────────
async function selectIssue(ref) {
  try {
    state.selected = await api.get("/api/issues/" + encodeURIComponent(ref));
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
  try {
    const saved = state.editing
      ? await api.send("PATCH", "/api/issues/" + encodeURIComponent(state.editing.ref), payload)
      : await api.send("POST", "/api/issues", payload);
    closeModal();
    await Promise.all([loadList(), loadMeta()]);
    await selectIssue(saved.ref);
  } catch (e) {
    alert("Échec : " + e.message);
  }
}

// ── Autocomplete partagé (@ description, chat IA, …) ──────────────────────────
// target = textarea où insérer ; menu = <ul> à piloter ; onChoose = callback post-insertion.
let menuState = { items: [], active: 0, target: null, menu: null, onChoose: null };

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
  menu.innerHTML = items
    .map((it, i) => {
      const slash = it.path.lastIndexOf("/");
      const dir = slash >= 0 ? it.path.slice(0, slash + 1) : "";
      const base = slash >= 0 ? it.path.slice(slash + 1) : it.path;
      return `<li class="${i === 0 ? "active" : ""}" data-i="${i}">
        <span class="kind">${it.kind === "dir" ? "📁" : "📄"}</span>
        <span><span class="dir">${esc(dir)}</span><span class="base">${esc(base)}</span></span>
      </li>`;
    })
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
function debouncedSearch(query, cb, branch) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    try {
      // Scope par branche : celle passée par l'appelant, sinon la branche d'édition.
      const b = branch != null ? branch : ($("#mBranch") ? $("#mBranch").value : "") || "";
      const url =
        "/api/paths?q=" + encodeURIComponent(query) + "&limit=20" + (b ? "&branch=" + encodeURIComponent(b) : "");
      cb(await api.get(url));
    } catch {
      cb([]);
    }
  }, 120);
}

function chooseMenuItem(i) {
  const item = menuState.items[i];
  if (!item) return;
  // Remplace le token @… en cours par le chemin choisi, dans le textarea ciblé.
  const ta = menuState.target;
  if (!ta) return;
  const pos = ta.selectionStart;
  const before = ta.value.slice(0, pos);
  const at = before.lastIndexOf("@");
  ta.value = before.slice(0, at) + "@" + item.path + " " + ta.value.slice(pos);
  const newPos = at + 1 + item.path.length + 1;
  ta.setSelectionRange(newPos, newPos);
  ta.focus();
  if (menuState.menu) hideMenu(menuState.menu);
  if (typeof menuState.onChoose === "function") menuState.onChoose();
}

// Cœur générique : détecte un token @… avant le curseur et pilote le menu donné.
export function handleMentionInput(ta, menu, branch, onChoose) {
  const before = ta.value.slice(0, ta.selectionStart);
  const match = before.match(/@([A-Za-z0-9_./-]*)$/);
  if (!match) {
    hideMenu(menu);
    return;
  }
  menuState.target = ta;
  menuState.menu = menu;
  menuState.onChoose = onChoose || null;
  debouncedSearch(match[1], (items) => renderMenu(menu, items), branch);
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

  const desc = $("#mDesc");
  desc.addEventListener("input", onDescInput);
  desc.addEventListener("keydown", (e) => menuKeydown($("#mentionMenu"), e));
  desc.addEventListener("blur", () => setTimeout(() => hideMenu($("#mentionMenu")), 150));

  // Changer la branche dans la modale ré-cible l'autocomplete @ (rien d'autre à faire).
  $("#improveBtn").addEventListener("click", improveDescription);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#backdrop").hidden) closeModal();
  });

  // loadRepos d'abord (fixe le repo actif), puis le reste utilise ?repo=.
  loadRepos().then(() => {
    loadMeta();
    loadBranches();
    loadList();
  });
}
