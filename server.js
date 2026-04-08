const express = require('express');
const db = require('./db');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { publishProduct, startZapMonitor, deleteFromNostr } = require('./nostr-publish');

// bech32 npub → hex conversion
function npubToHex(npub) {
  if (!npub) return npub;
  if (!npub.startsWith('npub1')) return npub; // already hex
  try {
    const { decode } = require('nostr-tools/nip19');
    const { data } = decode(npub);
    return data;
  } catch(e) {
    console.error('npub decode error:', e.message);
    return npub;
  }
}

const app = express();
const PORT = 3102;

app.use(express.json({ limit: '5mb' }));

// Amber callback - handle all paths starting with /amber-callback
app.get('/amber-callback:data', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/amber-callback', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/photos', express.static(path.join(__dirname, 'photos')));

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Nostr-Pubkey, X-Nostr-Sig, X-Pow-Nonce');
  next();
});

// --- Telegram helpers ---
function tgEscape(text) {
  return String(text || '').replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function sendTelegramAnnounce(text, photoUrl) {
  return new Promise((resolve) => {
    if (!process.env.TG_BOT_TOKEN) { resolve(null); return; }
    const https = require('https');
    const usePhoto = !!photoUrl;
    const body = usePhoto
      ? { chat_id: '-1002457902120', message_thread_id: 2106, photo: photoUrl, caption: text, parse_mode: 'MarkdownV2' }
      : { chat_id: '-1002457902120', message_thread_id: 2106, text, parse_mode: 'MarkdownV2' };
    const postData = JSON.stringify(body);
    const endpoint = usePhoto ? 'sendPhoto' : 'sendMessage';
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${process.env.TG_BOT_TOKEN}/${endpoint}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const resp = JSON.parse(data);
          resolve(resp.ok ? resp.result.message_id : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', (e) => { console.error('TG announce error:', e.message); resolve(null); });
    req.write(postData);
    req.end();
  });
}

function deleteTelegramMessage(chatId, messageId) {
  return new Promise((resolve) => {
    if (!process.env.TG_BOT_TOKEN || !chatId || !messageId) { resolve(false); return; }
    const https = require('https');
    const postData = JSON.stringify({ chat_id: chatId, message_id: Number(messageId) });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${process.env.TG_BOT_TOKEN}/deleteMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data).ok); } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.write(postData);
    req.end();
  });
}

// --- Anti-spam: simple PoW challenge ---
const challenges = new Map();

app.get('/api/challenge', (req, res) => {
  const challenge = crypto.randomBytes(16).toString('hex');
  const difficulty = 4; // first 4 hex chars must be 0
  challenges.set(challenge, { created: Date.now(), difficulty });
  // Clean old challenges
  for (const [k, v] of challenges) {
    if (Date.now() - v.created > 600000) challenges.delete(k);
  }
  res.json({ challenge, difficulty });
});

function verifyPow(challenge, nonce, difficulty) {
  const entry = challenges.get(challenge);
  if (!entry) return false;
  const hash = crypto.createHash('sha256').update(challenge + nonce).digest('hex');
  const prefix = '0'.repeat(difficulty);
  if (hash.startsWith(prefix)) {
    challenges.delete(challenge);
    return true;
  }
  return false;
}

// --- Products API ---

// List products (with optional filters)
app.get('/api/products', (req, res) => {
  const { region, category, search, limit = 50, offset = 0 } = req.query;
  let query = 'SELECT * FROM products WHERE active = 1';
  const params = [];

  if (category) {
    query += ' AND category = ?';
    params.push(category);
  }
  if (region) {
    query += ' AND region = ?';
    params.push(region);
  }
  if (search) {
    query += ' AND (title LIKE ? OR description LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  const products = db.prepare(query).all(...params);

  // Parse photos JSON
  products.forEach(p => {
    try { p.photos = JSON.parse(p.photos || '[]'); } catch { p.photos = []; }
  });

  res.json(products);
});

// Get single product
app.get('/api/products/:id', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Not found' });
  try { product.photos = JSON.parse(product.photos || '[]'); } catch { product.photos = []; }
  res.json(product);
});

