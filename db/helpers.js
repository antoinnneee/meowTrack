// db/helpers.js — helpers PURS (sans connexion) de normalisation des valeurs.
//
// Module FEUILLE : ne dépend que de db/constants.js. Partagé par les modules de
// domaine (nodes/messages) — extrait ici pour éviter qu'ils se couplent entre eux
// juste pour un helper de troncature.

import { MAX_NOTES, MAX_NOTE_COUNT, DATE_RE } from "./constants.js";

export function clampStr(v, max) {
  return String(v ?? "").slice(0, max);
}

export function clampEmoji(v) {
  const s = String(v ?? "").trim();
  if (!s) return "🎯";
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return [...seg.segment(s)].slice(0, 2).map((x) => x.segment).join("") || "🎯";
  } catch {
    return s.slice(0, 8) || "🎯";
  }
}

// Notes : JSON [{title, body}] tronqué/borné, tolérant à une legacy string brute.
export function parseNotes(raw) {
  const s = String(raw || "");
  if (!s.trim()) return [];
  try {
    const a = JSON.parse(s);
    if (Array.isArray(a)) {
      return a
        .map((n) => ({ title: clampStr(n && n.title, 200), body: clampStr(n && n.body, MAX_NOTES) }))
        .filter((n) => n.title || n.body)
        .slice(0, MAX_NOTE_COUNT);
    }
  } catch {
    /* pas du JSON → legacy string */
  }
  return [{ title: "", body: clampStr(s, MAX_NOTES) }];
}

export function normalizeNotesInput(input) {
  let arr;
  if (Array.isArray(input)) arr = input;
  else if (typeof input === "string") arr = input.trim() ? [{ title: "", body: input }] : [];
  else if (input && typeof input === "object") arr = [input];
  else arr = [];
  arr = arr
    .map((n) => ({ title: clampStr(n && n.title, 200), body: clampStr(n && n.body, MAX_NOTES) }))
    .filter((n) => n.title || n.body)
    .slice(0, MAX_NOTE_COUNT);
  return JSON.stringify(arr);
}

export function validDateOrNull(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (!DATE_RE.test(s)) throw new Error(`Date invalide (attendu YYYY-MM-DD) : ${s}`);
  return s;
}
