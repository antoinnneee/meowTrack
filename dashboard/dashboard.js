// dashboard.js — front du suivi Meowtrack. Vanilla JS, aucune dépendance.
"use strict";

const $ = (sel) => document.querySelector(sel);

// Token d'accès (serveur déployé protégé par MEOWTRACK_TOKEN). Stocké localement,
// envoyé en Bearer. Sur 401 on (re)demande le token et on réessaie une fois.
function getToken() {
  return localStorage.getItem("meowtrack_token") || "";
}
function promptToken() {
  const t = window.prompt("Token d'accès Meowtrack (MEOWTRACK_TOKEN du serveur) :", getToken());
  if (t === null) return null;
  localStorage.setItem("meowtrack_token", t.trim());
  return t.trim();
}
function authHeaders(extra = {}) {
  const t = getToken();
  return t ? { ...extra, Authorization: "Bearer " + t } : extra;
}

// ── Repo actif (multi-repos) ─────────────────────────────────────────────────
// Slug du repo courant, persisté localement. Injecté en `?repo=` sur toutes les
// requêtes /api/* SAUF la gestion du registre (/api/repos*, qui cible par chemin).
function activeRepo() {
  return localStorage.getItem("meowtrack_repo") || "";
}
function setActiveRepo(slug) {
  localStorage.setItem("meowtrack_repo", slug || "");
}
function injectRepo(url) {
  if (!url.startsWith("/api/") || url.startsWith("/api/repos")) return url;
  const r = activeRepo();
  if (!r) return url;
  return url + (url.includes("?") ? "&" : "?") + "repo=" + encodeURIComponent(r);
}