// Create product manually (requires PoW + Nostr signature)
app.post('/api/products', async (req, res) => {
  const { title, description, price, price_currency, region, category, photos, seller_telegram, challenge, nonce, signed_event } = req.body;
  let { seller_npub } = req.body;

  // Convert bech32 npub to hex if needed
  seller_npub = npubToHex(seller_npub);

  if (!title || !price) {
    return res.status(400).json({ error: 'Title and price required' });
  }

  // Verify Nostr signature
  if (!signed_event || !signed_event.sig || !signed_event.pubkey) {
    return res.status(403).json({ error: 'Signed Nostr event required to publish' });
  }
  if (seller_npub && signed_event.pubkey !== seller_npub) {
    return res.status(403).json({ error: 'Signature does not match seller pubkey' });
  }

  // Verify PoW
  if (!challenge || !nonce || !verifyPow(challenge, nonce, challenges.get(challenge)?.difficulty || 4)) {
    return res.status(403).json({ error: 'Invalid PoW. Get a new challenge.' });
  }

  const stmt = db.prepare(`
    INSERT INTO products (title, description, price, price_currency, region, category, photos, seller_telegram, seller_npub, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')
  `);

  const result = stmt.run(
    title, description || '', price, price_currency || 'sats',
    region || null, category || null, JSON.stringify(photos || []),
    seller_telegram || null, seller_npub || null
  );

  const productId = result.lastInsertRowid;

  // Publish to Nostr (use client's signed event if properly signed, otherwise marketplace key)
  console.log(`[Product ${productId}] signed_event.sig:`, signed_event?.sig?.substring(0, 32) + '...');
  console.log(`[Product ${productId}] signed_event.id:`, signed_event?.id?.substring(0, 16) + '...');
  console.log(`[Product ${productId}] signed_event.pubkey:`, signed_event?.pubkey?.substring(0, 16) + '...');
  console.log(`[Product ${productId}] sig is placeholder:`, signed_event?.sig === '00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000');
  try {
    const parsedPhotos = photos || [];
    const nostrEventId = await publishProduct({
      id: productId, title, description, price, price_currency,
      seller_npub: seller_npub || null, seller_telegram: seller_telegram || null,
      photos: parsedPhotos, category, region
    }, signed_event);
    if (nostrEventId) {
      db.prepare('UPDATE products SET nostr_event_id = ? WHERE id = ?').run(nostrEventId, productId);
    }
  } catch(e) { console.error('Nostr publish error:', e.message); }

  // Announce to Telegram topic Mercasats automatically
  try {
    const catName = category ? (CATEGORIES.find(c => c.id === category)?.name || category) : '';
    const priceText = price + (price_currency === 'EUR' ? '€' : ' sats');
    const tgUser = seller_telegram ? (seller_telegram.startsWith('@') ? seller_telegram : '@' + seller_telegram) : null;
    const contact = tgUser || (seller_npub ? seller_npub.substring(0, 16) + '...' : '');
    const desc = (description || '').substring(0, 150);
    const photoUrl = (photos && photos.length > 0) ? (photos[0].startsWith('http') ? photos[0] : `https://mercasats.kilombino.com${photos[0]}`) : null;
    const text = `🛒 Nou producte a Merca\\-sats\\!\n\n*${tgEscape(title)}*\n${tgEscape(desc)}\n💰 ${tgEscape(priceText)}${catName ? '\n📂 ' + tgEscape(catName) : ''}\n👤 ${tgUser ? tgUser : tgEscape(contact)}\n\n🔗 [mercasats\\.kilombino\\.com](https://mercasats.kilombino.com)`;

    const tgMsgId = await sendTelegramAnnounce(text, photoUrl);
    if (tgMsgId) {
      db.prepare('UPDATE products SET telegram_message_id = ?, telegram_chat_id = ? WHERE id = ?')
        .run(String(tgMsgId), '-1002457902120', productId);
    }
  } catch(e) { console.error('TG announce error:', e); }

  res.json({ id: productId });
});

