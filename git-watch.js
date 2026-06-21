// git-watch.js — surveillance fs LAZY du working tree d'un dépôt → diffuse `git:changed`
// sur le canal SSE `git:<repoId>` quand des fichiers bougent (édition hors dashboard).
//
// Cycle de vie lié aux abonnés du flux : un watcher n'existe QUE tant qu'au moins un
// client SSE est branché sur la room git du dépôt (compteur de références). Tout est
// best-effort : si fs.watch échoue (plateforme, EMFILE…), on retombe sur les diffusions
// post-mutation (routes/git.js) et le bouton « rafraîchir ». Debounce 600 ms ; on ignore
// le bruit interne de .git (sauf HEAD/index/refs, pertinents) et node_modules.

import { watch } from "node:fs";
import { rootForRepo } from "./repos.js";
import { isGitClone } from "./repo.js";
import { gitKey, broadcast } from "./sse.js";

const watchers = new Map(); // repoId → { watcher, count, timer }

export function addGitWatcher(repoId) {
  const existing = watchers.get(repoId);
  if (existing) {
    existing.count++;
    return;
  }
  let root;
  try {
    root = rootForRepo(repoId);
  } catch {
    return;
  }
  if (!isGitClone(root)) return;
  let watcher;
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      const f = String(filename || "").replace(/\\/g, "/");
      if (/(^|\/)node_modules\//.test(f)) return;
      // Bruit interne de .git : on garde uniquement les fichiers qui changent l'état vu
      // par status/log (HEAD, index, MERGE_HEAD…, refs/) et on jette le reste (objets, logs).
      if (/(^|\/)\.git\//.test(f) && !/(^|\/)\.git\/(HEAD|index|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|ORIG_HEAD|refs\/)/.test(f)) return;
      const cur = watchers.get(repoId);
      if (!cur || cur.timer) return; // debounce : une seule diffusion par fenêtre
      cur.timer = setTimeout(() => {
        cur.timer = null;
        broadcast(gitKey(repoId), "git:changed", { repoId });
      }, 600);
    });
  } catch {
    return; // recursive non supporté / quota : best-effort, on abandonne le watcher
  }
  watcher.on("error", () => {});
  watchers.set(repoId, { watcher, count: 1, timer: null });
}

export function removeGitWatcher(repoId) {
  const w = watchers.get(repoId);
  if (!w) return;
  w.count--;
  if (w.count > 0) return;
  try {
    w.watcher.close();
  } catch {
    /* ignore */
  }
  if (w.timer) clearTimeout(w.timer);
  watchers.delete(repoId);
}
