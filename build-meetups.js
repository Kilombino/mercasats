/**
 * Build public/meetups.json from 2140meetups.com.
 *
 * - Reads the public map geo.json (markers: name, coords, url).
 * - Keeps only Spain (bbox incl. Canary Islands).
 * - Scrapes each meetup page for og:image + contact links (Telegram, X, IG, Nostr, web).
 *
 * Usage: node build-meetups.js   (run from the project dir)
 * Re-run periodically to refresh.
 */
const fs = require('fs');
const { execSync } = require('child_process');

const GEO_URL = 'https://2140meetups.com/wp-content/uploads/map/geo.json';
const inSpain = (lon, lat) => lon >= -19 && lon <= 5 && lat >= 27 && lat <= 44;

function fetchText(url) {
  try { return execSync(`curl -sL --max-time 25 ${JSON.stringify(url)}`, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }); }
  catch (e) { return ''; }
}

function extractContacts(html) {
  const out = [];
  const seen = new Set();
  const add = (type, value, url, extra) => { const k = type + value; if (!seen.has(k)) { seen.add(k); out.push({ type, value, url, ...(extra || {}) }); } };
  let m;
  // Telegram (skip the generic site bot)
  const tg = /(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{3,})/g;
  while ((m = tg.exec(html))) { if (!/meetups2140_bot/i.test(m[1])) add('telegram', '@' + m[1], 'https://t.me/' + m[1]); }
  // X / Twitter
  const tw = /(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{2,15})(?:[\/?"']|$)/g;
  while ((m = tw.exec(html))) { if (!/(intent|share|home|hashtag)/i.test(m[1])) add('x', '@' + m[1], 'https://x.com/' + m[1]); }
  // Instagram
  const ig = /instagram\.com\/([A-Za-z0-9_.]{2,30})/g;
  while ((m = ig.exec(html))) { if (!/(p|reel|explore)$/i.test(m[1])) add('instagram', '@' + m[1], 'https://instagram.com/' + m[1]); }
  // Nostr npub (skip the generic 2140meetups site npub)
  const SITE_NPUB = 'npub1meetupwe3jvc7vgw86s75l5a6r57rs4rkqfjcfj0qgv9g883jwmsjn33sj';
  const np = /(npub1[02-9ac-hj-np-z]{58})/g;
  while ((m = np.exec(html))) { if (m[1] !== SITE_NPUB) add('nostr', m[1].slice(0, 12) + '…', 'nostr:' + m[1], { copy: m[1] }); }
  return out.slice(0, 8);
}

(async () => {
  const geo = JSON.parse(fetchText(GEO_URL));
  const spain = geo.features.filter(f => {
    const c = (f.geometry.coordinates || []).map(Number);
    return c.length === 2 && inSpain(c[0], c[1]);
  });
  console.log(`geo: ${geo.features.length} total, ${spain.length} in Spain`);

  const meetups = [];
  for (let i = 0; i < spain.length; i++) {
    const f = spain[i];
    const [lon, lat] = f.geometry.coordinates.map(Number);
    const p = f.properties || {};
    const html = p.url ? fetchText(p.url) : '';
    const imgM = html.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i)
      || html.match(/content=["']([^"']+)["']\s+property=["']og:image["']/i);
    const image = imgM ? imgM[1] : null;
    const contacts = html ? extractContacts(html) : [];
    meetups.push({ id: p.id, name: p.name, lat, lng: lon, url: p.url || null, color: p['marker-color'] || '#FA402B', image, contacts });
    process.stdout.write(`\r  scraped ${i + 1}/${spain.length}  `);
  }
  console.log('');

  // Add a Trobades node meetup at the centroid of each Catalan zone (the nodes).
  try {
    const turf = require('@turf/turf');
    const zones = JSON.parse(fs.readFileSync('public/zones-geo.json', 'utf8')).zones;
    const NODES = ['barcelona', 'maresme', 'valles', 'osona', 'girona', 'emporda', 'tarragona', 'baixllobregat', 'garraf', 'penedes', 'lleida', 'zaragoza'];
    // Telegram subgroup thread id per node.
    const THREADS = {
      barcelona: 1379, valles: 1315, tarragona: 2337, osona: 2057, penedes: 1275, lleida: 1291,
      girona: 1812, zaragoza: 5568, garraf: 2682, maresme: 1307, baixllobregat: 1286, emporda: 2504,
    };
    for (const zid of NODES) {
      const z = zones[zid]; if (!z) continue;
      const c = turf.centroid({ type: 'Feature', geometry: z.geometry }).geometry.coordinates;
      const thread = THREADS[zid];
      const tgUrl = thread ? `https://t.me/trobadesbitcoiners/${thread}` : 'https://t.me/trobadesbitcoiners';
      meetups.push({
        id: 'trobades-' + zid, name: 'Trobades · ' + z.name, lat: +c[1].toFixed(5), lng: +c[0].toFixed(5),
        image: 'https://mercasats.kilombino.com/trobades-logo.jpg', color: '#f7931a', trobades: true,
        // no `url` → no "Veure Trobades" button (trobades.kilombino.com doesn't exist yet)
        contacts: [{ type: 'telegram', value: 'Subgrup ' + z.name, url: tgUrl }],
      });
    }
    console.log('added', NODES.length, 'Trobades node meetups');
  } catch (e) { console.error('trobades nodes error:', e.message); }

  const out = { source: 'https://2140meetups.com/', count: meetups.length, meetups };
  fs.writeFileSync('public/meetups.json', JSON.stringify(out));
  const withImg = meetups.filter(m => m.image).length, withC = meetups.filter(m => m.contacts.length).length;
  console.log(`wrote public/meetups.json — ${meetups.length} meetups, ${withImg} with image, ${withC} with contacts`);
})();