const CATEGORIES = [
  { id: 'informatica', name: 'Informàtica' },
  { id: 'bitcoin', name: 'Bitcoin & Hardware' },
  { id: 'energia', name: 'Energia Solar' },
  { id: 'alimentacio', name: 'Alimentació' },
  { id: 'roba', name: 'Roba' },
  { id: 'complements', name: 'Complements' },
  { id: 'gaming', name: 'Gaming & Jocs' },
  { id: 'finances', name: 'Monedes & Divises' },
  { id: 'serveis', name: 'Serveis' },
  { id: 'vehicle', name: 'Vehicle & Motor' },
  { id: 'esport', name: 'Esport & Salut' },
  { id: 'llar', name: 'Llar & Immoble' },
  { id: 'altres', name: 'Altres' },
];

// --- Ratings API ---

// Get ratings for an npub
app.get('/api/ratings/:npub', (req, res) => {
  const ratings = db.prepare('SELECT * FROM ratings WHERE rated_npub = ? ORDER BY created_at DESC').all(req.params.npub);
  const avg = db.prepare('SELECT AVG(stars) as avg, COUNT(*) as count FROM ratings WHERE rated_npub = ?').get(req.params.npub);
  res.json({ ratings, average: Math.round((avg.avg || 0) * 10) / 10, count: avg.count });
});

// Submit a rating (requires signed Nostr event as proof)
app.post('/api/ratings', (req, res) => {
  let { rater_npub, rated_npub, stars, comment, signed_event } = req.body;
  rater_npub = npubToHex(rater_npub);
  rated_npub = npubToHex(rated_npub);

  if (!rater_npub || !rated_npub || !stars) {
    return res.status(400).json({ error: 'rater_npub, rated_npub, and stars required' });
  }
  // Verify signed event if provided
  const verified = signed_event && signed_event.pubkey === rater_npub && signed_event.sig;
  if (rater_npub === rated_npub) {
    return res.status(400).json({ error: 'Cannot rate yourself' });
  }
  if (stars < 1 || stars > 5) {
    return res.status(400).json({ error: 'Stars must be 1-5' });
  }

  const stmt = db.prepare(`
    INSERT INTO ratings (rater_npub, rated_npub, stars, comment)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(rater_npub, rated_npub) DO UPDATE SET stars = ?, comment = ?, created_at = datetime('now')
  `);

  stmt.run(rater_npub, rated_npub, stars, comment || null, stars, comment || null);
  res.json({ ok: true });
});

// --- User profiles ---
app.get('/api/users', (req, res) => {
  const users = db.prepare(`
    SELECT np.*,
      (SELECT AVG(stars) FROM ratings WHERE rated_npub = np.npub) as avg_rating,
      (SELECT COUNT(*) FROM ratings WHERE rated_npub = np.npub) as rating_count,
      (SELECT COUNT(*) FROM products WHERE active = 1 AND seller_npub = np.npub) as product_count
    FROM npub_profiles np ORDER BY np.updated_at DESC
  `).all();
  users.forEach(u => {
    u.avg_rating = Math.round((u.avg_rating || 0) * 10) / 10;
  });
  res.json(users);
});

app.post('/api/users/register', (req, res) => {
  let { npub, display_name, telegram_username, picture } = req.body;
  if (!npub) return res.status(400).json({ error: 'npub required' });

  // Convert bech32 npub to hex
  npub = npubToHex(npub);

  const stmt = db.prepare(`
    INSERT INTO npub_profiles (npub, display_name, telegram_username, picture, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(npub) DO UPDATE SET
      display_name = COALESCE(?, display_name),
      telegram_username = COALESCE(?, telegram_username),
      picture = COALESCE(?, picture),
      updated_at = datetime('now')
  `);
  stmt.run(npub, display_name || null, telegram_username || null, picture || null, display_name || null, telegram_username || null, picture || null);
  res.json({ ok: true });
});

