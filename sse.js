// sse.js — temps réel Vibes : broadcaster SSE en mémoire + ouverture de flux.
//
// channels: clé → Set<client> ; clé = `node:<repoId>:<id>` (room d'un nœud) |
// `forest:<repoId>` (forêt d'UN repo — multi-repos : un repo n'entend jamais les
// events d'un autre). On persiste d'ABORD (transaction synchrone better-sqlite3),
// puis on broadcast l'état committé (re-SELECT) — jamais d'optimistic serveur ni la
// sortie IA brute.

import { getNode, nodePathIds } from "./db.js";
import { send } from "./http-util.js";

// Clé du canal forêt d'un repo.
export function forestKey(repoId) {
  return `forest:${repoId}`;
}
// Clé du canal « gestionnaire git » d'un repo : working tree / branches / historique.
// Le serveur y diffuse `git:changed` après chaque mutation git ET sur changement de
// fichier détecté (git-watch.js) → la vue se rafraîchit sans bouton (et multi-onglets).
export function gitKey(repoId) {
  return `git:${repoId}`;
}
// Clé de la room d'un nœud. NAMESPACÉE PAR REPO : avec une base SQLite par dépôt,
// les ids de nœuds ne sont plus globalement uniques (chaque base repart à 1) → sans
// le repoId, deux dépôts partageant un même id se mélangeraient sur la même room.
export function nodeKey(repoId, id) {
  return `node:${repoId}:${id}`;
}

const channels = new Map();
let eventSeq = 0;
let sseClientCount = 0;
const MAX_SSE_CLIENTS = 200;
const MAX_PER_CHANNEL = 40;

function channelFor(key) {
  let s = channels.get(key);
  if (!s) {
    s = new Set();
    channels.set(key, s);
  }
  return s;
}

// Écrit une frame SSE. Back-pressure "two-strike" : un 2e write bloqué consécutif
// détruit le socket (jamais de file non bornée par client). Renvoie false si mort.
function sseSend(c, type, data, id) {
  try {
    const ok = c.res.write(`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    if (ok === false) {
      if (c.stalled) {
        c.res.destroy();
        return false;
      }
      c.stalled = true;
    } else {
      c.stalled = false;
    }
    return true;
  } catch {
    try {
      c.res.destroy();
    } catch {
      /* ignore */
    }
    return false;
  }
}

function removeClient(c) {
  const set = channels.get(c.key);
  if (set) {
    set.delete(c);
    if (!set.size) channels.delete(c.key);
  }
  if (!c.removed) {
    c.removed = true;
    sseClientCount = Math.max(0, sseClientCount - 1);
  }
}

export function broadcast(key, type, data) {
  const id = ++eventSeq;
  const set = channels.get(key);
  if (!set) return;
  for (const c of [...set]) if (!sseSend(c, type, data, id)) removeClient(c);
}

// Diffuse un nœud complet committé (room du nœud + forêt). Réconcilié par `version`.
export function broadcastNode(repoId, id) {
  const n = getNode(id, { repoId });
  if (!n) return;
  broadcast(nodeKey(repoId, id), "node:updated", n);
  broadcast(forestKey(n.repoId), "node:updated", n);
}
// Diffuse les nœuds affectés par une mutation (ids = nœud muté + sa chaîne
// d'ancêtres, dont la progression a bougé). Pour chacun : `node:updated` (room +
// forêt) ET une sonnette `subtree:dirty` à sa room → toute vue détail rootée sur
// un ancêtre re-fetch son sous-arbre (auto-correcteur, robuste).
export function broadcastAffected(repoId, ids) {
  for (const id of ids || []) {
    broadcastNode(repoId, id);
    broadcast(nodeKey(repoId, id), "subtree:dirty", { changedId: id, rootId: id });
  }
}
// Rafraîchit la chaîne racine→anchor : progression (node:updated) + sonnette
// subtree:dirty à chaque ancêtre. Utilisé par create/delete/move/reorder (où la
// db ne renvoie pas la liste affectée).
export function refreshAncestors(repoId, anchorId, changedId) {
  const path = nodePathIds(anchorId, repoId); // [root, …, anchor]
  for (const id of path) {
    broadcastNode(repoId, id);
    broadcast(nodeKey(repoId, id), "subtree:dirty", { changedId: changedId ?? anchorId, rootId: id });
  }
}
export function broadcastMessage(repoId, nodeId, msg) {
  if (!msg) return; // nœud supprimé pendant le tour IA → message introuvable
  broadcast(nodeKey(repoId, nodeId), "message", msg);
}
// Diffuse un message du chat « top level » sur la room forêt du repo (réutilise le
// canal `forest:<repoId>` auquel le front est déjà abonné via /api/nodes/stream).
export function broadcastForestMessage(repoId, msg) {
  if (!msg) return;
  broadcast(forestKey(repoId), "message", msg);
}

// Ouvre un flux SSE (text/event-stream). Auth déjà validée par le gate /api/*
// (token en ?token=). Caps globaux + par canal, heartbeat externe (setInterval).
export function openStream(req, res, key) {
  if (sseClientCount >= MAX_SSE_CLIENTS) return send(res, 503, { error: "too_many_streams" });
  const set = channelFor(key);
  if (set.size >= MAX_PER_CHANNEL) return send(res, 503, { error: "channel_full" });
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  const c = { res, key, stalled: false, removed: false };
  set.add(c);
  sseClientCount++;
  sseSend(c, "hello", { channel: key, serverSeq: eventSeq }, ++eventSeq);
  req.on("close", () => removeClient(c));
  req.on("error", () => removeClient(c));
}

// Heartbeat : commentaire SSE toutes les 15 s ; détecte/évince les sockets morts.
setInterval(() => {
  for (const set of channels.values()) {
    for (const c of [...set]) {
      try {
        if (c.res.write(": ping\n\n") === false) {
          if (c.stalled) removeClient(c);
          else c.stalled = true;
        }
      } catch {
        removeClient(c);
      }
    }
  }
}, 15000).unref();
