/**
 * Build public/zones-geo.json — a lat/lon GeoJSON bundle for the new Zones map.
 *
 * Inputs (downloaded to /tmp):
 *   - /tmp/es-prov.geojson   : 52 Spanish provinces (codeforgermany)
 *   - /tmp/comarques.json    : 41 Catalan comarques (sirisacademic)
 *
 * Output: public/zones-geo.json = {
 *   spain:  FeatureCollection (all provinces, simplified — background context),
 *   zones:  { id: { name, emoji, color, geometry } }  (clickable zones),
 *   canary: bbox of the Canary Islands (for the inset)
 * }
 */
const fs = require('fs');
const turf = require('@turf/turf');

const prov = JSON.parse(fs.readFileSync('/tmp/es-prov.geojson', 'utf8'));
const com = JSON.parse(fs.readFileSync('/tmp/comarques.json', 'utf8'));

const META = {
  barcelona:    { name: 'Barcelona',      emoji: '🏛️', color: '#E84545' },
  maresme:      { name: 'Maresme',        emoji: '🚢', color: '#7FB8E0' },
  valles:       { name: 'Vallès',         emoji: '🚂', color: '#E89A4C' },
  osona:        { name: 'Osona',          emoji: '🍽', color: '#A8D88A' },
  girona:       { name: 'Girona',         emoji: '⛅', color: '#5BAA47' },
  emporda:      { name: 'Empordà',        emoji: '🏝', color: '#3F9B8A' },
  tarragona:    { name: 'Tarragona',      emoji: '🐟', color: '#B23A2E' },
  baixllobregat:{ name: 'Baix Llobregat', emoji: '🍔', color: '#7A4A3A' },
  garraf:       { name: 'Garraf',         emoji: '🔝', color: '#3F5BAE' },
  penedes:      { name: 'Penedès',        emoji: '⛺', color: '#C24747' },
  lleida:       { name: 'Pla de Lleida',  emoji: '🍸', color: '#F2D97A' },
  zaragoza:     { name: 'Zaragoza',       emoji: '🍑', color: '#C9883A' },
  galicia:      { name: 'Galicia',        emoji: '🐙', color: '#4A90D9' },
  tenerife:     { name: 'Tenerife',       emoji: '🌋', color: '#C0563A' },
  madrid:       { name: 'Madrid',         emoji: '🐻', color: '#9B2242' },
  malaga:       { name: 'Málaga',         emoji: '⛪', color: '#2E8B7A' },
};

// zone -> Catalan comarques (by nom_comar)
const COMARQUES = {
  barcelona:    ['Barcelonès'],
  baixllobregat:['Baix Llobregat'],
  maresme:      ['Maresme'],
  valles:       ['Vallès Occidental', 'Vallès Oriental'],
  osona:        ['Osona'],
  garraf:       ['Garraf'],
  penedes:      ['Alt Penedès', 'Baix Penedès'],
  girona:       ['Gironès', "Pla de l'Estany"],
  emporda:      ['Alt Empordà', 'Baix Empordà'],
  tarragona:    ['Tarragonès', 'Baix Camp'],
  lleida:       ['Segrià', "Pla d'Urgell", 'Urgell', 'Les Garrigues', 'Garrigues'],
};
// zone -> Spanish provinces (by name)
const PROVINCES = {
  zaragoza: ['Zaragoza'],
  galicia:  ['A Coruña', 'Lugo', 'Ourense', 'Pontevedra'],
  madrid:   ['Madrid'],
  malaga:   ['Málaga', 'Malaga'],
};

const comByName = (n) => com.features.find(f => f.properties.nom_comar === n || f.properties.comarca === n);
const provByName = (n) => prov.features.find(f => f.properties.name === n);

function unionAll(features) {
  features = features.filter(Boolean);
  if (!features.length) return null;
  let acc = features[0];
  for (let i = 1; i < features.length; i++) {
    try { acc = turf.union(turf.featureCollection([acc, features[i]])); } catch (e) { /* keep acc */ }
  }
  return acc;
}

function simplify(feat, tol) {
  try { return turf.simplify(feat, { tolerance: tol, highQuality: true, mutate: false }); }
  catch (e) { return feat; }
}

const zones = {};
const missing = [];

for (const id of Object.keys(META)) {
  let feat = null;
  if (COMARQUES[id]) {
    const fs2 = COMARQUES[id].map(n => { const f = comByName(n); if (!f) missing.push(`${id}:${n}`); return f; });
    feat = unionAll(fs2);
  } else if (PROVINCES[id]) {
    const fs2 = PROVINCES[id].map(n => { const f = provByName(n); if (!f) missing.push(`${id}:${n}`); return f; });
    feat = unionAll(fs2);
  } else if (id === 'tenerife') {
    // Largest single polygon of the Santa Cruz de Tenerife province = Tenerife island.
    const p = provByName('Santa Cruz De Tenerife');
    let best = null, bestA = 0;
    for (const poly of p.geometry.coordinates) {
      const f = turf.polygon(poly);
      const a = turf.area(f);
      if (a > bestA) { bestA = a; best = f; }
    }
    feat = best;
  }
  if (!feat) { console.error('NO GEOM for zone', id); continue; }
  feat = simplify(feat, 0.004);
  zones[id] = { name: META[id].name, emoji: META[id].emoji, color: META[id].color, geometry: feat.geometry };
}

// Background: all provinces, simplified hard.
const spain = turf.featureCollection(prov.features.map(f => {
  const s = simplify(f, 0.01);
  return turf.feature(s.geometry, { name: f.properties.name, ccaa: f.properties.cod_ccaa });
}));

// Canary Islands bbox (for the inset): provinces Las Palmas + Santa Cruz de Tenerife.
const canaryProvs = ['Las Palmas', 'Santa Cruz De Tenerife'].map(provByName).filter(Boolean);
const canary = turf.bbox(turf.featureCollection(canaryProvs.map(f => simplify(f, 0.02))));

// Round all coordinates to 4 decimals (~11 m) to cut file size.
function roundCoords(x) {
  if (typeof x === 'number') return Math.round(x * 1e4) / 1e4;
  if (Array.isArray(x)) return x.map(roundCoords);
  return x;
}
for (const id of Object.keys(zones)) zones[id].geometry.coordinates = roundCoords(zones[id].geometry.coordinates);
for (const f of spain.features) f.geometry.coordinates = roundCoords(f.geometry.coordinates);

const out = { spain, zones, canary: canary.map(roundCoords) };
fs.writeFileSync('public/zones-geo.json', JSON.stringify(out));
const kb = Math.round(fs.statSync('public/zones-geo.json').size / 1024);
console.log('zones built:', Object.keys(zones).join(', '));
console.log('missing comarques/provinces:', missing.length ? missing.join(', ') : 'none');
console.log('output size:', kb, 'KB');