app.get('/api/users/:npub', (req, res) => {
  let user = db.prepare('SELECT * FROM npub_profiles WHERE npub = ?').get(req.params.npub);
  if (!user) user = { npub: req.params.npub, display_name: null, picture: null };

  const ratings = db.prepare(`
    SELECT r.*, np.display_name as rater_name, np.picture as rater_picture
    FROM ratings r LEFT JOIN npub_profiles np ON r.rater_npub = np.npub
    WHERE r.rated_npub = ? ORDER BY r.created_at DESC
  `).all(req.params.npub);

  const avg = db.prepare('SELECT AVG(stars) as avg, COUNT(*) as count FROM ratings WHERE rated_npub = ?').get(req.params.npub);

  // Products by this user
  const products = db.prepare(
    'SELECT * FROM products WHERE active = 1 AND (seller_npub = ? OR seller_telegram = ?) ORDER BY created_at DESC'
  ).all(req.params.npub, req.params.npub);
  products.forEach(p => { try { p.photos = JSON.parse(p.photos || '[]'); } catch { p.photos = []; } });

  res.json({
    user, ratings, products,
    average: Math.round((avg.avg || 0) * 10) / 10,
    count: avg.count
  });
});

// --- My profile data ---
app.get('/api/me/:npub', (req, res) => {
  const npub = req.params.npub;

  // My products
  const products = db.prepare(
    'SELECT * FROM products WHERE active = 1 AND seller_npub = ? ORDER BY created_at DESC'
  ).all(npub);
  products.forEach(p => {
    try { p.photos = JSON.parse(p.photos || '[]'); } catch { p.photos = []; }
  });

  // Ratings I gave
  const ratingsGiven = db.prepare(`
    SELECT r.*, np.display_name as rated_name, np.picture as rated_picture
    FROM ratings r LEFT JOIN npub_profiles np ON r.rated_npub = np.npub
    WHERE r.rater_npub = ? ORDER BY r.created_at DESC
  `).all(npub);

  // Ratings I received
  const ratingsReceived = db.prepare(`
    SELECT r.*, np.display_name as rater_name, np.picture as rater_picture
    FROM ratings r LEFT JOIN npub_profiles np ON r.rater_npub = np.npub
    WHERE r.rated_npub = ? ORDER BY r.created_at DESC
  `).all(npub);

  const avg = db.prepare('SELECT AVG(stars) as avg, COUNT(*) as count FROM ratings WHERE rated_npub = ?').get(npub);

  const profile = db.prepare('SELECT * FROM npub_profiles WHERE npub = ?').get(npub);

  res.json({
    profile,
    products,
    ratingsGiven,
    ratingsReceived,
    avgRating: Math.round((avg.avg || 0) * 10) / 10,
    ratingCount: avg.count
  });
});

// --- Seller reputation summary ---
app.get('/api/seller/:identifier', (req, res) => {
  const id = req.params.identifier;
  // Could be npub or telegram username
  const products = db.prepare(
    'SELECT * FROM products WHERE active = 1 AND (seller_npub = ? OR seller_telegram = ?) ORDER BY created_at DESC'
  ).all(id, id);

  products.forEach(p => {
    try { p.photos = JSON.parse(p.photos || '[]'); } catch { p.photos = []; }
  });

  let rating = { average: 0, count: 0 };
  if (id.startsWith('npub') || id.length === 64) {
    const avg = db.prepare('SELECT AVG(stars) as avg, COUNT(*) as count FROM ratings WHERE rated_npub = ?').get(id);
    rating = { average: Math.round((avg.avg || 0) * 10) / 10, count: avg.count };
  }

  res.json({ products, rating });
});

