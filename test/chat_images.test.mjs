// Test NODE-350 : envoi d'images dans le chat IA.
// Le CLI `claude` n'a PAS de flag --image ; le vecteur natif est `--input-format
// stream-json` avec un bloc {type:"image", source:{type:"base64", media_type, data}}.
// On vérifie ici la VALIDATION fail-closed (normalizeChatImages) et la CONSTRUCTION
// du message stream-json (chatStreamInput), côté serveur — sans spawner le CLI.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "meowtrack-img-"));
process.env.MEOWTRACK_DB = join(TMP, "meowtrack.db");
process.env.MEOWTRACK_NO_LISTEN = "1";
process.env.MEOWTRACK_CLAUDE_BIN = "claude-test-bin";

const { normalizeChatImages, chatStreamInput, IMAGE_MIME } = await import("../ai/claude.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

// Magic bytes réels par format (suffixe arbitraire pour donner un buffer non vide).
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(8)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(8)]);
const b64 = (buf) => buf.toString("base64");

try {
  // ── Cas nominal : un PNG valide bien déclaré ────────────────────────────────
  const ok = normalizeChatImages([{ mimeType: "image/png", data: b64(PNG) }]);
  check("PNG valide accepté", ok.length === 1 && ok[0].mediaType === "image/png");
  check("base64 re-encodé canonique", ok[0].data === b64(PNG));

  // Tous les formats de l'allowlist passent.
  check("JPEG accepté", normalizeChatImages([{ mimeType: "image/jpeg", data: b64(JPEG) }]).length === 1);
  check("GIF accepté", normalizeChatImages([{ mimeType: "image/gif", data: b64(GIF) }]).length === 1);
  check("WEBP accepté", normalizeChatImages([{ mimeType: "image/webp", data: b64(WEBP) }]).length === 1);

  // Data URL acceptée (préfixe strippé).
  check("data URL acceptée", normalizeChatImages([{ mimeType: "image/png", data: "data:image/png;base64," + b64(PNG) }]).length === 1);

  // ── Entrées vides / nulles → tableau vide, pas d'erreur ─────────────────────
  check("null → []", normalizeChatImages(null).length === 0);
  check("undefined → []", normalizeChatImages(undefined).length === 0);
  check("[] → []", normalizeChatImages([]).length === 0);

  // ── Fail-closed ─────────────────────────────────────────────────────────────
  check("non-tableau rejeté", throws(() => normalizeChatImages({ mimeType: "image/png", data: b64(PNG) })));
  check("MIME hors allowlist rejeté", throws(() => normalizeChatImages([{ mimeType: "image/svg+xml", data: b64(PNG) }])));
  check("MIME absent rejeté", throws(() => normalizeChatImages([{ data: b64(PNG) }])));
  check("base64 vide rejeté", throws(() => normalizeChatImages([{ mimeType: "image/png", data: "" }])));
  // Magic bytes ≠ MIME déclaré : du JPEG annoncé en PNG → rejet (anti-spoof).
  check("magic bytes incohérents rejetés", throws(() => normalizeChatImages([{ mimeType: "image/png", data: b64(JPEG) }])));
  // Contenu non-image (texte) → magic bytes inconnus → rejet.
  check("contenu non-image rejeté", throws(() => normalizeChatImages([{ mimeType: "image/png", data: b64(Buffer.from("pas une image")) }])));
  // Trop d'images (> 4).
  check("plus de 4 images rejeté", throws(() => normalizeChatImages(Array(5).fill({ mimeType: "image/png", data: b64(PNG) }))));
  // Image trop lourde (> 5 Mo).
  const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 1)]);
  check("image > 5 Mo rejetée", throws(() => normalizeChatImages([{ mimeType: "image/png", data: b64(big) }])));

  // ── chatStreamInput : message user stream-json bien formé ───────────────────
  const imgs = normalizeChatImages([{ mimeType: "image/png", data: b64(PNG) }, { mimeType: "image/jpeg", data: b64(JPEG) }]);
  const line = chatStreamInput("Décris ces images", imgs);
  const parsed = JSON.parse(line);
  check("type=user", parsed.type === "user");
  check("role=user", parsed.message.role === "user");
  check("1er bloc = texte du prompt", parsed.message.content[0].type === "text" && parsed.message.content[0].text === "Décris ces images");
  check("2 blocs image suivent", parsed.message.content.length === 3 && parsed.message.content[1].type === "image" && parsed.message.content[2].type === "image");
  check("source base64 + media_type", parsed.message.content[1].source.type === "base64" && parsed.message.content[1].source.media_type === "image/png");
  check("data du bloc = base64 image", parsed.message.content[1].source.data === b64(PNG));
  check("ligne JSON unique (pas de \\n interne)", !line.includes("\n"));

  // Sans image : un seul bloc texte (prompt brut conservé).
  const only = JSON.parse(chatStreamInput("juste du texte", []));
  check("sans image : 1 seul bloc texte", only.message.content.length === 1 && only.message.content[0].text === "juste du texte");

  // L'allowlist est bien celle attendue.
  check("allowlist MIME = png/jpeg/gif/webp", IMAGE_MIME.has("image/png") && IMAGE_MIME.has("image/jpeg") && IMAGE_MIME.has("image/gif") && IMAGE_MIME.has("image/webp") && !IMAGE_MIME.has("image/svg+xml"));

  console.log(`\n${pass} OK, ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("Erreur de test:", e);
  process.exit(1);
}
