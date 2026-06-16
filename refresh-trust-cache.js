/**
 * Refresco diario (03:00) de las reputaciones: recalcula y persiste el score
 * relatr de TODAS las npub registradas, para que la web las sirva al instante.
 * Recorre secuencialmente para no saturar relatr; usa ?force=1 para recalcular
 * aunque el TTL no haya vencido. Los recién registrados que aún no estén
 * cacheados se resuelven aquí (o, si llegan entre refrescos, on-demand al verlos).
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const BRIDGE = process.env.RELATR_BRIDGE || 'http://127.0.0.1:3041';
const PER_CALL_TIMEOUT_MS = 30000; // relatr puede tardar en pubkeys fríos
const GAP_MS = 1500;               // respiro entre llamadas

function registeredHexes() {
  const f = ['mercasats.db', 'merkasats.db'].map(p => path.join(__dirname, p)).find(p => fs.existsSync(p));
  const db = new Database(f, { readonly: true });
  const rows = db.prepare('SELECT DISTINCT npub FROM npub_profiles WHERE npub IS NOT NULL').all();
  db.close();
  return rows.map(r => String(r.npub || '').toLowerCase()).filter(h => /^[0-9a-f]{64}$/.test(h));
}

(async () => {
  const hexes = registeredHexes();
  console.log(`[refresh] ${new Date().toISOString()} — ${hexes.length} npub registradas`);
  let ok = 0, nul = 0, err = 0;
  for (const hex of hexes) {
    try {
      const r = await fetch(`${BRIDGE}/trust/${hex}?force=1`, { signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS) });
      const d = await r.json();
      if (d.score == null) { nul++; console.log(`  ${hex.slice(0, 12)}… sin score`); }
      else { ok++; console.log(`  ${hex.slice(0, 12)}… score ${d.score}`); }
    } catch (e) {
      err++; console.log(`  ${hex.slice(0, 12)}… error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, GAP_MS));
  }
  console.log(`[refresh] hecho — ${ok} con score, ${nul} sin score, ${err} errores`);
  process.exit(0);
})();