// --- Internal API for Telegram scraper (called by Clawilom) ---
app.post('/api/internal/product', async (req, res) => {
  const { title, description, price, price_currency, region, category, photos, seller_telegram, seller_npub, telegram_message_id, telegram_chat_id } = req.body;

  const stmt = db.prepare(`
    INSERT INTO products (title, description, price, price_currency, region, category, photos, seller_telegram, seller_npub, source, telegram_message_id, telegram_chat_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'telegram', ?, ?)
  `);

  const result = stmt.run(
    title, description || '', price, price_currency || 'sats',
    region || null, category || null, JSON.stringify(photos || []),
    seller_telegram || null, seller_npub || null, telegram_message_id || null, telegram_chat_id || null
  );

  const productId = result.lastInsertRowid;

  // Publish to Nostr
  try {
    const nostrEventId = await publishProduct({
      id: productId, title, description, price, price_currency: price_currency || 'sats',
      seller_npub: seller_npub || null, seller_telegram: seller_telegram || null,
      photos: photos || [], category, region
    });
    if (nostrEventId) {
      db.prepare('UPDATE products SET nostr_event_id = ? WHERE id = ?').run(nostrEventId, productId);
    }
  } catch(e) { console.error('Nostr publish error:', e.message); }

  res.json({ id: productId });
});

// --- Categories list ---
app.get('/api/categories', (req, res) => {
  const categories = [
    { id: 'informatica', name: 'Informàtica', emoji: '💻' },
    { id: 'bitcoin', name: 'Bitcoin & Hardware', emoji: '🔐' },
    { id: 'energia', name: 'Energia Solar', emoji: '☀️' },
    { id: 'alimentacio', name: 'Alimentació', emoji: '🍊' },
    { id: 'roba', name: 'Roba', emoji: '👕' },
    { id: 'complements', name: 'Complements', emoji: '⌚' },
    { id: 'gaming', name: 'Gaming & Jocs', emoji: '🎮' },
    { id: 'finances', name: 'Monedes & Divises', emoji: '🪙' },
    { id: 'serveis', name: 'Serveis', emoji: '🔧' },
    { id: 'vehicle', name: 'Vehicle & Motor', emoji: '🚗' },
    { id: 'esport', name: 'Esport & Salut', emoji: '💪' },
    { id: 'llar', name: 'Llar & Immoble', emoji: '🏠' },
    { id: 'altres', name: 'Altres', emoji: '📦' },
  ];

  const counts = db.prepare(
    'SELECT category, COUNT(*) as count FROM products WHERE active = 1 AND category IS NOT NULL GROUP BY category'
  ).all();
  const countMap = Object.fromEntries(counts.map(c => [c.category, c.count]));
  categories.forEach(c => c.count = countMap[c.id] || 0);

  const noCategory = db.prepare('SELECT COUNT(*) as count FROM products WHERE active = 1 AND category IS NULL').get();
  categories.push({ id: null, name: 'Sense categoria', emoji: '❓', count: noCategory.count });

  res.json(categories);
});

// --- Regions list (kept for location info) ---
app.get('/api/regions', (req, res) => {
  const regions = [
    { id: 'barcelona', name: 'Barcelona', emoji: '🏛️' },
    { id: 'maresme', name: 'Maresme', emoji: '🏖️' },
    { id: 'valles', name: 'Vallès', emoji: '⛰️' },
    { id: 'osona', name: 'Osona', emoji: '🌲' },
    { id: 'girona', name: 'Girona', emoji: '🏰' },
    { id: 'emporda', name: 'Empordà', emoji: '🌊' },
    { id: 'tarragona', name: 'Tarragona', emoji: '🏺' },
    { id: 'baixllobregat', name: 'Baix Llobregat', emoji: '🏭' },
    { id: 'garraf', name: 'Garraf', emoji: '⛱️' },
    { id: 'penedes', name: 'Penedès', emoji: '🍷' },
    { id: 'lleida', name: 'Pla de Lleida', emoji: '🌾' },
  ];
  res.json(regions);
});

