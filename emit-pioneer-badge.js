/**
 * Emite la medalla NIP-58 "Merca-Sats V.1 — Pioneros del Mercado Descentralizado"
 * bajo la npub de Trobades Bitcoiners (clave NOSTR_NSEC_HEX, la misma del backend).
 *
 * - kind 30009: definición de la medalla (replaceable por d-tag).
 * - kind 8: concesión (award) con un tag `p` por cada npub registrado a fecha de
 *   ejecución (snapshot en vivo de npub_profiles).
 *
 * Programado para el 27-jun-2026 vía pioneer-badge.timer. Antes de emitir espera
 * a que la cadena de Bitcoin alcance el bloque 955559 (con un tope de espera).
 *
 * Pruebas sin publicar:  DRY_RUN=1 node emit-pioneer-badge.js
 */
const fs = require('fs');
const path = require('path');
const { finalizeEvent, getPublicKey } = require('nostr-tools/pure');
const { publishToRelays } = require('./nostr-publish.js');
const Database = require('better-sqlite3');

const TARGET_BLOCK = 955559;
const WAIT_DEADLINE_MS = 14 * 3600 * 1000; // si el bloque tarda, emite igualmente tras 14h
const POLL_MS = 60000;
const BADGE_D = 'mercasats-v1-pioneers';
const IMG = 'https://mercasats.kilombino.com/photos/mercasats-v1-pioneers.jpg';
const DIM = '1254x1254';
const DRY = !!process.env.DRY_RUN;

const hex = process.env.NOSTR_NSEC_HEX;
if (!hex) { console.error('[pioneer] NOSTR_NSEC_HEX ausente — abortando'); process.exit(1); }
const sk = Uint8Array.from(Buffer.from(hex, 'hex'));
const pk = getPublicKey(sk);

async function tipHeight() {
  const urls = [
    'https://mempool.space/api/blocks/tip/height',
    'https://blockstream.info/api/blocks/tip/height',
  ];
  for (const u of urls) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
      if (r.ok) { const h = parseInt((await r.text()).trim(), 10); if (Number.isFinite(h)) return h; }
    } catch (e) { /* prueba la siguiente */ }
  }
  return null;
}

async function waitForBlock() {
  const start = Date.now();
  for (;;) {
    const h = await tipHeight();
    console.log(new Date().toISOString(), '[pioneer] tip height:', h, '/ objetivo', TARGET_BLOCK);
    if (h && h >= TARGET_BLOCK) { console.log('[pioneer] bloque objetivo alcanzado'); return h; }
    if (Date.now() - start > WAIT_DEADLINE_MS) { console.log('[pioneer] tope de espera superado, emito igualmente'); return h; }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

function recipients() {
  const f = ['mercasats.db', 'merkasats.db'].map(p => path.join(__dirname, p)).find(p => fs.existsSync(p));
  const db = new Database(f, { readonly: true });
  const rows = db.prepare('SELECT npub FROM npub_profiles WHERE npub IS NOT NULL').all();
  db.close();
  const set = new Set();
  for (const r of rows) {
    const h = String(r.npub || '').toLowerCase();
    if (/^[0-9a-f]{64}$/.test(h) && h !== pk) set.add(h); // hex válido, sin el propio emisor
  }
  return [...set];
}

(async () => {
  const height = DRY ? '(dry)' : await waitForBlock();
  const now = Math.floor(Date.now() / 1000);

  const def = finalizeEvent({
    kind: 30009,
    created_at: now,
    tags: [
      ['d', BADGE_D],
      ['name', 'Merca-Sats V.1 — Pionero'],
      ['description', 'Pionero del mercado descentralizado. Registrado en Merca-Sats antes del bloque 955559 de Bitcoin (27 jun 2026). Emitida por Trobades Bitcoiners.'],
      ['image', IMG, DIM],
      ['thumb', IMG, DIM],
    ],
    content: '',
  }, sk);

  const aTag = `30009:${pk}:${BADGE_D}`;
  const rcpts = recipients();

  const award = finalizeEvent({
    kind: 8,
    created_at: now,
    tags: [
      ['a', aTag],
      ...rcpts.map(h => ['p', h]),
    ],
    content: '',
  }, sk);

  console.log(`[pioneer] emisor (Trobades) pk: ${pk}`);
  console.log(`[pioneer] bloque: ${height} · destinatarios: ${rcpts.length}`);
  console.log(`[pioneer] def kind 30009 id ${def.id.slice(0, 12)} · award kind 8 id ${award.id.slice(0, 12)}`);

  if (DRY) { console.log('[pioneer] DRY_RUN — no se publica'); process.exit(0); }

  for (const ev of [def, award]) {
    const res = await publishToRelays(ev);
    const ok = res.filter(r => r.ok).length;
    console.log(`[pioneer] kind ${ev.kind} ${ev.id.slice(0, 12)} → ${ok}/${res.length} relés`);
  }
  console.log('[pioneer] HECHO');
  process.exit(0);
})();