const api = {
  async _do(method, url, body, retried) {
    const r = await fetch(injectRepo(url), {
      method,
      headers: authHeaders(body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401 && !retried) {
      if (promptToken() !== null) return api._do(method, url, body, true);
    }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  },
  get(url) {
    return api._do("GET", url, undefined, false);
  },
  send(method, url, body) {
    return api._do(method, url, body, false);
  },
};

const TYPE_ICON = { bug: "🐞", feature: "✨", task: "✅", chore: "🧹" };
const STATUS_LABEL = { open: "Ouvert", in_progress: "En cours", done: "Fait", wontfix: "Abandonné" };
const PRIO_LABEL = { critical: "Critique", high: "Haute", medium: "Moyenne", low: "Basse" };

let state = { issues: [], selected: null, editing: null, refs: [], branch: "", branches: [], serverBranch: null, repos: [] };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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
// vue Good Vibes si elle est ouverte — forêt + flux SSE du nouveau repo).
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

function hideMenu(menu) {
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
function handleMentionInput(ta, menu, branch, onChoose) {
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

function menuKeydown(menu, e) {
  if (menu.hidden) return false;
  if (e.key === "ArrowDown") { e.preventDefault(); moveMenu(menu, 1); return true; }
  if (e.key === "ArrowUp") { e.preventDefault(); moveMenu(menu, -1); return true; }
  if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); chooseMenuItem(menuState.active); return true; }
  if (e.key === "Escape") { hideMenu(menu); return true; }
  return false;
}

// ── Wiring ───────────────────────────────────────────────────────────────────
function init() {
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

document.addEventListener("DOMContentLoaded", init);

// ═══════════════════════════════════════════════════════════════════════════
// Good Vibes v2 — arbre de NŒUDS récursif, graphe organique, chat IA streaming.
// Réutilise les helpers du Suivi ($/esc/api/getToken). N'altère PAS init().
// ═══════════════════════════════════════════════════════════════════════════

const NODE_STATUS_LABEL = { active: "🌱 Actif", paused: "⏸️ En pause", done: "🏆 Atteint", abandoned: "🪦 Abandonné" };
const NODE_COLORS = ["accent", "feature", "task", "bug", "high"];

// Palette « par cascade » : chaque sous-arbre de 1er niveau (tête de cascade =
// nœud de profondeur 1) reçoit une teinte distincte, héritée par ses descendants.
// Couleurs vives lisibles sur le thème sombre. Les nœuds de structure (profondeur 0
// : N0 + légendes) restent neutres pour faire ressortir les cascades.
const CASCADE_PALETTE = ["#4dabf7", "#69db7c", "#ffd43b", "#ff8787", "#da77f2", "#ffa94d", "#3bc9db", "#a9e34b", "#f783ac", "#9775fa"];
const CASCADE_NEUTRAL = "#868e96";

const vibes = {
  view: "track",
  layout: localStorage.getItem("meowtrack_layout") || "graph", // graph | grid
  es: null,
  current: null, // ref du nœud ouvert (détail)
  currentNode: null,
  currentVersion: null,
  forest: [],
  byId: new Map(),
  seen: new Set(), // ids de messages rendus
  streams: new Map(), // turnId → { reasoning, text, reasoningEl, bodyEl }
  dirtyTimer: null,
  forestTimer: null,
  model: "sonnet",
  user: "",
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
    posMap: new Map(),      // id → {x,y} résolu au dernier rendu (drag live + arêtes)
    nodeDrag: null,         // déplacement d'un nœud (et de son sous-arbre) en cours
    linking: null,          // id source pendant « tirer un lien »
    edgeDel: null,          // { childId, parentId } de l'arête dont la poubelle est affichée
    pendingCreatePos: null, // position graphe où créer le prochain nœud (menu fond)
    suppressClick: false,   // ignore le prochain click (après un drag)
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
  typingSel: "#typingRow",
  emptyHtml: '<div class="empty">Discute de ce nœud : décris-le, demande des sous-jalons…</div>',
  url: (sub) => `/api/nodes/${encodeURIComponent(vibes.current)}${sub || ""}`,
  ready: () => !!vibes.current,
};
const FOREST_CHAT_CTX = {
  kind: "forest",
  feedSel: "#forestChatFeed",
  inputSel: "#forestChatInput",
  typingSel: "#forestTypingRow",
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
function toast(msg) {
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
  return (g.spawned.has(id) ? " spawn" : "") + (g.pulsed.has(id) ? " pulse" : "") + (g.celebrated.has(id) ? " celebrate" : "");
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
function renderMarkdown(src) {
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
}
function childrenOf(id) {
  return vibes.forest.filter((n) => n.parentId === id).sort((a, b) => a.position - b.position || a.id - b.id);
}
function rootsOf() {
  return vibes.forest.filter((n) => n.parentId == null).sort((a, b) => a.position - b.position || a.id - b.id);
}

// ── Navigation entre vues ────────────────────────────────────────────────────
function switchView(v) {
  if (v !== "vibes" && v !== "repo") v = "track";
  vibes.view = v;
  document.body.classList.remove("view-track", "view-vibes", "view-repo");
  document.body.classList.add("view-" + v);
  document.querySelectorAll(".nav-tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.view === v));
  $("#trackView").hidden = v !== "track";
  $("#repoView").hidden = v !== "repo";
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
}

// Affiche/masque le panneau de chat « top level » (vue objectifs, hors détail nœud).
function setForestChatVisible(on) {
  const el = $("#forestChat");
  if (el) el.hidden = !on;
}

async function openVibes() {
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
    indexForest(await api.get("/api/nodes?view=forest"));
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

// ── Grille (racines) ─────────────────────────────────────────────────────────
function nodeCardHtml(n) {
  return `<div class="goal-card status-${esc(n.status)}${nodeFxClass(n.id)}" data-ref="${esc(n.ref)}" data-id="${n.id}" style="--gc:var(--${esc(n.color || "accent")})">
    <div class="gc-top"><span class="gc-emoji">${esc(n.emoji || "🎯")}</span><span class="gc-title">${esc(n.title)}</span></div>
    <div class="gc-ref">${esc(n.ref)}${n.targetDate ? ` · 📅 ${esc(n.targetDate)}` : ""}</div>
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
function computeGraphLayout() {
  const pos = new Map();
  // Rangée du haut ALIGNÉE : chaque RACINE (N0 + légendes) occupe un emplacement
  // uniforme (G_NODE_GAP), branchée ou non → les N0 forment une ligne nette. Le
  // sous-arbre de chaque racine est calculé tidy (placeSubtree) dans une map locale,
  // puis recentré SOUS sa racine. Une cascade large déborde sous la rangée, mais sans
  // chevauchement de nœuds (profondeurs = lignes différentes).
  let rowX = 0;
  const tidy = new Map(); // layout auto « idéal » (relatif à la hiérarchie)
  for (const root of rootsOf()) {
    const local = new Map();
    placeSubtree(root, local, { x: 0 });
    const shift = rowX - local.get(root.id).x; // recale la racine sur la rangée
    for (const [id, p] of local) tidy.set(id, { x: p.x + shift, y: p.y });
    rowX += G_NODE_GAP;
  }
  // Positions finales : on part du tidy-layout, mais chaque nœud ÉPINGLÉ (drag & drop
  // persisté) « entraîne » tout son sous-arbre auto en le décalant du même delta. Ainsi
  // un nouvel enfant (pos NULL = auto) d'un parent déplacé apparaît À CÔTÉ de ce parent,
  // pas à l'emplacement tidy global. Un descendant lui-même épinglé redéfinit le delta
  // pour son propre sous-arbre.
  const place = (node, dx, dy) => {
    const t = tidy.get(node.id) || { x: 0, y: 0 };
    let x, y;
    if (node.posX != null && node.posY != null) {
      x = node.posX; y = node.posY;
      dx = x - t.x; dy = y - t.y; // nouveau delta hérité par le sous-arbre
    } else {
      x = t.x + dx; y = t.y + dy;
    }
    pos.set(node.id, { x, y });
    for (const k of childrenOf(node.id)) place(k, dx, dy);
  };
  for (const root of rootsOf()) place(root, 0, 0);
  return pos;
}
// Post-ordre : pose d'abord les feuilles à la suite, puis centre chaque parent sur
// l'intervalle [1re feuille … dernière feuille] de ses enfants. Y = profondeur.
function placeSubtree(node, pos, cur) {
  const y = (node.depth || 0) * G_LEVEL_GAP;
  const kids = childrenOf(node.id);
  if (!kids.length) {
    pos.set(node.id, { x: cur.x, y });
    cur.x += G_NODE_GAP;
    return;
  }
  for (const k of kids) placeSubtree(k, pos, cur);
  const first = pos.get(kids[0].id).x;
  const last = pos.get(kids[kids.length - 1].id).x;
  pos.set(node.id, { x: (first + last) / 2, y });
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
    class: "g-edge" + (vibes.graph.spawned.has(node.id) ? " spawn" : ""),
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
  const fxCls = (spawn ? " spawn" : "") + (pulse ? " pulse" : "") + (celebrate ? " celebrate" : "");
  const g = svgEl("g", { transform: `translate(${p.x},${p.y})`, class: "g-node status-" + n.status + fxCls, "data-ref": n.ref, "data-id": String(n.id) });
  // Tooltip natif : le label étant tronqué, le survol révèle le titre complet.
  const ttl = svgEl("title", {});
  ttl.textContent = n.title;
  g.appendChild(ttl);
  // Onde de choc (naissance) et rayons (jalon atteint) : sous le nœud (peints en premier).
  if (spawn) g.appendChild(svgEl("circle", { r: 10, class: "g-halo", stroke: cascadeColorOf(n) }));
  if (celebrate) g.appendChild(raysGroup());
  // Groupe interne mis à l'échelle pour l'anim d'apparition (le translate reste sur g).
  const inner = svgEl("g", { class: "g-inner" });
  const circ = 2 * Math.PI * (r + 5);
  inner.appendChild(svgEl("circle", { r: r + 5, class: "g-track" }));
  inner.appendChild(svgEl("circle", { r: r + 5, class: "g-ring", "stroke-dasharray": `${(circ * n.progress) / 100} ${circ}`, transform: "rotate(-90)" }));
  inner.appendChild(svgEl("circle", { r, class: "g-disc", fill: cascadeColorOf(n) }));
  const emo = svgEl("text", { class: "g-emoji", "text-anchor": "middle", dy: "0.35em", "font-size": String(Math.round(r)) });
  emo.textContent = n.emoji || "🎯";
  inner.appendChild(emo);
  const lbl = svgEl("text", { class: "g-label", "text-anchor": "middle", y: String(r + 18) });
  lbl.textContent = n.title.length > 18 ? n.title.slice(0, 17) + "…" : n.title;
  inner.appendChild(lbl);
  g.appendChild(inner);
  return g;
}
// Positions des nœuds fantômes (chat « top level ») dans le graphe. Les racines
// (sans parent) prolongent la rangée du haut après les vraies racines ; les sous-
// jalons fantômes se posent sous leur parent (réel via parentId, ou fantôme via
// parentKey — l'IA écrit le parent avant l'enfant, donc gpos le connaît déjà).
function computeGhostPositions(pos) {
  const gpos = new Map();
  let maxRootX = -Infinity;
  for (const r of rootsOf()) { const p = pos.get(r.id); if (p) maxRootX = Math.max(maxRootX, p.x); }
  if (maxRootX === -Infinity) maxRootX = -G_NODE_GAP; // aucune racine réelle → démarre à 0
  const childIdx = new Map(); // parent → nb d'enfants fantômes déjà posés
  let rootI = 0;
  for (const gh of vibes._ghostNodes) {
    let parentPos = null, pkey = null;
    if (gh.parentKey && gpos.has(gh.parentKey)) { parentPos = gpos.get(gh.parentKey); pkey = "k:" + gh.parentKey; }
    else if (gh.parentId != null && pos.has(gh.parentId)) { parentPos = pos.get(gh.parentId); pkey = "n:" + gh.parentId; }
    if (parentPos) {
      const c = childIdx.get(pkey) || 0; childIdx.set(pkey, c + 1);
      gpos.set(gh.key, { x: parentPos.x + c * G_NODE_GAP, y: parentPos.y + G_LEVEL_GAP });
    } else {
      gpos.set(gh.key, { x: maxRootX + ++rootI * G_NODE_GAP, y: 0 }); // racine fantôme
    }
  }
  return gpos;
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
function renderGraph() {
  const svg = $("#graphSvg");
  if (!svg || $("#graphView").hidden) return;
  buildCascadeColors();         // teintes par cascade, recalculées à chaque rendu
  const pos = computeGraphLayout();
  vibes.graph.posMap = pos;     // réutilisé par le drag live et le recalcul des arêtes
  vibes.graph.edgeDel = null;   // l'overlay poubelle (re)disparaît au rendu
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const gEdges = svgEl("g", { class: "g-edges" });
  const gNodes = svgEl("g", { class: "g-nodes" });
  svg.appendChild(gEdges);
  svg.appendChild(gNodes);
  for (const n of vibes.forest) {
    if (n.parentId == null) continue;
    const pp = pos.get(n.parentId), pc = pos.get(n.id);
    if (pp && pc) gEdges.appendChild(edgePath(pp, pc, n));
  }
  for (const n of vibes.forest) {
    const pp = pos.get(n.id);
    if (pp) gNodes.appendChild(nodeGroup(n, pp));
  }
  // Aperçu fantôme (chat « top level ») : arêtes + nœuds non persistés, par-dessus.
  const gpos = vibes._ghostNodes.length ? computeGhostPositions(pos) : null;
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
  let fitPos = pos;
  if (gpos && gpos.size) { fitPos = new Map(pos); let i = 0; for (const v of gpos.values()) fitPos.set("ghost:" + i++, v); }
  if (!vibes.graph.userView) fitView(fitPos, svg);
  else applyViewBox(svg);
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
  if (vibes.graph.edgeDel) positionEdgeDel();
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

// ── Menu contextuel générique (clic droit) ───────────────────────────────────
function hideCtxMenu() {
  const m = document.getElementById("ctxMenu");
  if (m) m.remove();
  document.removeEventListener("mousedown", _ctxOutside, true);
}
function _ctxOutside(e) { if (!e.target.closest("#ctxMenu")) hideCtxMenu(); }
function showCtxMenu(clientX, clientY, items) {
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

// ── Mode « tirer un lien » (connecter deux nœuds = reparentage) ───────────────
function startLinkMode(sourceId) {
  cancelLinkMode();
  vibes.graph.linking = sourceId;
  const line = svgEl("path", { class: "g-link-temp", d: "" });
  $("#graphSvg").insertBefore(line, $("#graphSvg").firstChild);
  vibes.graph._linkLine = line;
  toast("Clique le nœud à rattacher comme enfant (Échap pour annuler).");
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
  cancelLinkMode();
  if (!sourceId || targetId == null || targetId === sourceId) return;
  try {
    // « Tirer un lien depuis A vers B » = B devient enfant de A.
    await api.send("POST", `/api/nodes/${encodeURIComponent(targetId)}/move`, { newParentId: sourceId });
    vibes.graph.spawned.add(targetId);
    toast("Lien créé.");
    loadForest();
  } catch (e) {
    toast(/cycle|sous-arbre/i.test(e.message) ? "Impossible : créerait un cycle." : "Échec : " + e.message);
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

  // mousedown : démarre soit un drag de nœud (sur un nœud), soit un pan (sur le fond).
  svg.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return; // gauche uniquement (le clic droit → contextmenu)
    if (vibes.graph.linking) return; // en mode lien : la sélection se fait au click
    if (e.target.closest("#gEdgeDel")) return; // clic sur la poubelle : géré par son handler
    hideCtxMenu();
    hideEdgeDel();
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

  // click : ouvre un nœud (sauf juste après un drag) ou finalise un lien.
  svg.addEventListener("click", (e) => {
    if (vibes.graph.suppressClick) { vibes.graph.suppressClick = false; return; }
    const gNode = e.target.closest(".g-node");
    if (vibes.graph.linking) {
      if (gNode) finishLink(Number(gNode.dataset.id));
      else cancelLinkMode();
      return;
    }
    if (gNode) openNode(gNode.dataset.ref);
  });

  // double-clic sur une arête → affiche la poubelle de suppression de lien.
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
      showCtxMenu(e.clientX, e.clientY, [
        { label: "🔗 Tirer un lien…", onClick: () => startLinkMode(id) },
        { label: "✎ Ouvrir", onClick: () => openNode(ref) },
        { label: "🗑 Supprimer", danger: true, onClick: () => { if (confirm("Supprimer ce nœud et tout son sous-arbre ?")) deleteNodeById(id); } },
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
    // Fond : créer un nouveau nœud à cet endroit.
    const at = clientToSvg(e.clientX, e.clientY);
    showCtxMenu(e.clientX, e.clientY, [
      { label: "➕ Nouvel objectif ici", onClick: () => { vibes.graph.pendingCreatePos = at; openNodeModal(null, null); } },
    ]);
  });

  $("#graphFit").addEventListener("click", () => {
    vibes.graph.userView = false;
    renderGraph();
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
async function openNode(ref) {
  try {
    closeStream();
    const node = await api.get(`/api/nodes/${encodeURIComponent(ref)}?tree=true&messages=true`);
    vibes.current = ref;
    vibes.currentNode = node;
    vibes.currentVersion = node.version;
    vibes.chat = NODE_CHAT_CTX; // chat actif = ce nœud
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
    subscribeNode(ref);
  } catch (e) {
    toast("Erreur : " + e.message);
  }
}
function renderNodeHeader(n) {
  $("#ndEmoji").textContent = n.emoji || "🎯";
  $("#ndTitle").textContent = n.title;
  $("#ndRef").textContent = n.ref;
  $("#ndStatus").textContent = NODE_STATUS_LABEL[n.status] || n.status;
  $("#ndBar").style.width = n.progress + "%";
  $("#ndPct").textContent = n.progress + "%";
  const tgt = $("#ndTarget");
  if (n.targetDate) { tgt.textContent = "📅 " + n.targetDate; tgt.hidden = false; } else tgt.hidden = true;
  const desc = $("#ndDesc");
  desc.textContent = n.description || "";
  desc.hidden = !n.description;
  renderNotes(n);
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
      const isOpen = open.size ? open.has(i) : true; // tout déplié par défaut
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
  return `<li class="tnode" data-ref="${esc(n.ref)}" data-id="${n.id}" style="--d:${depth}">
    <div class="trow ms-${esc(n.status)}${fxCls}" style="--si:${si}">
      <span class="tdot" style="background:var(--${esc(n.color || "accent")})"></span>
      <span class="temoji">${esc(n.emoji || "🎯")}</span>
      <span class="ttitle" title="Ouvrir le chat de ce nœud">${esc(n.title)}</span>
      <span class="tpct">${n.progress}%</span>
      <select class="tstatus" title="Statut">${["active", "paused", "done", "abandoned"].map((s) => `<option value="${s}" ${s === n.status ? "selected" : ""}>${esc(NODE_STATUS_LABEL[s])}</option>`).join("")}</select>
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
    default: return o.op || "action";
  }
}
function actionChipsHtml(m) {
  if (!Array.isArray(m.actions) || !m.actions.length) return "";
  const entry = m.actions[0] || {};
  const ops = entry.ops || [];
  if (!ops.length && !entry.proposed) return "";
  const chips = ops.map((o) => `<span class="action-chip${o.op === "delete_node" ? " danger" : ""}">${esc(opLabel(o))}</span>`).join("");
  const confirm = entry.proposed ? `<button class="confirm-actions" type="button">Confirmer</button>` : "";
  return `<div class="action-chips">${chips}${confirm}</div>`;
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
    body.textContent = m.body || "";
    if (!m.body) {
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
      div.appendChild(node);
    }
  }
  return div;
}
function appendMessage(m) {
  const feed = chatFeedEl();
  if (!feed) return;
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
    if (s.bodyEl) s.bodyEl.textContent = s.text;
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
async function sendChat() {
  const ctx = vibes.chat;
  const ta = $(ctx.inputSel);
  if (!ta) return;
  const text = ta.value.trim();
  if (!text || !ctx.ready()) return;
  const nonce = crypto.randomUUID ? crypto.randomUUID() : "n" + Date.now() + Math.floor(Math.random() * 1e6);
  vibes.stickToBottom = true; // envoyer un message réactive le suivi du bas
  appendMessage({ id: 0, role: "user", author: vibes.user, body: text, state: "complete", clientNonce: nonce });
  ta.value = "";
  try {
    await api.send("POST", ctx.url("/chat"), { author: vibes.user, model: vibes.model, body: text, clientNonce: nonce });
  } catch (e) {
    if (/ai_busy/.test(e.message)) toast(ctx.kind === "forest" ? "Claude répond déjà au niveau objectifs — attends la fin du tour." : "Claude répond déjà sur ce nœud — attends la fin du tour.");
    else if (/ai_overloaded/.test(e.message)) toast("Trop de discussions IA en cours, réessaie dans un instant.");
    else toast("Échec : " + e.message);
    chatFeedEl()?.querySelector(`[data-nonce="${cssId(nonce)}"]`)?.remove();
    ta.value = text;
  }
}
async function confirmActions(messageId) {
  try {
    await api.send("POST", vibes.chat.url("/chat/confirm"), { messageId });
  } catch (e) {
    toast(e.message);
  }
}
async function clearChatHistory() {
  const ctx = vibes.chat;
  if (!ctx.ready()) return;
  const what = ctx.kind === "forest" ? "de la discussion des objectifs" : "de la discussion de ce nœud";
  if (!confirm(`Vider tout l'historique ${what} ? (irréversible)`)) return;
  try {
    await api.send("DELETE", ctx.url("/messages"));
    renderChat([]); // vidage local immédiat (l'événement chat:cleared confirmera aux autres)
    toast("Historique vidé.");
  } catch (e) {
    if (/ai_busy/.test(e.message)) toast("Claude répond en ce moment — réessaie après le tour.");
    else toast("Échec : " + e.message);
  }
}
// Charge l'historique du chat « top level » (forêt) et le rend.
async function loadForestChat() {
  try {
    renderChat(await api.get("/api/forest/messages"));
  } catch {
    renderChat([]);
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
// Affiche/masque la ligne « Claude travaille… » du chat ACTIF (nœud ou forêt).
function applyAiTurnEvent(d) {
  const row = $(vibes.chat.typingSel);
  if (!row) return;
  row.hidden = d.state !== "start";
  if (d.state === "start") row.textContent = `✨ ${d.actor ? d.actor + " — " : ""}Claude travaille…`;
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
    if (d.state === "start" || d.state === "end") clearGhostsForest(); // début/fin → les vrais nœuds remplacent les fantômes
  });
  es.addEventListener("node:ghost", (e) => applyGhostForest(JSON.parse(e.data)));
  es.addEventListener("chat:cleared", () => renderChat([]));
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
  es.addEventListener("node:deleted", () => loadForest());
  es.addEventListener("node:reparented", () => loadForest());
  es.addEventListener("nodes:reordered", () => loadForest());
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
    applyAiTurnEvent(d); // ligne « Claude travaille… » du chat actif
    if (d.state === "start" || d.state === "end") clearGhostsDetail(); // fin/début → les vrais nœuds (refetch) remplacent les fantômes
  });
  es.addEventListener("node:ghost", (e) => applyGhostDetail(JSON.parse(e.data)));
  es.addEventListener("node:updated", (e) => applyNodeUpdate(JSON.parse(e.data)));
  es.addEventListener("subtree:dirty", () => scheduleSubtreeRefetch());
  es.addEventListener("chat:cleared", () => renderChat([])); // un autre client a vidé l'historique
  es.addEventListener("node:deleted", (e) => {
    const d = JSON.parse(e.data);
    if (vibes.currentNode && d.id === vibes.currentNode.id) { toast("Ce nœud a été supprimé."); backToForest(); }
    else scheduleSubtreeRefetch();
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
function openNodeModal(node, parentId) {
  vibes._editing = node || null;
  vibes._parentId = node ? null : parentId != null ? parentId : null;
  $("#nodeModalTitle").textContent = node ? `Éditer ${node.ref}` : parentId != null ? "Nouveau sous-jalon" : "Nouvel objectif";
  $("#nEmoji").value = node?.emoji || "🎯";
  $("#nStatus").value = node?.status || "active";
  $("#nTarget").value = node?.targetDate || "";
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
    targetDate: $("#nTarget").value || null,
    title: $("#nTitle").value.trim(),
    description: $("#nDesc").value,
    color: vibes._color,
  };
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
      const n = await api.send("POST", "/api/nodes", payload);
      $("#nodeBackdrop").hidden = true;
      vibes.graph.spawned.add(n.id); // anime aussi la naissance pour le créateur local
      // Création via le menu contextuel du fond → épingle le nœud à l'endroit cliqué.
      const at = vibes.graph.pendingCreatePos;
      vibes.graph.pendingCreatePos = null;
      if (at) {
        n.posX = at.x; n.posY = at.y;
        vibes.graph.posMap.set(n.id, { x: at.x, y: at.y });
        // Attendre la persistance AVANT loadForest, sinon le rechargement récupère le
        // nœud avec posX/posY encore NULL (course) → il atterrit en auto-layout, pas au clic.
        await persistPositions([n.id]);
      }
      if (vibes.current) scheduleSubtreeRefetch();
      else if (at) loadForest(); // créé via le menu fond → rester sur le graphe pour le voir apparaître
      else { vibes.layout === "graph" ? openNode(n.ref) : loadForest(); }
    }
  } catch (e) {
    if (/version_conflict/.test(e.message)) toast("Nœud modifié entre-temps — rouvre-le.");
    else toast("Échec : " + e.message);
  }
}

// ── Wiring ───────────────────────────────────────────────────────────────────
function initVibes() {
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
  // Notes markdown : éditeur multi-notes (chaque éditeur gère son @ / aperçu).
  $("#ndNotesEditBtn").addEventListener("click", openNotesEditor);
  $("#ndNotesCancelBtn").addEventListener("click", closeNotesEditor);
  $("#ndNotesSaveBtn").addEventListener("click", saveNotes);
  $("#ndNotesAddBtn").addEventListener("click", () => addNoteEditor());
  $("#chatSend").addEventListener("click", sendChat);
  $("#chatClearBtn").addEventListener("click", clearChatHistory);
  // Suivi du scroll : on coupe l'auto-défilement dès que l'utilisateur remonte,
  // on le rétablit quand il revient en bas (pendant la génération comme après).
  $("#chatFeed").addEventListener("scroll", () => { vibes.stickToBottom = isFeedAtBottom($("#chatFeed")); });
  // Autocomplete @ fichier dans le chat (même UX que la modale d'entrée du tracker).
  const chatInput = $("#chatInput");
  const chatMenu = $("#chatMentionMenu");
  chatInput.addEventListener("input", () => handleMentionInput(chatInput, chatMenu, state.branch || "", null));
  chatInput.addEventListener("blur", () => setTimeout(() => hideMenu(chatMenu), 150));
  chatInput.addEventListener("keydown", (e) => {
    if (menuKeydown(chatMenu, e)) return; // menu ouvert : flèches / Entrée / Tab / Échap pour lui
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  $("#modelSel").addEventListener("change", (e) => (vibes.model = e.target.value));
  // Chat « top level » (vue objectifs) — même rendu/flux, contexte forêt.
  $("#forestChatSend").addEventListener("click", sendChat);
  $("#forestChatClearBtn").addEventListener("click", clearChatHistory);
  $("#forestChatToggle").addEventListener("click", () => $("#forestChat").classList.toggle("collapsed"));
  $("#forestChatFeed").addEventListener("scroll", () => { vibes.stickToBottom = isFeedAtBottom($("#forestChatFeed")); });
  const forestChatInput = $("#forestChatInput");
  forestChatInput.addEventListener("keydown", (e) => {
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
  const viewFromHash = () => (location.hash === "#vibes" ? "vibes" : location.hash === "#repo" ? "repo" : "track");
  window.addEventListener("hashchange", () => switchView(viewFromHash()));
  initRepo();
  switchView(viewFromHash()); // état de vue cohérent dès le départ (masque les vues inactives)
}
document.addEventListener("DOMContentLoaded", initVibes);

// ═══════════════════════════════════════════════════════════════════════════
// Gestionnaire de repos (git) — toolbar + sidebar branches + graphe d'historique
// (façon GitKraken) + staging par fichier + commit (message rédigé par claude -p) +
// menus contextuels (branches : merge/rename/delete ; commits : tag/branche/cherry-
// pick/revert/reset) + page de configuration git. Réutilise $/esc/api/showCtxMenu.
// ═══════════════════════════════════════════════════════════════════════════

const LANE_COLORS = ["#7c5cff", "#4dd4ac", "#5a8dee", "#ff9f43", "#ff6b6b", "#e056fd", "#22d3ee", "#f6c945", "#a0d911", "#ff7eb6"];
const laneColor = (k) => LANE_COLORS[((k % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length];

const repoMgr = { status: null, log: null, branches: null, stashes: [], loading: false };

// ── Cycle de vie ──────────────────────────────────────────────────────────────
async function openRepoView() {
  await loadRepoAll();
}
async function refreshRepo() {
  await loadRepoAll();
}
async function loadRepoAll() {
  if (repoMgr.loading) return;
  repoMgr.loading = true;
  try {
    const [st, log, br, stashes] = await Promise.all([
      api.get("/api/git/status").catch((e) => ({ ok: false, output: e.message, files: [] })),
      api.get("/api/git/log?limit=300").catch(() => ({ commits: [], head: null })),
      api.get("/api/git/branches").catch(() => ({ current: null, local: [], remote: [] })),
      api.get("/api/git/stashes").catch(() => []),
    ]);
    repoMgr.status = st;
    repoMgr.log = log;
    repoMgr.branches = br;
    repoMgr.stashes = Array.isArray(stashes) ? stashes : [];
    renderRepoToolbar();
    renderRepoSide();
    renderRepoGraph();
    renderWorkingTree();
  } finally {
    repoMgr.loading = false;
  }
}

// Exécute une opération git mutante, signale l'échec/les conflits, rafraîchit.
async function doGit(call, { confirmMsg } = {}) {
  if (confirmMsg && !confirm(confirmMsg)) return null;
  try {
    const r = await call();
    if (r && r.ok === false) alert("Échec git :\n" + (r.output || "erreur inconnue"));
    else if (r && typeof r.output === "string" && /CONFLICT|conflit|Merge conflict/i.test(r.output)) alert(r.output);
    await refreshRepo();
    return r;
  } catch (e) {
    alert(e.message === "git_busy" ? "Une opération git est déjà en cours sur ce repo." : "Erreur : " + e.message);
    await refreshRepo();
    return null;
  }
}

// ── Toolbar ─────────────────────────────────────────────────────────────────
function renderRepoToolbar() {
  const st = repoMgr.status || {};
  $("#repoBranch").textContent = st.detached ? "(HEAD détaché)" : st.branch || "—";
  const trk = $("#repoTrack");
  if (st.upstream) trk.textContent = `↑${st.ahead || 0} ↓${st.behind || 0} · ${st.upstream}`;
  else trk.textContent = st.branch ? "(pas d'upstream — Push créera le suivi)" : "";
  const setCnt = (id, n) => {
    const el = $(id);
    el.textContent = n > 0 ? n : "";
    el.hidden = !(n > 0);
  };
  setCnt("#rgPullCnt", st.behind || 0);
  setCnt("#rgPushCnt", st.ahead || 0);
  // Cohérence d'activation : Pop seulement s'il y a une remise ; Stash seulement s'il
  // y a des modifications à remiser (symétrie avec les compteurs Pull/Push et Commit).
  $("#rgStashPop").disabled = !repoMgr.stashes.length;
  $("#rgStash").disabled = !((st.files || []).length > 0);
}

// ── Sidebar branches / remotes / stashes ──────────────────────────────────────
function renderRepoSide() {
  const br = repoMgr.branches || { local: [], remote: [] };
  const item = (cls, name, attrs, right) =>
    `<div class="side-item ${cls}" ${attrs}><span class="si-name" title="${esc(name)}">${esc(name)}</span>${right || ""}</div>`;
  let html = "";

  html += `<div class="side-group"><h4>Local <span class="hint">(clic droit : options)</span></h4>`;
  if (!br.local.length) html += `<div class="side-empty">—</div>`;
  for (const b of br.local) {
    const trk = b.ahead || b.behind ? `<span class="si-track">↑${b.ahead} ↓${b.behind}</span>` : "";
    html += item(b.current ? "current local" : "local", b.name, `data-branch="${esc(b.name)}"`, trk);
  }
  html += `</div>`;

  html += `<div class="side-group"><h4>Distant</h4>`;
  if (!br.remote.length) html += `<div class="side-empty">—</div>`;
  for (const b of br.remote) {
    const short = b.name.includes("/") ? b.name.slice(b.name.indexOf("/") + 1) : b.name;
    html += item("remote", b.name, `data-checkout-remote="${esc(short)}" data-remote-full="${esc(b.name)}"`, "");
  }
  html += `</div>`;

  html += `<div class="side-group"><h4>Remises (stash)</h4>`;
  if (!repoMgr.stashes.length) html += `<div class="side-empty">—</div>`;
  for (const s of repoMgr.stashes) html += item("stash", `${s.ref} · ${s.desc}`, "", "");
  html += `</div>`;

  $("#repoSide").innerHTML = html;
}

// Menu contextuel d'une branche locale (clic droit) : checkout, merge, rename, delete.
function branchCtxMenu(name, clientX, clientY) {
  const current = repoMgr.branches && repoMgr.branches.current;
  const items = [];
  if (name !== current) {
    items.push({ label: `Checkout « ${name} »`, onClick: () => doGit(() => api.send("POST", "/api/git/checkout", { name })) });
    items.push({
      label: `Merge « ${name} » dans « ${current || "?"} »`,
      onClick: () => doGit(() => api.send("POST", "/api/git/merge", { name }), { confirmMsg: `Fusionner « ${name} » dans « ${current} » ?` }),
    });
  }
  items.push({
    label: "Renommer…",
    onClick: () => {
      const newName = (window.prompt("Nouveau nom de la branche :", name) || "").trim();
      if (newName && newName !== name) doGit(() => api.send("POST", "/api/git/branch/rename", { oldName: name, newName }));
    },
  });
  if (name !== current) items.push({ label: "Supprimer la branche locale", danger: true, onClick: () => doGitDeleteBranch(name) });
  showCtxMenu(clientX, clientY, items);
}

// Menu contextuel d'une branche distante (clic droit) : checkout (suivi local),
// merge dans la branche courante, suppression côté distant (git push --delete).
function remoteBranchCtxMenu(fullName, shortName, clientX, clientY) {
  const current = repoMgr.branches && repoMgr.branches.current;
  const slash = fullName.indexOf("/");
  const remote = slash > 0 ? fullName.slice(0, slash) : "origin";
  const branch = slash > 0 ? fullName.slice(slash + 1) : fullName;
  const items = [
    { label: `Checkout « ${shortName} » (suivi local)`, onClick: () => doGit(() => api.send("POST", "/api/git/checkout", { name: shortName })) },
    {
      label: `Merge « ${fullName} » dans « ${current || "?"} »`,
      onClick: () => doGit(() => api.send("POST", "/api/git/merge", { name: fullName }), { confirmMsg: `Fusionner « ${fullName} » dans « ${current} » ?` }),
    },
    {
      label: "Supprimer la branche distante",
      danger: true,
      onClick: () =>
        doGit(() => api.send("POST", "/api/git/branch/delete-remote", { remote, branch }), {
          confirmMsg: `⚠️ Supprimer la branche distante « ${fullName} » ?\n\ngit push ${remote} --delete ${branch}\n\nAction irréversible côté serveur distant.`,
        }),
    },
  ];
  showCtxMenu(clientX, clientY, items);
}

// ── Graphe d'historique : calcul des lanes + rendu SVG par ligne ──────────────
function computeLanes(commits, headHash) {
  let lanes = [];
  const rows = [];
  for (const c of commits) {
    const incoming = lanes.slice();
    let col = lanes.indexOf(c.hash);
    if (col === -1) {
      col = lanes.indexOf(null);
      if (col === -1) {
        col = lanes.length;
        lanes.push(null);
      }
    }
    const parentLanes = [];
    if (c.parents.length === 0) {
      lanes[col] = null;
    } else {
      // Libère la colonne du commit : on la réattribuera (peut-être) au 1er parent.
      lanes[col] = null;
      for (let p = 0; p < c.parents.length; p++) {
        const ph = c.parents[p];
        let pk = lanes.indexOf(ph); // une lane porte-t-elle DÉJÀ ce parent ? → dédup
        if (pk === -1) {
          if (p === 0 && lanes[col] == null) pk = col;
          else {
            pk = lanes.indexOf(null);
            if (pk === -1) {
              pk = lanes.length;
              lanes.push(null);
            }
          }
          lanes[pk] = ph;
        }
        if (!parentLanes.includes(pk)) parentLanes.push(pk);
      }
    }
    // Toute AUTRE lane qui attendait c (enfants placés avant dédup, ordre par date) se
    // termine au nœud. Avec la dédup ci-dessus, c'est normalement déjà une seule lane.
    for (let k = 0; k < lanes.length; k++) if (k !== col && incoming[k] === c.hash) lanes[k] = null;
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    rows.push({ commit: c, col, incoming, outgoing: lanes.slice(), parentLanes, isHead: c.hash === headHash });
  }
  // maxLanes inclut col+1 : un tip dont l'unique parent est déjà sur une lane se place
  // sur sa propre colonne puis elle est libérée/élaguée — le nœud doit rester dans le SVG.
  let maxLanes = 1;
  for (const r of rows) maxLanes = Math.max(maxLanes, r.incoming.length, r.outgoing.length, r.col + 1);
  return { rows, maxLanes };
}

function svgRow(row, maxLanes) {
  const W = 18,
    H = 34,
    R = 4.2,
    mid = H / 2;
  const x = (k) => W / 2 + k * W;
  const width = maxLanes * W;
  const out = [];
  const vline = (xx, y1, y2, color) => `<line x1="${xx}" y1="${y1}" x2="${xx}" y2="${y2}" stroke="${color}" stroke-width="2"/>`;
  const curve = (x1, y1, x2, y2, color) =>
    `<path d="M${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}" stroke="${color}" stroke-width="2" fill="none"/>`;
  for (let k = 0; k < row.incoming.length; k++) {
    const h = row.incoming[k];
    if (!h) continue;
    const color = laneColor(k);
    if (h === row.commit.hash) out.push(k === row.col ? vline(x(k), 0, mid, color) : curve(x(k), 0, x(row.col), mid, color));
    else out.push(vline(x(k), 0, mid, color));
  }
  for (let k = 0; k < row.outgoing.length; k++) {
    const h = row.outgoing[k];
    if (!h) continue;
    const color = laneColor(k);
    if (row.incoming[k] === h && row.incoming[k] !== row.commit.hash) out.push(vline(x(k), mid, H, color));
    if (row.parentLanes.includes(k)) out.push(k === row.col ? vline(x(k), mid, H, color) : curve(x(row.col), mid, x(k), H, color));
  }
  const nc = laneColor(row.col);
  out.push(`<circle cx="${x(row.col)}" cy="${mid}" r="${R}" fill="${nc}" stroke="var(--bg)" stroke-width="1.5"/>`);
  if (row.isHead) out.push(`<circle cx="${x(row.col)}" cy="${mid}" r="${R + 3}" fill="none" stroke="${nc}" stroke-width="1.5"/>`);
  return `<svg width="${width}" height="${H}" viewBox="0 0 ${width} ${H}">${out.join("")}</svg>`;
}

function avatarInitials(name) {
  const p = String(name || "?").trim().split(/\s+/);
  return (((p[0] && p[0][0]) || "") + ((p[1] && p[1][0]) || "")).toUpperCase() || "?";
}
function avatarColor(email) {
  let h = 0;
  const s = String(email || "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 52% 46%)`;
}

function renderRepoGraph() {
  const log = repoMgr.log || { commits: [], head: null };
  const pane = $("#repoGraph");
  if (!log.commits.length) {
    pane.innerHTML = `<div class="empty">${repoMgr.status && repoMgr.status.ok === false ? esc(repoMgr.status.output || "Pas un dépôt git.") : "Aucun commit."}</div>`;
    return;
  }
  const { rows, maxLanes } = computeLanes(log.commits, log.head);
  const pill = (r) => `<span class="ref-pill ${r.head ? "head" : r.kind}">${esc(r.name)}</span>`;
  pane.innerHTML = rows
    .map((row) => {
      const c = row.commit;
      const refs = (c.refs || []).map(pill).join("");
      return `<div class="commit-row ${row.isHead ? "head" : ""}" data-hash="${esc(c.hash)}">
        <div class="commit-graph-cell">${svgRow(row, maxLanes)}</div>
        <div class="commit-msg">${refs}<span class="subject">${esc(c.subject)}</span></div>
        <div class="commit-author"><span class="avatar" style="background:${avatarColor(c.email)}">${esc(avatarInitials(c.author))}</span>${esc(c.author)}</div>
        <div class="commit-date" title="${esc(c.dateIso)}">${esc(c.date)}</div>
      </div>`;
    })
    .join("");
}

// Menu contextuel d'un commit (clic droit) : tag, branche ici, checkout, cherry-pick…
function commitCtxMenu(hash, clientX, clientY) {
  const short = (hash || "").slice(0, 8);
  showCtxMenu(clientX, clientY, [
    {
      label: "Créer un tag ici…",
      onClick: () => {
        const name = (window.prompt("Nom du tag :", "") || "").trim();
        if (!name) return;
        const message = (window.prompt("Message du tag (vide = tag léger) :", "") || "").trim();
        doGit(() => api.send("POST", "/api/git/tag", { name, ref: hash, message }));
      },
    },
    {
      label: "Créer une branche ici…",
      onClick: () => {
        const name = (window.prompt("Nom de la branche (créée sur ce commit) :", "") || "").trim();
        if (name) doGit(() => api.send("POST", "/api/git/branch", { name, ref: hash, checkout: true }));
      },
    },
    { label: "Checkout ce commit (HEAD détaché)", onClick: () => doGit(() => api.send("POST", "/api/git/checkout-commit", { hash }), { confirmMsg: `Checkout ${short} en HEAD détaché ?` }) },
    { label: "Cherry-pick sur la branche courante", onClick: () => doGit(() => api.send("POST", "/api/git/cherry-pick", { hash }), { confirmMsg: `Cherry-pick ${short} sur la branche courante ?` }) },
    { label: "Revert ce commit", onClick: () => doGit(() => api.send("POST", "/api/git/revert", { hash }), { confirmMsg: `Créer un commit qui annule ${short} ?` }) },
    { label: "Réinitialiser la branche ici (--mixed)", onClick: () => doGit(() => api.send("POST", "/api/git/reset", { hash, mode: "mixed" }), { confirmMsg: `Déplacer la branche courante sur ${short} (--mixed, garde les modifs) ?` }) },
    { label: "Réinitialiser la branche ici (--hard)", danger: true, onClick: () => doGit(() => api.send("POST", "/api/git/reset", { hash, mode: "hard" }), { confirmMsg: `⚠️ reset --hard sur ${short} : TOUTES les modifications non commitées seront PERDUES. Continuer ?` }) },
    { label: "Copier le hash", onClick: () => { try { navigator.clipboard.writeText(hash); } catch { /* ignore */ } } },
    { label: "Voir le détail", onClick: () => openCommitDetail(hash) },
  ]);
}

// ── Working tree : fichiers non indexés / indexés + commit ────────────────────
const ST_LETTER = { M: "M", A: "A", D: "D", R: "R", C: "C", U: "U", T: "T" };
function fileRow(f, section) {
  const isStaged = section === "staged";
  const code = isStaged ? f.x : f.untracked ? "?" : f.y;
  const letter = f.untracked ? "?" : ST_LETTER[code] || code || "•";
  const stCls = f.conflicted ? "conflict" : f.untracked ? "untracked" : ST_LETTER[code] ? code : "";
  const title = f.conflicted ? "conflit" : f.untracked ? "non suivi" : { M: "modifié", A: "ajouté", D: "supprimé", R: "renommé" }[code] || "modifié";
  const act = isStaged
    ? `<button class="act unstage" data-act="unstage" title="Désindexer">−</button>`
    : `<button class="act discard" data-act="discard" title="Abandonner les modifications">↶</button><button class="act stage" data-act="stage" title="Indexer">＋</button>`;
  return `<li class="wc-file" data-path="${esc(f.path)}" data-staged="${isStaged}" data-untracked="${f.untracked}">
    <span class="st ${stCls}" title="${title}">${esc(letter)}</span>
    <span class="fp" title="${esc(f.path)}"><bdi>${esc(f.path)}</bdi></span>
    ${act}
  </li>`;
}
function renderWorkingTree() {
  const st = repoMgr.status || { files: [] };
  const files = st.files || [];
  const unstaged = files.filter((f) => f.unstaged);
  const staged = files.filter((f) => f.staged);
  $("#wcUnstaged").innerHTML = unstaged.length ? unstaged.map((f) => fileRow(f, "unstaged")).join("") : `<li class="empty">Rien à indexer.</li>`;
  $("#wcStaged").innerHTML = staged.length ? staged.map((f) => fileRow(f, "staged")).join("") : `<li class="empty">Rien d'indexé.</li>`;
  $("#wcUnstagedCount").textContent = unstaged.length;
  $("#wcStagedCount").textContent = staged.length;
  updateCommitBtn();
}
function updateCommitBtn() {
  const staged = ((repoMgr.status && repoMgr.status.files) || []).filter((f) => f.staged).length;
  $("#wcCommitBtn").disabled = !(staged > 0 && $("#wcCommitMsg").value.trim());
}

// ── Diff (fichier ou commit) ──────────────────────────────────────────────────
function renderDiffText(text) {
  if (!text) return '<span class="dl-meta">(aucune différence)</span>';
  return esc(text)
    .split("\n")
    .map((l) => {
      let cls = "";
      if (l.startsWith("+++") || l.startsWith("---")) cls = "dl-meta";
      else if (l.startsWith("@@")) cls = "dl-hunk";
      else if (l.startsWith("+")) cls = "dl-add";
      else if (l.startsWith("-")) cls = "dl-del";
      else if (/^(diff |index |new file|deleted file|rename |similarity |old mode|new mode)/.test(l)) cls = "dl-meta";
      return `<span class="${cls}">${l || " "}</span>`;
    })
    .join("\n");
}
function openDiffModal(title, metaHtml, bodyHtml) {
  $("#diffTitle").textContent = title;
  const meta = $("#diffMeta");
  meta.innerHTML = metaHtml || "";
  meta.hidden = !metaHtml;
  $("#diffBody").innerHTML = bodyHtml;
  $("#diffBackdrop").hidden = false;
}
function closeDiffModal() {
  $("#diffBackdrop").hidden = true;
}
async function openFileDiff(path, staged, untracked) {
  try {
    const r = await api.get(`/api/git/diff?path=${encodeURIComponent(path)}&staged=${staged}&untracked=${untracked}`);
    openDiffModal(path + (staged ? "  (indexé)" : ""), "", renderDiffText(r.diff));
  } catch (e) {
    alert("Erreur diff : " + e.message);
  }
}
async function openCommitDetail(hash) {
  try {
    const d = await api.get("/api/git/commit/" + encodeURIComponent(hash));
    if (d.ok === false) return alert(d.output || "commit introuvable");
    const meta = `${esc(d.author)} &lt;${esc(d.email)}&gt; · ${esc(d.date)} · <span style="font-family:ui-monospace,monospace">${esc((d.hash || "").slice(0, 10))}</span>`;
    const files = (d.files || [])
      .map((f) => `<span class="dl-meta">+${esc(f.added)} -${esc(f.deleted)}</span>  ${esc(f.path)}`)
      .join("\n");
    const body = (d.body ? esc(d.body) + "\n\n" : "") + (files || "(aucun fichier)");
    openDiffModal(d.subject || hash, meta, `<span>${body}</span>`);
  } catch (e) {
    alert("Erreur : " + e.message);
  }
}

// ── Message de commit par l'IA ────────────────────────────────────────────────
async function aiCommitMessage() {
  const btn = $("#wcAiMsg");
  const staged = ((repoMgr.status && repoMgr.status.files) || []).filter((f) => f.staged).length;
  if (!staged) return alert("Indexe d'abord des fichiers : l'IA rédige à partir du diff indexé.");
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "✨ …";
  try {
    const r = await api.send("POST", "/api/git/commit-message", {});
    if (r.message) {
      $("#wcCommitMsg").value = r.message;
      updateCommitBtn();
    }
  } catch (e) {
    alert("Échec IA : " + e.message);
  } finally {
    btn.textContent = old;
    btn.disabled = false;
  }
}

// ── Page de configuration git ─────────────────────────────────────────────────
async function openConfigModal() {
  try {
    const c = await api.get("/api/git/config");
    $("#cfgUserName").value = c.userName || "";
    $("#cfgUserEmail").value = c.userEmail || "";
    $("#cfgAutocrlf").value = c.autocrlf || "";
    $("#cfgPullRebase").value = c.pullRebase || "";
    renderRemotes(c.remotes || []);
    $("#ghDevice").hidden = true;
    $("#cfgBackdrop").hidden = false;
    loadGithubStatus();
    loadCredentials();
  } catch (e) {
    alert("Erreur config : " + e.message);
  }
}
function closeConfigModal() {
  stopGithubPoll();
  $("#cfgBackdrop").hidden = true;
}
function renderRemotes(remotes) {
  const ul = $("#cfgRemotes");
  if (!remotes.length) {
    ul.innerHTML = '<li class="empty" style="font-family:inherit">Aucun remote.</li>';
    return;
  }
  ul.innerHTML = remotes
    .map(
      (r) => `<li>
        <span class="rmt-name">${esc(r.name)}</span>
        <span class="url">${esc(r.fetch || r.push || "")}</span>
        <button class="ghost xs" data-rmt-edit="${esc(r.name)}" title="Modifier l'URL">✎</button>
        <button class="danger xs" data-rmt-del="${esc(r.name)}" title="Supprimer">🗑</button>
      </li>`
    )
    .join("");
}
async function saveConfig() {
  try {
    await api.send("POST", "/api/git/config", {
      userName: $("#cfgUserName").value.trim(),
      userEmail: $("#cfgUserEmail").value.trim(),
      autocrlf: $("#cfgAutocrlf").value,
      pullRebase: $("#cfgPullRebase").value,
    });
    closeConfigModal();
  } catch (e) {
    alert("Échec : " + e.message);
  }
}

// ── GitHub : connexion par device flow ────────────────────────────────────────
const ghAuth = { timer: null, flowId: null };

async function loadGithubStatus() {
  try {
    renderGithubStatus(await api.get("/api/git/github/status"));
  } catch {
    $("#ghStatus").textContent = "État indisponible";
  }
}
function renderGithubStatus(s) {
  const st = $("#ghStatus");
  // Pré-remplit le Client ID (sauf si l'utilisateur est en train de l'éditer).
  const inp = $("#ghClientId");
  if (document.activeElement !== inp) inp.value = s.clientId || "";
  $("#ghClientIdHint").textContent = s.clientIdFromEnv
    ? "Client ID fourni par MEOWTRACK_GITHUB_CLIENT_ID (env) — saisir une valeur ici la remplacera."
    : "OAuth App GitHub avec « Enable Device Flow » — le Client ID n'est pas secret.";
  if (!s.configured) {
    st.textContent = "Renseigne d'abord le Client ID ci-dessus, puis enregistre.";
    $("#ghConnect").hidden = true;
    $("#ghDisconnect").hidden = true;
    return;
  }
  if (s.connected) {
    st.textContent = "✓ Connecté" + (s.username ? " : " + s.username : "");
    $("#ghConnect").hidden = true;
    $("#ghDisconnect").hidden = false;
  } else {
    st.textContent = "Non connecté";
    $("#ghConnect").hidden = false;
    $("#ghDisconnect").hidden = true;
  }
}
function stopGithubPoll() {
  if (ghAuth.timer) clearTimeout(ghAuth.timer);
  ghAuth.timer = null;
  ghAuth.flowId = null;
  $("#ghDevice").hidden = true;
}
async function startGithubConnect() {
  $("#ghConnect").disabled = true;
  try {
    const r = await api.send("POST", "/api/git/github/device/start", {});
    if (r.configured === false) {
      alert(r.message || "OAuth App GitHub non configurée côté serveur.");
      return;
    }
    ghAuth.flowId = r.flowId;
    $("#ghUserCode").textContent = r.userCode || "";
    if (r.verificationUri) $("#ghVerifyLink").href = r.verificationUri;
    $("#ghWait").textContent = "En attente d'autorisation…";
    $("#ghDevice").hidden = false;
    scheduleGithubPoll((r.interval || 5) * 1000);
  } catch (e) {
    alert("Échec : " + e.message);
  } finally {
    $("#ghConnect").disabled = false;
  }
}
function scheduleGithubPoll(ms) {
  ghAuth.timer = setTimeout(githubPollOnce, ms);
}
async function githubPollOnce() {
  if (!ghAuth.flowId) return;
  let interval = 5000;
  try {
    const r = await api.send("POST", "/api/git/github/device/poll", { flowId: ghAuth.flowId });
    if (r.interval) interval = r.interval * 1000;
    if (r.status === "success") {
      stopGithubPoll();
      await loadGithubStatus();
      toast("Connecté à GitHub" + (r.login ? " : " + r.login : ""));
      return;
    }
    if (r.status === "error") {
      $("#ghWait").textContent = "Échec : " + (r.message || "erreur");
      ghAuth.flowId = null; // arrête le polling, garde le panneau pour afficher l'erreur
      return;
    }
    // status "pending" → on continue
  } catch {
    $("#ghWait").textContent = "Erreur réseau, nouvel essai…";
  }
  if (ghAuth.flowId) scheduleGithubPoll(interval);
}
async function disconnectGithub() {
  if (!confirm("Oublier le credential GitHub stocké sur le serveur ?")) return;
  try {
    await api.send("POST", "/api/git/github/disconnect", {});
  } catch (e) {
    alert("Échec : " + e.message);
  }
  await loadGithubStatus();
}
async function saveGithubClientId() {
  const clientId = $("#ghClientId").value.trim();
  try {
    await api.send("POST", "/api/git/github/client-id", { clientId });
    toast(clientId ? "Client ID enregistré" : "Client ID effacé");
    await loadGithubStatus();
  } catch (e) {
    alert("Échec : " + e.message);
  }
}

// ── Credentials HTTP(S) génériques (Gitea/GitLab self-hosted…) ────────────────
async function loadCredentials() {
  try {
    const r = await api.get("/api/git/credentials");
    renderCredentials(r.credentials || []);
  } catch {
    $("#credsList").innerHTML = '<li class="empty" style="font-family:inherit">État indisponible.</li>';
  }
}
function renderCredentials(list) {
  const ul = $("#credsList");
  if (!list.length) {
    ul.innerHTML = '<li class="empty" style="font-family:inherit">Aucun identifiant enregistré.</li>';
    return;
  }
  ul.innerHTML = list
    .map(
      (c) => `<li>
        <span class="rmt-name">${esc(c.protocol)}://${esc(c.host)}</span>
        <span class="url">${esc(c.username || "(sans utilisateur)")} ${c.connected ? "✓" : "⚠️ non vérifié"}</span>
        <button class="ghost xs" data-cred-edit='${esc(JSON.stringify({ protocol: c.protocol, host: c.host, username: c.username }))}' title="Mettre à jour le mot de passe">✎</button>
        <button class="danger xs" data-cred-del='${esc(JSON.stringify({ protocol: c.protocol, host: c.host, username: c.username }))}' title="Supprimer">🗑</button>
      </li>`
    )
    .join("");
}
async function addCredential() {
  const protocol = $("#credProto").value;
  const host = $("#credHost").value.trim();
  const username = $("#credUser").value.trim();
  const password = $("#credPass").value;
  if (!host || !password) return alert("Hôte et mot de passe/token requis.");
  try {
    const r = await api.send("POST", "/api/git/credentials", { protocol, host, username, password });
    if (r.ok === false) return alert("Échec : " + (r.output || "erreur inconnue"));
    $("#credHost").value = "";
    $("#credUser").value = "";
    $("#credPass").value = "";
    toast("Identifiant enregistré");
    await loadCredentials();
  } catch (e) {
    alert("Échec : " + e.message);
  }
}
async function deleteCredential(entry) {
  if (!confirm(`Oublier les identifiants pour ${entry.protocol}://${entry.host} ?`)) return;
  try {
    await api.send("POST", "/api/git/credentials/delete", entry);
  } catch (e) {
    alert("Échec : " + e.message);
  }
  await loadCredentials();
}

// ── Câblage ───────────────────────────────────────────────────────────────────
function initRepo() {
  // Toolbar
  $("#rgFetch").addEventListener("click", () => doGit(() => api.send("POST", "/api/git/fetch", {})));
  $("#rgPull").addEventListener("click", () => doGit(() => api.send("POST", "/api/git/pull", {})));
  $("#rgPush").addEventListener("click", () => {
    const setUpstream = !(repoMgr.status && repoMgr.status.upstream);
    doGit(() => api.send("POST", "/api/git/push", { setUpstream }));
  });
  $("#rgBranch").addEventListener("click", () => {
    const name = (window.prompt("Nom de la nouvelle branche (créée depuis HEAD et checkout) :", "") || "").trim();
    if (name) doGit(() => api.send("POST", "/api/git/branch", { name, checkout: true }));
  });
  $("#rgMerge").addEventListener("click", () => {
    const locals = ((repoMgr.branches && repoMgr.branches.local) || []).filter((b) => !b.current).map((b) => b.name);
    const name = (window.prompt("Branche à fusionner dans la courante" + (locals.length ? ` (ex. ${locals.slice(0, 5).join(", ")})` : "") + " :", "") || "").trim();
    if (name) doGit(() => api.send("POST", "/api/git/merge", { name }), { confirmMsg: `Fusionner « ${name} » dans la branche courante ?` });
  });
  $("#rgStash").addEventListener("click", () => {
    const message = (window.prompt("Message de la remise (stash) — optionnel :", "") || "").trim();
    doGit(() => api.send("POST", "/api/git/stash", { message, includeUntracked: true }));
  });
  $("#rgStashPop").addEventListener("click", () => doGit(() => api.send("POST", "/api/git/stash/pop", {}), { confirmMsg: "Restaurer la dernière remise (stash pop) ?" }));
  $("#rgConfig").addEventListener("click", openConfigModal);
  $("#rgRefresh").addEventListener("click", () => refreshRepo());

  // Working tree : boutons globaux
  $("#wcStageAll").addEventListener("click", () => doGit(() => api.send("POST", "/api/git/stage", { all: true })));
  $("#wcUnstageAll").addEventListener("click", () => doGit(() => api.send("POST", "/api/git/unstage", { all: true })));
  $("#wcAiMsg").addEventListener("click", aiCommitMessage);
  $("#wcCommitMsg").addEventListener("input", updateCommitBtn);
  $("#wcCommitBtn").addEventListener("click", async () => {
    const message = $("#wcCommitMsg").value.trim();
    if (!message) return;
    const r = await doGit(() => api.send("POST", "/api/git/commit", { message }));
    if (r && r.ok !== false) $("#wcCommitMsg").value = "";
  });

  // Délégation : clic sur un fichier (diff) ou ses actions (stage/unstage/discard).
  const onFileClick = (e) => {
    const li = e.target.closest(".wc-file");
    if (!li) return;
    const path = li.dataset.path;
    const staged = li.dataset.staged === "true";
    const untracked = li.dataset.untracked === "true";
    const actBtn = e.target.closest("[data-act]");
    if (actBtn) {
      e.stopPropagation();
      const act = actBtn.dataset.act;
      if (act === "stage") doGit(() => api.send("POST", "/api/git/stage", { paths: [path] }));
      else if (act === "unstage") doGit(() => api.send("POST", "/api/git/unstage", { paths: [path] }));
      else if (act === "discard") doGit(() => api.send("POST", "/api/git/discard", { paths: [path] }), { confirmMsg: `Abandonner les modifications de « ${path} » ? (irréversible)` });
      return;
    }
    openFileDiff(path, staged, untracked);
  };
  $("#wcUnstaged").addEventListener("click", onFileClick);
  $("#wcStaged").addEventListener("click", onFileClick);

  // Graphe : clic gauche = détail ; clic droit = menu contextuel.
  $("#repoGraph").addEventListener("click", (e) => {
    const row = e.target.closest(".commit-row");
    if (row) openCommitDetail(row.dataset.hash);
  });
  $("#repoGraph").addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".commit-row");
    if (!row) return;
    e.preventDefault();
    commitCtxMenu(row.dataset.hash, e.clientX, e.clientY);
  });

  // Sidebar : clic gauche = checkout ; clic droit (branche locale/distante) = menu.
  $("#repoSide").addEventListener("click", (e) => {
    const local = e.target.closest("[data-branch]");
    if (local) {
      if (!local.classList.contains("current")) doGit(() => api.send("POST", "/api/git/checkout", { name: local.dataset.branch }));
      return;
    }
    const remote = e.target.closest("[data-checkout-remote]");
    if (remote) doGit(() => api.send("POST", "/api/git/checkout", { name: remote.dataset.checkoutRemote }));
  });
  $("#repoSide").addEventListener("contextmenu", (e) => {
    const local = e.target.closest("[data-branch]");
    if (local) {
      e.preventDefault();
      branchCtxMenu(local.dataset.branch, e.clientX, e.clientY);
      return;
    }
    const remote = e.target.closest("[data-remote-full]");
    if (remote) {
      e.preventDefault();
      remoteBranchCtxMenu(remote.dataset.remoteFull, remote.dataset.checkoutRemote, e.clientX, e.clientY);
    }
  });

  // Modale diff
  $("#diffClose").addEventListener("click", closeDiffModal);
  $("#diffBackdrop").addEventListener("mousedown", (e) => {
    if (e.target === $("#diffBackdrop")) closeDiffModal();
  });

  // Modale config
  $("#cfgCancel").addEventListener("click", closeConfigModal);
  $("#cfgSave").addEventListener("click", saveConfig);
  $("#cfgBackdrop").addEventListener("mousedown", (e) => {
    if (e.target === $("#cfgBackdrop")) closeConfigModal();
  });
  // Modale config : section GitHub (device flow)
  $("#ghClientIdSave").addEventListener("click", saveGithubClientId);
  $("#ghConnect").addEventListener("click", startGithubConnect);
  $("#ghDisconnect").addEventListener("click", disconnectGithub);
  $("#ghCancel").addEventListener("click", stopGithubPoll);
  $("#ghCopyCode").addEventListener("click", () => {
    const code = $("#ghUserCode").textContent;
    if (code && navigator.clipboard) navigator.clipboard.writeText(code).then(() => toast("Code copié")).catch(() => {});
  });
  // Modale config : credentials HTTP(S) génériques (Gitea/GitLab…)
  $("#credAdd").addEventListener("click", addCredential);
  $("#credPass").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addCredential();
  });
  $("#credsList").addEventListener("click", (e) => {
    const edit = e.target.closest("[data-cred-edit]");
    if (edit) {
      const entry = JSON.parse(edit.dataset.credEdit);
      $("#credProto").value = entry.protocol || "https";
      $("#credHost").value = entry.host || "";
      $("#credUser").value = entry.username || "";
      $("#credPass").value = "";
      $("#credPass").focus();
      return;
    }
    const del = e.target.closest("[data-cred-del]");
    if (del) deleteCredential(JSON.parse(del.dataset.credDel));
  });
  $("#cfgRemoteAdd").addEventListener("click", () => {
    const name = $("#cfgRemoteName").value.trim();
    const url = $("#cfgRemoteUrl").value.trim();
    if (!name || !url) return alert("Nom et URL requis.");
    doGitRemote(() => api.send("POST", "/api/git/remote", { name, url, add: true }));
  });
  $("#cfgRemotes").addEventListener("click", (e) => {
    const edit = e.target.closest("[data-rmt-edit]");
    if (edit) {
      const url = (window.prompt(`Nouvelle URL pour « ${edit.dataset.rmtEdit} » :`, "") || "").trim();
      if (url) doGitRemote(() => api.send("POST", "/api/git/remote", { name: edit.dataset.rmtEdit, url, add: false }));
      return;
    }
    const del = e.target.closest("[data-rmt-del]");
    if (del && confirm(`Supprimer le remote « ${del.dataset.rmtDel} » ?`)) doGitRemote(() => api.send("POST", "/api/git/remote/delete", { name: del.dataset.rmtDel }));
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#diffBackdrop").hidden) closeDiffModal();
    else if (!$("#cfgBackdrop").hidden) closeConfigModal();
  });
}

// Remote ajouté/modifié/supprimé → on recharge la config + on rafraîchit la vue.
async function doGitRemote(call) {
  try {
    const r = await call();
    if (r && r.ok === false) alert("Échec : " + (r.output || "erreur inconnue"));
  } catch (e) {
    alert("Erreur : " + e.message);
  }
  $("#cfgRemoteName").value = "";
  $("#cfgRemoteUrl").value = "";
  try {
    const c = await api.get("/api/git/config");
    renderRemotes(c.remotes || []);
  } catch {
    /* ignore */
  }
  refreshRepo();
}

// Suppression de branche avec repli sur -D (forcé) si non fusionnée.
async function doGitDeleteBranch(name) {
  if (!confirm(`Supprimer la branche « ${name} » ?`)) return;
  try {
    const r = await api.send("POST", "/api/git/branch/delete", { name });
    if (r.ok === false) {
      if (confirm(`Échec : ${r.output}\n\nForcer la suppression (git branch -D) ?`)) {
        const f = await api.send("POST", "/api/git/branch/delete", { name, force: true });
        if (f.ok === false) alert("Échec : " + f.output);
      }
    }
  } catch (e) {
    alert("Erreur : " + e.message);
  }
  await refreshRepo();
}