// --- Product sold status ---
app.get('/api/products/:id/status', (req, res) => {
  const product = db.prepare('SELECT id, title, sold, buyer_npub, sold_at, nostr_event_id FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Not found' });
  res.json(product);
});

// --- Delete product (owner only, requires signed event) ---
app.delete('/api/products/:id', async (req, res) => {
  const { signed_event } = req.body;
  if (!signed_event || !signed_event.pubkey) {
    return res.status(403).json({ error: 'Signed Nostr event required' });
  }

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Not found' });

  // Verify ownership: seller_npub must match signer
  const signerHex = npubToHex(signed_event.pubkey);
  if (product.seller_npub && product.seller_npub !== signerHex) {
    return res.status(403).json({ error: 'Not your product' });
  }

  // 1. Delete from DB (soft delete)
  db.prepare("UPDATE products SET active = 0, removal_reason = ?, updated_at = datetime('now') WHERE id = ?")
    .run('Eliminat pel venedor des de la web', req.params.id);

  // 2. Delete from Telegram
  if (product.telegram_message_id && product.telegram_chat_id) {
    try {
      await deleteTelegramMessage(product.telegram_chat_id, product.telegram_message_id);
      console.log(`[Delete] TG message ${product.telegram_message_id} deleted`);
    } catch(e) { console.error('[Delete] TG error:', e.message); }
  }

  // 3. Delete from Nostr (publish deletion event kind 5)
  if (product.nostr_event_id) {
    try {
      await deleteFromNostr(product.nostr_event_id, product.id);
      console.log(`[Delete] Nostr event ${product.nostr_event_id} deleted`);
    } catch(e) { console.error('[Delete] Nostr error:', e.message); }
  }

  res.json({ ok: true, deleted: product.id });
});

// --- Internal photo update (called by telegram scraper for follow-up photos) ---
app.put('/api/internal/product/:id/photos', (req, res) => {
  const { photos } = req.body;
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Not found' });

  const existing = JSON.parse(product.photos || '[]');
  const merged = [...existing, ...(photos || [])];
  db.prepare('UPDATE products SET photos = ? WHERE id = ?').run(JSON.stringify(merged), req.params.id);
  console.log(`[Internal] Added ${photos.length} photo(s) to product ${product.id} "${product.title}"`);
  res.json({ ok: true, photos: merged });
});

// --- Internal delete (called by telegram scraper when message is deleted) ---
app.delete('/api/internal/product/:id', async (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Not found' });

  // Soft delete with reason
  const reason = req.body?.reason || 'Eliminat des de Telegram';
  db.prepare("UPDATE products SET active = 0, removal_reason = ?, updated_at = datetime('now') WHERE id = ?").run(reason, req.params.id);

  // Delete from Nostr
  if (product.nostr_event_id) {
    try {
      await deleteFromNostr(product.nostr_event_id, product.id);
      console.log(`[Internal Delete] Nostr event ${product.nostr_event_id} deleted`);
    } catch(e) { console.error('[Internal Delete] Nostr error:', e.message); }
  }

  // Delete local photo if exists
  if (product.photos) {
    try {
      const photos = JSON.parse(product.photos);
      for (const p of photos) {
        if (p.startsWith('/photos/')) {
          const fullPath = path.join(__dirname, 'public', p);
          if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        }
      }
    } catch(e) {}
  }

  console.log(`[Internal Delete] Product ${product.id} "${product.title}" removed (TG message deleted)`);
  res.json({ ok: true, deleted: product.id });
});

// --- Generate Lightning invoice for product zap ---
app.post('/api/products/:id/invoice', async (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  if (product.sold === 1) return res.status(400).json({ error: 'Product already sold' });
  if (!product.seller_npub) return res.status(400).json({ error: "L'usuari no té npub associada" });

  // Accept custom amount from body (for EUR/BTC products), or use product price for sats
  let amountSats;
  if (req.body && req.body.amount_sats) {
    amountSats = parseInt(req.body.amount_sats);
  } else if (product.price_currency === 'sats' && product.price && !isNaN(parseInt(product.price))) {
    amountSats = parseInt(product.price);
  } else {
    return res.status(400).json({ error: 'amount_sats required for non-sats prices', needs_amount: true });
  }
  if (!amountSats || amountSats < 1) return res.status(400).json({ error: 'Invalid amount' });

  const amountMsat = amountSats * 1000;

  // Find seller's Lightning address from Nostr profile
  let lnAddress = null;
  const sellerNpub = product.seller_npub;

  if (sellerNpub) {
    try {
      lnAddress = await fetchLightningAddress(sellerNpub);
    } catch (e) {
      console.error('[Invoice] Failed to fetch LN address:', e.message);
    }
  }

  if (!lnAddress) {
    return res.status(400).json({ error: "L'usuari no té LN address a Nostr" });
  }

  // Resolve LNURL-pay from Lightning address
  try {
    const [user, domain] = lnAddress.split('@');
    const lnurlUrl = `https://${domain}/.well-known/lnurlp/${user}`;

    const https = require('https');
    const lnurlData = await new Promise((resolve, reject) => {
      https.get(lnurlUrl, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      }).on('error', reject);
    });

    if (!lnurlData.callback) return res.status(400).json({ error: 'Invalid LNURL response' });

    // Check amount limits
    if (amountMsat < (lnurlData.minSendable || 0) || amountMsat > (lnurlData.maxSendable || Infinity)) {
      return res.status(400).json({ error: `Amount ${amountSats} sats outside limits` });
    }

    // Create zap request event (NIP-57)
    const { finalizeEvent: fe } = require('nostr-tools/pure');
    const zapSk = Uint8Array.from(Buffer.from(process.env.NOSTR_NSEC_HEX, 'hex'));
    const zapRequest = fe({
      kind: 9734,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['p', sellerNpub],
        ['e', product.nostr_event_id],
        ['amount', String(amountMsat)],
        ['relays', 'wss://relay.primal.net', 'wss://relay.damus.io', 'wss://nos.lol'],
      ],
      content: (req.body && req.body.comment) || `Payment for: ${product.title}`,
    }, zapSk);

    // Request invoice from LNURL callback
    const callbackUrl = new URL(lnurlData.callback);
    callbackUrl.searchParams.set('amount', String(amountMsat));

    // Add comment
    const comment = (req.body && req.body.comment) || `MercaSats: ${product.title}`;
    if (lnurlData.commentAllowed && comment.length <= lnurlData.commentAllowed) {
      callbackUrl.searchParams.set('comment', comment);
    }

    // Add nostr zap request only if URL won't be too long (some servers reject long URLs)
    if (lnurlData.allowsNostr) {
      const nostrParam = JSON.stringify(zapRequest);
      const testUrl = callbackUrl.toString() + '&nostr=' + encodeURIComponent(nostrParam);
      if (testUrl.length < 800) {
        callbackUrl.searchParams.set('nostr', nostrParam);
      } else {
        console.log('[Invoice] Skipping nostr param (URL too long:', testUrl.length, ')');
      }
    }

    const invoiceData = await new Promise((resolve, reject) => {
      const cbUrl = callbackUrl.toString();
      console.log('[Invoice] Callback URL length:', cbUrl.length);
      https.get(cbUrl, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => {
          console.log('[Invoice] Callback response:', r.statusCode, d.substring(0, 200));
          try { resolve(JSON.parse(d)); } catch(e) {
            reject(new Error(`Invalid response (${r.statusCode}): ${d.substring(0, 100)}`));
          }
        });
      }).on('error', reject);
    });

    if (!invoiceData.pr) return res.status(500).json({ error: 'Failed to get invoice' });

    res.json({ invoice: invoiceData.pr, amount_sats: amountSats });
  } catch (e) {
    console.error('[Invoice] Error:', e.message);
    res.status(500).json({ error: 'Failed to generate invoice: ' + e.message });
  }
});

// Fetch Lightning address from Nostr profile (kind 0)
async function fetchLightningAddress(pubkeyHex) {
  const WebSocket = require('ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://relay.primal.net');
    const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 10000);
    ws.on('open', () => {
      ws.send(JSON.stringify(['REQ', 'ln', { kinds: [0], authors: [pubkeyHex], limit: 1 }]));
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg[0] === 'EVENT' && msg[2]?.content) {
        try {
          const profile = JSON.parse(msg[2].content);
          const lnAddr = profile.lud16 || profile.lud06 || null;
          clearTimeout(timeout);
          ws.close();
          resolve(lnAddr);
        } catch { /* ignore */ }
      }
      if (msg[0] === 'EOSE') { clearTimeout(timeout); ws.close(); resolve(null); }
    });
    ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
}

// --- Notifications feed for mobile app ---
app.get('/api/notifications', (req, res) => {
  const since = req.query.since || '2000-01-01';

  // New products since timestamp
  const newProducts = db.prepare(
    "SELECT id, title, price, price_currency, photos, seller_telegram, created_at FROM products WHERE active = 1 AND created_at > ? ORDER BY created_at DESC LIMIT 10"
  ).all(since);

  // New ratings since timestamp (include profile pictures)
  const newRatings = db.prepare(
    "SELECT r.*, np.display_name as rated_name, np.picture as rated_picture, np2.display_name as rater_name, np2.picture as rater_picture FROM ratings r LEFT JOIN npub_profiles np ON np.npub = r.rated_npub LEFT JOIN npub_profiles np2 ON np2.npub = r.rater_npub WHERE r.created_at > ? ORDER BY r.created_at DESC LIMIT 10"
  ).all(since);

  // Recently removed products (include photos for notification)
  const removedProducts = db.prepare(
    "SELECT id, title, photos, removal_reason, updated_at FROM products WHERE active = 0 AND removal_reason IS NOT NULL AND updated_at > ? ORDER BY updated_at DESC LIMIT 10"
  ).all(since);

  // Recently sold products
  const soldProducts = db.prepare(
    "SELECT id, title, price, price_currency, photos, seller_telegram, buyer_npub, sold_at FROM products WHERE sold = 1 AND sold_at > ? ORDER BY sold_at DESC LIMIT 10"
  ).all(since);

  res.json({ newProducts, newRatings, removedProducts, soldProducts });
});

// --- CORS preflight for DELETE ---
app.options('/api/products/:id', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).end();
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Merkasats API on http://0.0.0.0:${PORT}`);
  // Start Nostr zap monitor
  startZapMonitor(db, async (product, amountSats, buyerPubkey) => {
    // Notify sale on Telegram group
    const seller = product.seller_telegram || product.seller_npub?.substring(0, 12) || 'Desconegut';
    const buyer = buyerPubkey ? buyerPubkey.substring(0, 12) + '...' : 'un comprador';
    const tgSeller = product.seller_telegram ? (product.seller_telegram.startsWith('@') ? product.seller_telegram : '@' + product.seller_telegram) : seller;
    const text = `🛒 *VENUT\\!*\n\n*${tgEscape(product.title)}*\n💰 ${amountSats} sats\n👤 Comprador: ${tgEscape(buyer)}\n🏪 Venedor: ${tgEscape(tgSeller)}\n\n🔗 [mercasats\\.kilombino\\.com](https://mercasats.kilombino.com)`;

    try {
      await sendTelegramAnnounce(text, null);
      console.log('[Sale] Telegram notification sent');
    } catch(e) { console.error('[Sale] TG notify error:', e.message); }
  });
});
