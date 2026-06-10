const express = require('express');
const db = require('./db');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { publishProduct, startZapMonitor, deleteFromNostr } = require('./nostr-publish');
const { pickPhotoForProduct } = require('./generic-photos');

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

// hex → bech32 npub conversion (for display)
function hexToNpub(hex) {
  if (!hex) return hex;
  if (hex.startsWith('npub1')) return hex; // already bech32
  try {
    const { npubEncode } = require('nostr-tools/nip19');
    return npubEncode(hex);
  } catch(e) {
    return hex; // fallback to hex if conversion fails
  }
}

// Sellers with a fixed region — their ads always land in this region regardless
// of what the scraper detects or the publish form sends.
const FORCED_SELLER_REGIONS = {
  kilombino: 'baixllobregat',
  eznomada: 'galicia',
  bebop2077: 'penedes',
  androdebian: 'valles',
  aledaje: 'maresme',
  morwapo: 'baixllobregat',
};

function forcedRegionForSeller(sellerTelegram) {
  if (!sellerTelegram) return null;
  const key = sellerTelegram.replace(/^@/, '').toLowerCase();
  return FORCED_SELLER_REGIONS[key] || null;
}

const app = express();
const PORT = 3102;

// Advertise the .onion mirror to Tor Browser via Onion-Location.
// Tor Browser only honors the header on HTTPS, so the clearnet (HTTPS via
// Caddy) lights up the ".onion available" prompt while requests that
// already arrive on the .onion are skipped.
const ONION_HOST = 'mercasat3yhtc5gadhlnrwrgcebnh6fk6qe7zntdagxsmhlymdryiiid.onion';
app.use((req, res, next) => {
  if (req.headers.host !== ONION_HOST) {
    res.setHeader('Onion-Location', `http://${ONION_HOST}${req.originalUrl}`);
  }
  next();
});

app.use(express.json({ limit: '5mb' }));

// Amber callback - handle all paths starting with /amber-callback
app.get('/amber-callback:data', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/amber-callback', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'allow' }));
app.use('/photos', express.static(path.join(__dirname, 'photos')));

// Zones map gets its own URL.
app.get('/zones', (req, res) => res.sendFile(path.join(__dirname, 'public', 'zones.html')));
// Meetups map gets its own URL.
app.get('/meetups', (req, res) => res.sendFile(path.join(__dirname, 'public', 'meetups.html')));
// "What is Merca-sats" landing page (real HTML content for SEO).
app.get('/que-es', (req, res) => res.sendFile(path.join(__dirname, 'public', 'que-es.html')));
// security.txt (RFC 9116) — express.static ignores dotfiles, so serve it explicitly.
app.get('/.well-known/security.txt', (req, res) => res.type('text/plain').sendFile(path.join(__dirname, 'public', '.well-known', 'security.txt')));

// --- Photo upload ---
const multer = require('multer');
const photoStorage = multer.diskStorage({
  destination: path.join(__dirname, 'photos'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});
const upload = multer({
  storage: photoStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB (Telegram sendPhoto URL limit)
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Solo se permiten imágenes'));
  }
});

const { generateThumbAsync } = require('./thumb');

app.post('/api/upload-photo', upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const localPath = `/photos/${req.file.filename}`;
  generateThumbAsync(localPath);
  // Return an ABSOLUTE URL: the app/web put this exact string into the signed
  // Nostr event, and a relative path doesn't load in Nostr clients.
  res.json({ url: `https://mercasats.kilombino.com${localPath}` });
});

// CORS + Security Headers
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Nostr-Pubkey, X-Nostr-Sig, X-Pow-Nonce');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.removeHeader('X-Powered-By');
  next();
});

// --- Telegram helpers ---
function tgEscape(text) {
  return String(text || '').replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

const TG_CHAT_ID = '-1002457902120';
const TG_THREAD_ID = 2106;
const TG_CAPTION_LIMIT = 1024;

// Post an ad to the channel. If `text` (caption+photo) fits in 1024 chars,
// sends a single photo message. If it overflows, sends a short summary caption
// on the photo and a follow-up text reply with the full body. Returns
// { messageId, longMessageId } — longMessageId is null when a single message
// was enough. `opts.replyToMessageId` quote-replies to an existing message
// (used by the reservation flow to thread under the original product post).
async function sendTelegramAnnounce(text, photoUrlOrList, summary, opts = {}) {
  if (!process.env.TG_BOT_TOKEN) return { messageId: null, longMessageId: null };

  // Accept either a single URL (legacy callers) or an array of URLs (new
  // multi-photo flow). Telegram media groups accept 2..10 photos; beyond that
  // we truncate.
  const photoList = Array.isArray(photoUrlOrList)
    ? photoUrlOrList.filter(Boolean).slice(0, 10)
    : (photoUrlOrList ? [photoUrlOrList] : []);
  const usePhoto = photoList.length > 0;
  const useAlbum = photoList.length > 1;
  const fitsInOne = text.length <= TG_CAPTION_LIMIT;
  const replyParams = opts.replyToMessageId
    ? { reply_parameters: { message_id: Number(opts.replyToMessageId), allow_sending_without_reply: true } }
    : {};

  if (!usePhoto) {
    const r = await tgApi('sendMessage', {
      chat_id: TG_CHAT_ID, message_thread_id: TG_THREAD_ID, text, parse_mode: 'MarkdownV2', ...replyParams,
    });
    return { messageId: r.ok ? r.result.message_id : null, longMessageId: null };
  }

  if (useAlbum) {
    // Album: caption goes on the first item. If overflow, first item gets the
    // short summary and a follow-up text reply carries the full body.
    const caption = fitsInOne ? text : (summary || text.slice(0, TG_CAPTION_LIMIT));
    const media = photoList.map((url, i) => ({
      type: 'photo',
      media: url,
      ...(i === 0 ? { caption, parse_mode: 'MarkdownV2' } : {}),
    }));
    const albumResp = await tgApi('sendMediaGroup', {
      chat_id: TG_CHAT_ID, message_thread_id: TG_THREAD_ID, media, ...replyParams,
    });
    if (!albumResp.ok || !albumResp.result?.length) return { messageId: null, longMessageId: null };
    const firstId = albumResp.result[0].message_id;
    if (fitsInOne) return { messageId: firstId, longMessageId: null };
    const textResp = await tgApi('sendMessage', {
      chat_id: TG_CHAT_ID, message_thread_id: TG_THREAD_ID, text, parse_mode: 'MarkdownV2',
      reply_parameters: { message_id: firstId },
      link_preview_options: { is_disabled: true },
    });
    return { messageId: firstId, longMessageId: textResp.ok ? textResp.result.message_id : null };
  }

  const photoUrl = photoList[0];

  if (fitsInOne) {
    const r = await tgApi('sendPhoto', {
      chat_id: TG_CHAT_ID, message_thread_id: TG_THREAD_ID, photo: photoUrl, caption: text, parse_mode: 'MarkdownV2', ...replyParams,
    });
    return { messageId: r.ok ? r.result.message_id : null, longMessageId: null };
  }

  // Overflow: short photo caption + reply with full body
  const photoResp = await tgApi('sendPhoto', {
    chat_id: TG_CHAT_ID, message_thread_id: TG_THREAD_ID, photo: photoUrl,
    caption: (summary || text.slice(0, TG_CAPTION_LIMIT)), parse_mode: 'MarkdownV2', ...replyParams,
  });
  if (!photoResp.ok) return { messageId: null, longMessageId: null };
  const photoId = photoResp.result.message_id;
  const textResp = await tgApi('sendMessage', {
    chat_id: TG_CHAT_ID, message_thread_id: TG_THREAD_ID, text, parse_mode: 'MarkdownV2',
    reply_parameters: { message_id: photoId },
    link_preview_options: { is_disabled: true },
  });
  return { messageId: photoId, longMessageId: textResp.ok ? textResp.result.message_id : null };
}

// Call a Telegram bot-API method with automatic legacy-token fallback.
// Old channel messages were posted by @ClawilomBot (TG_BOT_TOKEN_LEGACY) and can
// only be edited/deleted by that bot. New posts use @MercasatsBot (TG_BOT_TOKEN).
// Returns the last API response so callers can inspect `.description` on failure
// (otherwise debugging "delete didn't happen" is guesswork).
function tgApi(method, body, { tokensToTry } = {}) {
  const tokens = tokensToTry || [process.env.TG_BOT_TOKEN, process.env.TG_BOT_TOKEN_LEGACY].filter(Boolean);
  return new Promise(async (resolve) => {
    const https = require('https');
    const postData = JSON.stringify(body);
    let lastResp = { ok: false, description: 'no tokens configured' };
    for (const token of tokens) {
      const resp = await new Promise((rs) => {
        const req = https.request({
          hostname: 'api.telegram.org',
          path: `/bot${token}/${method}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
        }, (res) => {
          let data = '';
          res.on('data', d => data += d);
          res.on('end', () => { try { rs(JSON.parse(data)); } catch { rs({ ok:false, description: 'invalid JSON' }); } });
        });
        req.on('error', (e) => rs({ ok:false, description: 'network: ' + e.message }));
        req.write(postData); req.end();
      });
      lastResp = resp;
      if (resp && resp.ok) return resolve(resp);
    }
    resolve(lastResp);
  });
}

async function deleteTelegramMessage(chatId, messageId) {
  if (!chatId || !messageId) return { ok: false, description: 'missing chatId/messageId' };
  const r = await tgApi('deleteMessage', { chat_id: chatId, message_id: Number(messageId) });
  return r;
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
  const { region, category, search, limit = 500, offset = 0 } = req.query;
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

  // Parse photos JSON + convert seller_npub to bech32 for display
  products.forEach(p => {
    try { p.photos = JSON.parse(p.photos || '[]'); } catch { p.photos = []; }
    if (p.seller_npub) p.seller_npub = hexToNpub(p.seller_npub);
  });

  res.json(products);
});

// Get single product
app.get('/api/products/:id', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Not found' });
  try { product.photos = JSON.parse(product.photos || '[]'); } catch { product.photos = []; }
  if (product.seller_npub) product.seller_npub = hexToNpub(product.seller_npub);
  res.json(product);
});

// Create product manually (requires PoW + Nostr signature)
app.post('/api/products', async (req, res) => {
  const { title, description, price, price_currency, region, category, photos, seller_telegram, challenge, nonce, signed_event, coords, shipping_option, shipping_price } = req.body;
  let { seller_npub } = req.body;

  // Shipping: validated option + free text price (≤20 chars), only when shipping is offered.
  const shipOpt = SHIPPING_OPTIONS.includes(shipping_option) ? shipping_option : 'no';
  const shipPrice = (shipOpt !== 'no' && typeof shipping_price === 'string') ? shipping_price.trim().slice(0, 20) : '';

  // Optional coordinates "lat,lng" picked on the zones map.
  let coordsClean = null;
  if (coords && typeof coords === 'string') {
    const m = coords.split(',').map(s => parseFloat(s.trim()));
    if (m.length === 2 && Number.isFinite(m[0]) && Number.isFinite(m[1]) && Math.abs(m[0]) <= 90 && Math.abs(m[1]) <= 180) {
      coordsClean = m[0].toFixed(5) + ',' + m[1].toFixed(5);
    }
  }

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

  // Extract d-tag from the client-signed event so we can reference this listing
  // later via naddr (kind+author+d-tag). NIP-99 requires kind 30402 to carry a
  // d-tag for replaceable semantics.
  const dTagFromSig = Array.isArray(signed_event?.tags)
    ? (signed_event.tags.find(t => t[0] === 'd')?.[1] || null)
    : null;

  const stmt = db.prepare(`
    INSERT INTO products (title, description, price, price_currency, region, category, photos, seller_telegram, seller_npub, source, nostr_d_tag, coords, shipping_option, shipping_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)
  `);

  const hashtagRegion = detectHashtagRegion(`${title || ''} ${description || ''}`);
  const finalRegion = hashtagRegion || forcedRegionForSeller(seller_telegram) || region || null;

  let finalPhotos = photos || [];
  if (finalPhotos.length === 0) {
    const generic = pickPhotoForProduct({ title, description, category });
    if (generic) finalPhotos = [generic];
  }

  const result = stmt.run(
    title, description || '', price, price_currency || 'sats',
    finalRegion, category || null, JSON.stringify(finalPhotos),
    seller_telegram || null, seller_npub || null,
    dTagFromSig, coordsClean, shipOpt, shipPrice
  );

  const productId = result.lastInsertRowid;

  // NIP-40 expiration: honour the signed_event's tag (or lack thereof)
  const expTag = Array.isArray(signed_event?.tags) ? signed_event.tags.find(t => t[0] === 'expiration') : null;
  const expTs = expTag ? parseInt(expTag[1], 10) : NaN;
  const noExpiration = !expTag; // no tag = permanent
  if (Number.isFinite(expTs) && expTs > Math.floor(Date.now() / 1000)) {
    db.prepare('UPDATE products SET expires_at = ? WHERE id = ?').run(expTs, productId);
  }

  // Publish to Nostr (use client's signed event if properly signed, otherwise marketplace key)
  console.log(`[Product ${productId}] signed_event.sig:`, signed_event?.sig?.substring(0, 32) + '...');
  console.log(`[Product ${productId}] signed_event.id:`, signed_event?.id?.substring(0, 16) + '...');
  console.log(`[Product ${productId}] signed_event.pubkey:`, signed_event?.pubkey?.substring(0, 16) + '...');
  console.log(`[Product ${productId}] sig is placeholder:`, signed_event?.sig === '00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000');
  try {
    const nostrEventId = await publishProduct({
      id: productId, title, description, price, price_currency,
      seller_npub: seller_npub || null, seller_telegram: seller_telegram || null,
      photos: finalPhotos, category, region, coords: coordsClean,
      shipping_option: shipOpt, shipping_price: shipPrice
    }, signed_event, { noExpiration });
    if (nostrEventId) {
      db.prepare('UPDATE products SET nostr_event_id = ? WHERE id = ?').run(nostrEventId, productId);
    }
  } catch(e) { console.error('Nostr publish error:', e.message); }

  // Announce to Telegram topic Mercasats automatically
  try {
    const catObj = category ? CATEGORIES.find(c => c.id === category) : null;
    const catName = catObj?.name || category || '';
    const catEmoji = catObj?.emoji || '';
    const priceText = (price && !isNaN(Number(price))) ? price + (price_currency === 'EUR' ? '€' : ' sats') : (price || 'A consultar');
    // Only treat seller_telegram as a clickable handle when it's a valid TG
    // username; otherwise fall back to free text (escaped) — scraped sellers
    // sometimes have things like "R.L. (buscar...)" that break MarkdownV2.
    const cleanHandle = seller_telegram && /^@?[A-Za-z0-9_]{3,}$/.test(seller_telegram)
      ? (seller_telegram.startsWith('@') ? seller_telegram : '@' + seller_telegram)
      : null;
    const tgUser = cleanHandle;
    const contact = cleanHandle || seller_telegram || (seller_npub ? seller_npub.substring(0, 16) + '...' : '');
    // sendTelegramAnnounce handles the caption/text-message split automatically:
    // if the full body fits in 1024 chars, single photo+caption; otherwise the
    // photo gets a short summary caption and the full body goes in a text reply.
    const hasPhoto = finalPhotos && finalPhotos.length > 0;
    const desc = (description || '').substring(0, 3500);
    const photoUrls = hasPhoto
      ? finalPhotos.map(p => p.startsWith('http') ? p : `https://mercasats.kilombino.com${p}`)
      : null;
    const regionObj = region ? REGIONS.find(r => r.id === region) : null;
    const regionName = regionObj?.name || region || '';
    const regionEmoji = regionObj?.emoji || '';
    const isCompra = /compro|compra|busco|\[compra\]/i.test(title);
    const tipoText = isCompra ? 'COMPRA' : 'VENDE';
    const productUrl = `https://mercasats.kilombino.com/?p=${productId}`;
    const productUrlLabel = `mercasats\\.kilombino\\.com/?p\\=${productId}`;
    // Show the seller's npub (bech32) in monospace so it can be copied easily.
    const sellerNpubBech = seller_npub ? hexToNpub(seller_npub) : null;
    const npubLine = sellerNpubBech ? `\n🔑 \`${sellerNpubBech}\`` : '';
    // Optional coordinates picked on the zones map: monospace value + OSM link.
    let coordsLine = '';
    if (coordsClean) {
      const [clat, clng] = coordsClean.split(',');
      coordsLine = `\n📍 \`${coordsClean}\` · [mapa](https://www.openstreetmap.org/?mlat=${clat}&mlon=${clng}#map=13/${clat}/${clng})`;
    }
    const shipLine = shipOpt !== 'no' ? `\n📦 *\\#ENVIOS* ${tgEscape(shippingText(shipOpt, shipPrice))}` : '';
    const text = `🛒 *\\#${tipoText}* *${tgEscape(title)}*\n📍 *\\#NODE* ${regionEmoji} ${tgEscape(regionName || 'Sense zona')}\n📂 *\\#CATEGORIA* ${catEmoji} ${tgEscape(catName || 'Sense categoria')}\n🪙 *\\#PRECIO* 💰${tgEscape(priceText)}${shipLine}\n📝 *\\#DESCRIPCION*\n${tgEscape(desc)}\n👤 ${tgEscape(tgUser || contact)}${npubLine}${coordsLine}\n\n🔗 [${productUrlLabel}](${productUrl})`;
    const summary = `🛒 *\\#${tipoText}* \\| 💰${tgEscape(priceText)} \\| ${regionEmoji}${tgEscape(regionName || 'Sense zona')}\n📝 *${tgEscape(title)}*\n\n👇 Descripció completa abaix\n🔗 [${productUrlLabel}](${productUrl})`;

    let res1 = await sendTelegramAnnounce(text, photoUrls, summary);
    if (!res1.messageId) {
      console.log('[TG] First announce attempt failed, retrying in 3s...');
      await new Promise(r => setTimeout(r, 3000));
      res1 = await sendTelegramAnnounce(text, photoUrls, summary);
    }
    if (res1.messageId) {
      db.prepare('UPDATE products SET telegram_message_id = ?, telegram_long_message_id = ?, telegram_chat_id = ? WHERE id = ?')
        .run(String(res1.messageId), res1.longMessageId ? String(res1.longMessageId) : null, TG_CHAT_ID, productId);
    } else {
      console.error(`[TG] WARNING: Product ${productId} failed to announce to Telegram after retry!`);
    }
  } catch(e) { console.error('TG announce error:', e); }

  res.json({ id: productId });
});

const CATEGORIES = [
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
  { id: 'mobils', name: 'Mòbils & Tauletes', emoji: '📱' },
  { id: 'eines', name: 'Eines & Bricolatge', emoji: '🛠️' },
  { id: 'art', name: 'Art', emoji: '🎨' },
  { id: 'p2p', name: 'P2P', emoji: '💶' },
  { id: 'llibres', name: 'Llibres', emoji: '📚' },
  { id: 'altres', name: 'Altres', emoji: '📦' },
];

// Shipping options for listings.
const SHIPPING_OPTIONS = ['no', 'inclos', 'peninsula', 'peninsula_illes', 'internacional'];
const SHIPPING_LABELS = {
  no: 'No disponibles', inclos: 'Incluidos en el precio', peninsula: 'Solo península',
  peninsula_illes: 'Península e islas', internacional: 'Internacional',
};
function shippingText(opt, price) {
  if (!opt || opt === 'no') return '';
  return (SHIPPING_LABELS[opt] || opt) + (price ? ' ' + price : '');
}

const REGIONS = [
  { id: 'barcelona', name: 'Barcelona', emoji: '🏛️' },
  { id: 'maresme', name: 'Maresme', emoji: '🚢' },
  { id: 'valles', name: 'Vallès', emoji: '🚂' },
  { id: 'osona', name: 'Osona', emoji: '🍽' },
  { id: 'girona', name: 'Girona', emoji: '⛅' },
  { id: 'emporda', name: 'Empordà', emoji: '🏝' },
  { id: 'tarragona', name: 'Tarragona', emoji: '🐟' },
  { id: 'baixllobregat', name: 'Baix Llobregat', emoji: '🍔' },
  { id: 'garraf', name: 'Garraf', emoji: '🔝' },
  { id: 'penedes', name: 'Penedès', emoji: '⛺' },
  { id: 'lleida', name: 'Pla de Lleida', emoji: '🍸' },
  { id: 'zaragoza', name: 'Zaragoza', emoji: '🍑' },
  { id: 'galicia', name: 'Galicia', emoji: '🐙' },
  { id: 'tenerife', name: 'Tenerife', emoji: '🌋' },
  { id: 'madrid', name: 'Madrid', emoji: '🐻' },
  { id: 'sensezna', name: 'Sense zona', emoji: '🌍' },
];

// --- Ratings API ---

// Get ratings for an npub
app.get('/api/ratings/:npub', (req, res) => {
  const npubHex = npubToHex(req.params.npub);
  const ratings = db.prepare('SELECT * FROM ratings WHERE rated_npub = ? ORDER BY created_at DESC').all(npubHex);
  ratings.forEach(r => { r.rater_npub = hexToNpub(r.rater_npub); r.rated_npub = hexToNpub(r.rated_npub); });
  const avg = db.prepare('SELECT AVG(stars) as avg, COUNT(*) as count FROM ratings WHERE rated_npub = ?').get(npubHex);
  res.json({ ratings, average: Math.round((avg.avg || 0) * 10) / 10, count: avg.count });
});

// Get ratings for a telegram-only seller (no npub)
app.get('/api/ratings-tg/:username', (req, res) => {
  const raw = req.params.username;
  const username = raw.startsWith('@') ? raw : '@' + raw;
  const ratings = db.prepare('SELECT * FROM ratings WHERE rated_telegram = ? ORDER BY created_at DESC').all(username);
  ratings.forEach(r => { r.rater_npub = hexToNpub(r.rater_npub); });
  const avg = db.prepare('SELECT AVG(stars) as avg, COUNT(*) as count FROM ratings WHERE rated_telegram = ?').get(username);
  res.json({ telegram: username, ratings, average: Math.round((avg.avg || 0) * 10) / 10, count: avg.count });
});

// Submit a rating (requires signed Nostr event as proof)
app.post('/api/ratings', (req, res) => {
  let { rater_npub, rated_npub, rated_telegram, stars, comment, signed_event } = req.body;
  rater_npub = npubToHex(rater_npub);
  if (rated_npub) rated_npub = npubToHex(rated_npub);
  if (rated_telegram) {
    rated_telegram = String(rated_telegram).trim();
    if (!rated_telegram.startsWith('@')) rated_telegram = '@' + rated_telegram;
  }

  if (!rater_npub || !stars || (!rated_npub && !rated_telegram)) {
    return res.status(400).json({ error: 'rater_npub, stars, and rated_npub or rated_telegram required' });
  }
  if (rated_npub && rater_npub === rated_npub) {
    return res.status(400).json({ error: 'Cannot rate yourself' });
  }
  if (stars < 1 || stars > 5) {
    return res.status(400).json({ error: 'Stars must be 1-5' });
  }
  // Require signed event as proof of rater identity
  if (!signed_event || signed_event.pubkey !== rater_npub || !signed_event.sig) {
    return res.status(403).json({ error: 'Signed Nostr event required matching rater_npub' });
  }

  if (rated_npub) {
    db.prepare(`
      INSERT INTO ratings (rater_npub, rated_npub, rated_telegram, stars, comment)
      VALUES (?, ?, NULL, ?, ?)
      ON CONFLICT(rater_npub, rated_npub) WHERE rated_npub IS NOT NULL
        DO UPDATE SET stars = excluded.stars, comment = excluded.comment, created_at = datetime('now')
    `).run(rater_npub, rated_npub, stars, comment || null);
  } else {
    db.prepare(`
      INSERT INTO ratings (rater_npub, rated_npub, rated_telegram, stars, comment)
      VALUES (?, NULL, ?, ?, ?)
      ON CONFLICT(rater_npub, rated_telegram) WHERE rated_telegram IS NOT NULL
        DO UPDATE SET stars = excluded.stars, comment = excluded.comment, created_at = datetime('now')
    `).run(rater_npub, rated_telegram, stars, comment || null);
  }
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
    u.npub = hexToNpub(u.npub);
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
  const npubHex = npubToHex(req.params.npub);
  let user = db.prepare('SELECT * FROM npub_profiles WHERE npub = ?').get(npubHex);
  if (!user) user = { npub: npubHex, display_name: null, picture: null };
  user.npub = hexToNpub(user.npub);

  const ratings = db.prepare(`
    SELECT r.*, np.display_name as rater_name, np.picture as rater_picture
    FROM ratings r LEFT JOIN npub_profiles np ON r.rater_npub = np.npub
    WHERE r.rated_npub = ? ORDER BY r.created_at DESC
  `).all(npubHex);
  ratings.forEach(r => {
    r.rater_npub = hexToNpub(r.rater_npub);
    r.rated_npub = hexToNpub(r.rated_npub);
  });

  const avg = db.prepare('SELECT AVG(stars) as avg, COUNT(*) as count FROM ratings WHERE rated_npub = ?').get(npubHex);

  // Products by this user
  const products = db.prepare(
    'SELECT * FROM products WHERE active = 1 AND (seller_npub = ? OR seller_telegram = ?) ORDER BY created_at DESC'
  ).all(npubHex, req.params.npub);
  products.forEach(p => {
    try { p.photos = JSON.parse(p.photos || '[]'); } catch { p.photos = []; }
    if (p.seller_npub) p.seller_npub = hexToNpub(p.seller_npub);
  });

  res.json({
    user, ratings, products,
    average: Math.round((avg.avg || 0) * 10) / 10,
    count: avg.count
  });
});

// --- My profile data ---
app.get('/api/me/:npub', (req, res) => {
  const npub = npubToHex(req.params.npub);

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
  const rawId = req.params.identifier;
  const id = rawId.startsWith('npub') ? npubToHex(rawId) : rawId;
  // Could be npub or telegram username
  const products = db.prepare(
    'SELECT * FROM products WHERE active = 1 AND (seller_npub = ? OR seller_telegram = ?) ORDER BY created_at DESC'
  ).all(id, rawId);

  products.forEach(p => {
    try { p.photos = JSON.parse(p.photos || '[]'); } catch { p.photos = []; }
  });

  let rating = { average: 0, count: 0 };
  let ratings = [];
  let user = { npub: id, display_name: null, picture: null };

  if (id.length === 64) {
    const avg = db.prepare('SELECT AVG(stars) as avg, COUNT(*) as count FROM ratings WHERE rated_npub = ?').get(id);
    rating = { average: Math.round((avg.avg || 0) * 10) / 10, count: avg.count };

    ratings = db.prepare(`
      SELECT r.*, np.display_name as rater_name, np.picture as rater_picture
      FROM ratings r LEFT JOIN npub_profiles np ON r.rater_npub = np.npub
      WHERE r.rated_npub = ? ORDER BY r.created_at DESC
    `).all(id);
    ratings.forEach(r => { r.rater_npub = hexToNpub(r.rater_npub); r.rated_npub = hexToNpub(r.rated_npub); });

    const profile = db.prepare('SELECT * FROM npub_profiles WHERE npub = ?').get(id);
    if (profile) {
      user = { npub: hexToNpub(profile.npub), display_name: profile.display_name, picture: profile.picture };
    }
  }

  res.json({ user, products, ratings, average: rating.average, count: rating.count });
});

// --- Internal API for Telegram scraper (called by Clawilom) ---
app.post('/api/internal/product', async (req, res) => {
  const { title, description, price, price_currency, region, category, photos, seller_telegram, seller_npub, telegram_message_id, telegram_chat_id } = req.body;

  // Duplicate detection: reject if same title + seller within 5 minutes
  const dup = db.prepare(
    "SELECT id FROM products WHERE title = ? AND seller_telegram = ? AND created_at > datetime('now', '-5 minutes') LIMIT 1"
  ).get(title, seller_telegram || null);
  if (dup) {
    console.log(`[Scraper] Duplicate rejected: "${title}" from ${seller_telegram} (existing ID ${dup.id})`);
    return res.json({ id: dup.id, duplicate: true });
  }

  const stmt = db.prepare(`
    INSERT INTO products (title, description, price, price_currency, region, category, photos, seller_telegram, seller_npub, source, telegram_message_id, telegram_chat_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'telegram', ?, ?)
  `);

  // Hashtag-driven event region (e.g. #BCC, #BCC26) wins over forced-seller
  // region: a Kilombino post tagged #BCC at the camp belongs in BCC26, not in
  // his usual baixllobregat zone.
  const hashtagRegion = detectHashtagRegion(`${title || ''} ${description || ''}`);
  const finalRegion = hashtagRegion || forcedRegionForSeller(seller_telegram) || region || null;

  let finalPhotos = photos || [];
  if (finalPhotos.length === 0) {
    const generic = pickPhotoForProduct({ title, description, category });
    if (generic) finalPhotos = [generic];
  }

  const result = stmt.run(
    title, description || '', price, price_currency || 'sats',
    finalRegion, category || null, JSON.stringify(finalPhotos),
    seller_telegram || null, seller_npub || null, telegram_message_id || null, telegram_chat_id || null
  );

  const productId = result.lastInsertRowid;

  // Sense caducitat from Telegram: detect #sensecaducitat or #nocaduca in title/description
  const combined = `${title || ''} ${description || ''}`.toLowerCase();
  const noExpiration = /#(?:sensecaducitat|nocaduca|nocaducidad|noexpira)\b/.test(combined);

  // Publish to Nostr
  try {
    const nostrEventId = await publishProduct({
      id: productId, title, description, price, price_currency: price_currency || 'sats',
      seller_npub: seller_npub || null, seller_telegram: seller_telegram || null,
      photos: finalPhotos, category, region
    }, null, { noExpiration });
    if (nostrEventId) {
      db.prepare('UPDATE products SET nostr_event_id = ? WHERE id = ?').run(nostrEventId, productId);
    }
  } catch(e) { console.error('Nostr publish error:', e.message); }

  res.json({ id: productId });
});

// --- Categories list ---
app.get('/api/suggest-photo', (req, res) => {
  const photo = pickPhotoForProduct({
    title: req.query.title || '',
    description: req.query.description || '',
    category: req.query.category || null
  });
  res.json({ photo: photo || null });
});

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
    { id: 'mobils', name: 'Mòbils & Tauletes', emoji: '📱' },
    { id: 'eines', name: 'Eines & Bricolatge', emoji: '🛠️' },
    { id: 'art', name: 'Art', emoji: '🎨' },
    { id: 'p2p', name: 'P2P', emoji: '💶' },
    { id: 'llibres', name: 'Llibres', emoji: '📚' },
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
// Regions can carry an `icon_url` for clients that prefer an image badge over
// the emoji fallback (e.g. event-specific zones like the BCC camp logo).
app.get('/api/regions', (req, res) => {
  const regions = [
    { id: 'bcc26', name: 'BCC26', emoji: '🥷', icon_url: '/icons/bcc26.jpg' },
    { id: 'barcelona', name: 'Barcelona', emoji: '🏛️' },
    { id: 'maresme', name: 'Maresme', emoji: '🚢' },
    { id: 'valles', name: 'Vallès', emoji: '🚂' },
    { id: 'osona', name: 'Osona', emoji: '🍽' },
    { id: 'girona', name: 'Girona', emoji: '⛅' },
    { id: 'emporda', name: 'Empordà', emoji: '🏝' },
    { id: 'tarragona', name: 'Tarragona', emoji: '🐟' },
    { id: 'baixllobregat', name: 'Baix Llobregat', emoji: '🍔' },
    { id: 'garraf', name: 'Garraf', emoji: '🔝' },
    { id: 'penedes', name: 'Penedès', emoji: '⛺' },
    { id: 'lleida', name: 'Pla de Lleida', emoji: '🍸' },
    { id: 'zaragoza', name: 'Zaragoza', emoji: '🍑' },
    { id: 'galicia', name: 'Galicia', emoji: '🐙' },
    { id: 'tenerife', name: 'Tenerife', emoji: '🌋' },
    { id: 'madrid', name: 'Madrid', emoji: '🐻' },
    { id: 'sensezna', name: 'Sense zona', emoji: '🌍' },
  ];
  res.json(regions);
});

// --- Seller trust score (relatr web-of-trust) via the relatr-bridge sidecar ---
const RELATR_BRIDGE = process.env.RELATR_BRIDGE || 'http://127.0.0.1:3041';
function trustLevel(s) {
  if (s === null || s === undefined) return 'unknown';
  if (s >= 0.7) return 'high';
  if (s >= 0.45) return 'medium';
  return 'low';
}
app.get('/api/trust/:npub', async (req, res) => {
  let hex = null;
  try { hex = npubToHex(req.params.npub); } catch (e) {}
  if (!hex && /^[0-9a-f]{64}$/i.test(req.params.npub)) hex = req.params.npub.toLowerCase();
  if (!hex || !/^[0-9a-f]{64}$/.test(hex)) return res.status(400).json({ error: 'invalid pubkey' });
  try {
    const r = await fetch(`${RELATR_BRIDGE}/trust/${hex}`, { signal: AbortSignal.timeout(28000) });
    const d = await r.json();
    res.json({ score: d.score, level: trustLevel(d.score), components: d.components, cached: d.cached });
  } catch (e) {
    res.json({ score: null, level: 'unknown', error: 'unavailable' });
  }
});

// Detect hashtag-driven event regions in user-supplied text (title/description).
// #BCC and #BCC26 → bcc26. Returns the region id or null. Case-insensitive,
// requires word boundary so it doesn't trigger inside arbitrary substrings.
const NODE_REGION_KEYWORDS = {
  'barcelona': 'barcelona', 'bcn': 'barcelona',
  'maresme': 'maresme', 'mataró': 'maresme', 'mataro': 'maresme',
  'vallès': 'valles', 'valles': 'valles', 'sabadell': 'valles', 'terrassa': 'valles',
  'osona': 'osona', 'vic': 'osona',
  'girona': 'girona',
  'empordà': 'emporda', 'emporda': 'emporda', 'figueres': 'emporda',
  'tarragona': 'tarragona', 'reus': 'tarragona',
  'baixllobregat': 'baixllobregat', 'cornellà': 'baixllobregat', 'cornella': 'baixllobregat',
  'prat': 'baixllobregat', 'sant boi': 'baixllobregat', 'sant feliu': 'baixllobregat',
  'garraf': 'garraf', 'sitges': 'garraf', 'vilanova': 'garraf',
  'penedès': 'penedes', 'penedes': 'penedes', 'vilafranca': 'penedes',
  'lleida': 'lleida',
  'zaragoza': 'zaragoza', 'zgz': 'zaragoza', 'saragossa': 'zaragoza',
  'galicia': 'galicia', 'galiza': 'galicia',
  'tenerife': 'tenerife',
};

function detectHashtagRegion(text) {
  if (!text) return null;
  const t = String(text);
  if (/(?:^|[^A-Za-z0-9])#BCC(?:26)?\b/i.test(t)) return 'bcc26';
  // Explicit "#node Barcelona" / "nodo Maresme" zone declaration. This is an
  // explicit user intent and outranks forcedRegionForSeller.
  const nodeMatch = t.match(/#?(?:node|nodo)[ \t]+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ \t]{0,30})/i);
  if (nodeMatch) {
    const candidate = nodeMatch[1].trim().toLowerCase().replace(/\s+/g, ' ');
    return NODE_REGION_KEYWORDS[candidate]
      || NODE_REGION_KEYWORDS[candidate.replace(/\s+/g, '')]
      || NODE_REGION_KEYWORDS[candidate.split(/\s+/)[0]]
      || null;
  }
  return null;
}

// --- Product sold status ---
app.get('/api/products/:id/status', (req, res) => {
  const product = db.prepare('SELECT id, title, sold, buyer_npub, sold_at, nostr_event_id FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Not found' });
  res.json(product);
});

// --- Reserve product (seller only) ---
app.post('/api/products/:id/reserve', async (req, res) => {
  const { reserved_by, signed_event, seller_npub } = req.body;
  if (!reserved_by) return res.status(400).json({ error: 'reserved_by required' });

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Not found' });

  // Verify ownership: seller_npub from request must match product seller
  if (product.seller_npub) {
    const requestNpub = signed_event?.pubkey || seller_npub;
    if (requestNpub) {
      const reqHex = npubToHex(requestNpub);
      if (product.seller_npub !== reqHex) {
        return res.status(403).json({ error: 'Només el venedor pot reservar el seu producte' });
      }
    }
  }

  db.prepare("UPDATE products SET reserved = 1, reserved_by = ?, reserved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
    .run(reserved_by, req.params.id);

  // Notify on Telegram. Quote-reply to the original product post when we have
  // its message_id, attach the product photo, and store the resulting message_id
  // so we can edit/delete the reserve message later (unreserve, sold, delete).
  try {
    const priceText = product.price + (product.price_currency === 'EUR' ? '€' : ' sats');
    const tgUser = product.seller_telegram
      ? (product.seller_telegram.startsWith('@') ? product.seller_telegram : '@' + product.seller_telegram)
      : null;
    const sellerLine = tgUser
      ? tgEscape(tgUser)
      : tgEscape((product.seller_npub || '').substring(0, 16));
    const productUrl = `https://mercasats.kilombino.com/?p=${product.id}`;
    const productUrlLabel = `mercasats\\.kilombino\\.com/?p\\=${product.id}`;
    const text = `🔒 *Reservat\\!*\n\n*${tgEscape(product.title)}*\n💰 ${tgEscape(priceText)}\n\n📌 Reservat per: ${tgEscape(reserved_by)}\n👤 Venedor: ${sellerLine}\n\n🔗 [${productUrlLabel}](${productUrl})`;

    let photos = [];
    try { photos = JSON.parse(product.photos || '[]'); } catch {}
    const photoUrl = photos.length > 0
      ? (photos[0].startsWith('http') ? photos[0] : `https://mercasats.kilombino.com${photos[0]}`)
      : null;

    const opts = product.telegram_message_id ? { replyToMessageId: product.telegram_message_id } : {};
    const announceRes = await sendTelegramAnnounce(text, photoUrl, null, opts);
    if (announceRes.messageId) {
      db.prepare('UPDATE products SET telegram_reserve_message_id = ? WHERE id = ?')
        .run(String(announceRes.messageId), product.id);
    }
  } catch(e) { console.error('TG reserve announce error:', e); }

  // Notify on Nostr
  try {
    const { publishProduct } = require('./nostr-publish');
    const content = `🔒 Reservat: ${product.title}\nReservat per: ${reserved_by}\nPreu: ${product.price} ${product.price_currency}`;
    const event = require('nostr-tools/pure').finalizeEvent({
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['t', 'mercasats'], ['t', 'reserva']],
      content,
    }, Uint8Array.from(Buffer.from(process.env.NOSTR_NSEC_HEX, 'hex')));
    const { publishToRelays } = require('./nostr-publish');
    await publishToRelays(event);
  } catch(e) { console.error('Nostr reserve error:', e); }

  res.json({ ok: true, reserved: true, reserved_by });
});

// --- Unreserve product ---
app.post('/api/products/:id/unreserve', async (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Not found' });

  db.prepare("UPDATE products SET reserved = 0, reserved_by = NULL, reserved_at = NULL, telegram_reserve_message_id = NULL, updated_at = datetime('now') WHERE id = ?")
    .run(req.params.id);

  // Clean up the reservation announcement in Telegram so the channel doesn't
  // keep showing a stale "🔒 Reservat" message after the seller cancels.
  if (product.telegram_reserve_message_id && product.telegram_chat_id) {
    try {
      const r = await deleteTelegramMessage(product.telegram_chat_id, product.telegram_reserve_message_id);
      console.log(`[Unreserve] TG reserve ${product.telegram_reserve_message_id}: ${r.ok ? 'OK' : 'FAIL — ' + (r.description || 'unknown')}`);
    } catch(e) { console.error('[Unreserve] TG delete error:', e.message); }
  }

  res.json({ ok: true, reserved: false });
});

// --- Delete product (owner only, requires signed event) ---
app.delete('/api/products/:id', async (req, res) => {
  const { signed_event, seller_npub } = req.body;

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Not found' });

  // Verify ownership: signed_event pubkey OR seller_npub must match
  const requestNpub = signed_event?.pubkey || seller_npub;
  if (!requestNpub) return res.status(403).json({ error: 'Seller identity required' });
  const reqHex = npubToHex(requestNpub);
  if (product.seller_npub && product.seller_npub !== reqHex) {
    return res.status(403).json({ error: 'Not your product' });
  }

  // 1. Delete from DB (soft delete)
  db.prepare("UPDATE products SET active = 0, removal_reason = ?, updated_at = datetime('now') WHERE id = ?")
    .run('Eliminat pel venedor des de la web', req.params.id);

  // 2. Delete from Telegram (photo + optional long-text reply + reserve note).
  // Log the actual API response so failures don't masquerade as successes.
  if (product.telegram_message_id && product.telegram_chat_id) {
    try {
      const r1 = await deleteTelegramMessage(product.telegram_chat_id, product.telegram_message_id);
      console.log(`[Delete] TG message ${product.telegram_message_id}: ${r1.ok ? 'OK' : 'FAIL — ' + (r1.description || 'unknown')}`);
      if (product.telegram_long_message_id) {
        const r2 = await deleteTelegramMessage(product.telegram_chat_id, product.telegram_long_message_id);
        console.log(`[Delete] TG long message ${product.telegram_long_message_id}: ${r2.ok ? 'OK' : 'FAIL — ' + (r2.description || 'unknown')}`);
      }
    } catch(e) {
      console.error('[Delete] TG delete error:', e.message);
    }
  }
  if (product.telegram_reserve_message_id && product.telegram_chat_id) {
    try {
      const r3 = await deleteTelegramMessage(product.telegram_chat_id, product.telegram_reserve_message_id);
      console.log(`[Delete] TG reserve ${product.telegram_reserve_message_id}: ${r3.ok ? 'OK' : 'FAIL — ' + (r3.description || 'unknown')}`);
    } catch(e) { console.error('[Delete] TG reserve delete error:', e.message); }
  }

  // 2b. Announce deletion in Telegram topic
  try {
    const seller = product.seller_telegram ? (product.seller_telegram.startsWith('@') ? product.seller_telegram : '@' + product.seller_telegram) : 'Anonim';
    const delText = `🗑️ *Anunci eliminat*\n\n*${tgEscape(product.title)}*\n👤 ${seller}\n\nEl venedor ha retirat aquest anunci\\.`;
    await sendTelegramAnnounce(delText, null);
  } catch(e) { console.error('[Delete] TG announce error:', e.message); }

  // 3. Delete from Nostr (publish deletion event kind 5)
  if (product.nostr_event_id) {
    try {
      await deleteFromNostr(product.nostr_event_id, product.id);
      console.log(`[Delete] Nostr event ${product.nostr_event_id} deleted`);
    } catch(e) { console.error('[Delete] Nostr error:', e.message); }
  }

  res.json({ ok: true, deleted: product.id });
});

// --- Edit product (owner only, requires signed event) ---
const editCooldown = new Map();
const EDIT_MIN_INTERVAL_MS = 8_000;

app.put('/api/products/:id', async (req, res) => {
  const { signed_event, title, description, price, price_currency, region, category, shipping_option, shipping_price } = req.body;

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Not found' });
  if (!product.active) return res.status(400).json({ error: 'Product not active' });

  // Verify ownership via signed event
  if (!signed_event || !signed_event.sig || !signed_event.pubkey) {
    return res.status(403).json({ error: 'Signed Nostr event required to edit' });
  }
  if (!product.seller_npub || signed_event.pubkey !== product.seller_npub) {
    return res.status(403).json({ error: 'Not your product' });
  }

  // Rate-limit: one edit every 30s per product to prevent flood
  const now = Date.now();
  const last = editCooldown.get(product.id) || 0;
  if (now - last < EDIT_MIN_INTERVAL_MS) {
    const wait = Math.ceil((EDIT_MIN_INTERVAL_MS - (now - last)) / 1000);
    return res.status(429).json({ error: `Espera ${wait}s abans d'editar de nou` });
  }
  editCooldown.set(product.id, now);

  // Validate inputs
  const newTitle = typeof title === 'string' && title.trim() ? title.trim() : product.title;
  const newDesc = (typeof description === 'string') ? description : product.description;
  const newPrice = (price !== undefined && price !== null && String(price).trim() !== '') ? String(price).trim() : product.price;
  const newCurrency = price_currency || product.price_currency;
  const newRegion = (region === null || typeof region === 'string') ? region : product.region;
  const newCategory = (category === null || typeof category === 'string') ? category : product.category;

  const newShipOpt = SHIPPING_OPTIONS.includes(shipping_option) ? shipping_option : (product.shipping_option || 'no');
  const newShipPrice = newShipOpt !== 'no' ? ((typeof shipping_price === 'string' ? shipping_price.trim().slice(0, 20) : '') || '') : '';

  db.prepare(`UPDATE products SET title = ?, description = ?, price = ?, price_currency = ?, region = ?, category = ?, shipping_option = ?, shipping_price = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(newTitle, newDesc, newPrice, newCurrency, newRegion, newCategory, newShipOpt, newShipPrice, req.params.id);

  // Update expires_at based on the signed edit event's expiration tag (or absence thereof)
  const editExpTag = Array.isArray(signed_event?.tags) ? signed_event.tags.find(t => t[0] === 'expiration') : null;
  const editExpTs = editExpTag ? parseInt(editExpTag[1], 10) : NaN;
  const editNoExpiration = !editExpTag;
  if (editNoExpiration) {
    db.prepare('UPDATE products SET expires_at = NULL WHERE id = ?').run(req.params.id);
  } else if (Number.isFinite(editExpTs) && editExpTs > Math.floor(Date.now() / 1000)) {
    db.prepare('UPDATE products SET expires_at = ? WHERE id = ?').run(editExpTs, req.params.id);
  }

  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);

  // Republish to Nostr (client's signed event if valid, else marketplace key with same d-tag)
  try {
    const parsedPhotos = JSON.parse(updated.photos || '[]');
    const nostrEventId = await publishProduct({
      id: updated.id, title: updated.title, description: updated.description,
      price: updated.price, price_currency: updated.price_currency,
      seller_npub: updated.seller_npub, seller_telegram: updated.seller_telegram,
      photos: parsedPhotos, category: updated.category, region: updated.region,
      shipping_option: updated.shipping_option, shipping_price: updated.shipping_price,
    }, signed_event, { noExpiration: editNoExpiration });
    if (nostrEventId) {
      db.prepare('UPDATE products SET nostr_event_id = ? WHERE id = ?').run(nostrEventId, updated.id);
    }
  } catch(e) { console.error('[Edit] Nostr publish error:', e.message); }

  // Update Telegram caption
  if (updated.telegram_message_id && updated.telegram_chat_id) {
    try {
      const catObj = updated.category ? CATEGORIES.find(c => c.id === updated.category) : null;
      const catName = catObj?.name || updated.category || '';
      const catEmoji = catObj?.emoji || '';
      const priceText = (updated.price && !isNaN(Number(updated.price))) ? updated.price + (updated.price_currency === 'EUR' ? '€' : ' sats') : (updated.price || 'A consultar');
      const cleanHandle = updated.seller_telegram && /^@?[A-Za-z0-9_]{3,}$/.test(updated.seller_telegram)
        ? (updated.seller_telegram.startsWith('@') ? updated.seller_telegram : '@' + updated.seller_telegram)
        : null;
      const tgUser = cleanHandle;
      const contact = cleanHandle || updated.seller_telegram || (updated.seller_npub ? updated.seller_npub.substring(0, 16) + '...' : '');
      const desc = (updated.description || '').substring(0, 3500);
      const regionObj = updated.region ? REGIONS.find(r => r.id === updated.region) : null;
      const regionName = regionObj?.name || updated.region || '';
      const regionEmoji = regionObj?.emoji || '';
      const isCompra = /compro|compra|busco|\[compra\]/i.test(updated.title);
      const tipoText = isCompra ? 'COMPRA' : 'VENDE';
      const productUrl = `https://mercasats.kilombino.com/?p=${updated.id}`;
      const productUrlLabel = `mercasats\\.kilombino\\.com/?p\\=${updated.id}`;
      const shipLine = (updated.shipping_option && updated.shipping_option !== 'no') ? `\n📦 *\\#ENVIOS* ${tgEscape(shippingText(updated.shipping_option, updated.shipping_price))}` : '';
      const fullBody = `🛒 *\\#${tipoText}* *${tgEscape(updated.title)}*\n📍 *\\#NODE* ${regionEmoji} ${tgEscape(regionName || 'Sense zona')}\n📂 *\\#CATEGORIA* ${catEmoji} ${tgEscape(catName || 'Sense categoria')}\n🪙 *\\#PRECIO* 💰${tgEscape(priceText)}${shipLine}\n📝 *\\#DESCRIPCION*\n${tgEscape(desc)}\n👤 ${tgEscape(tgUser || contact)}\n\n🔗 [${productUrlLabel}](${productUrl})`;
      const summary = `🛒 *\\#${tipoText}* \\| 💰${tgEscape(priceText)} \\| ${regionEmoji}${tgEscape(regionName || 'Sense zona')}\n📝 *${tgEscape(updated.title)}*\n\n👇 Descripció completa abaix\n🔗 [${productUrlLabel}](${productUrl})`;

      const hadLong = !!updated.telegram_long_message_id;
      const needsLong = fullBody.length > TG_CAPTION_LIMIT;

      if (needsLong) {
        // Photo caption → summary; long reply → full body
        await tgApi('editMessageCaption', {
          chat_id: updated.telegram_chat_id,
          message_id: Number(updated.telegram_message_id),
          caption: summary,
          parse_mode: 'MarkdownV2',
        });
        if (hadLong) {
          await tgApi('editMessageText', {
            chat_id: updated.telegram_chat_id,
            message_id: Number(updated.telegram_long_message_id),
            text: fullBody,
            parse_mode: 'MarkdownV2',
            link_preview_options: { is_disabled: true },
          });
        } else {
          // No long message existed; post one as a reply and remember its id
          const textResp = await tgApi('sendMessage', {
            chat_id: updated.telegram_chat_id,
            message_thread_id: TG_THREAD_ID,
            text: fullBody,
            parse_mode: 'MarkdownV2',
            reply_parameters: { message_id: Number(updated.telegram_message_id) },
            link_preview_options: { is_disabled: true },
          });
          if (textResp.ok) {
            db.prepare('UPDATE products SET telegram_long_message_id = ? WHERE id = ?')
              .run(String(textResp.result.message_id), updated.id);
          }
        }
      } else {
        // Fits in one — put full body in photo caption; remove stale long reply if any
        await tgApi('editMessageCaption', {
          chat_id: updated.telegram_chat_id,
          message_id: Number(updated.telegram_message_id),
          caption: fullBody,
          parse_mode: 'MarkdownV2',
        });
        if (hadLong) {
          await tgApi('deleteMessage', {
            chat_id: updated.telegram_chat_id,
            message_id: Number(updated.telegram_long_message_id),
          });
          db.prepare('UPDATE products SET telegram_long_message_id = NULL WHERE id = ?').run(updated.id);
        }
      }
    } catch(e) { console.error('[Edit] TG edit error:', e.message); }
  }

  // Return photos as an array (the app expects product.photos to be an array;
  // the DB stores it as a JSON string) and the npub in bech32, like the GET.
  let photosArr = [];
  try { photosArr = JSON.parse(updated.photos || '[]'); } catch (e) {}
  res.json({ ok: true, product: { ...updated, photos: photosArr, seller_npub: hexToNpub(updated.seller_npub) } });
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

  // Clean up the reserve announcement if the original product was deleted
  // from Telegram while still reserved.
  if (product.telegram_reserve_message_id && product.telegram_chat_id) {
    try {
      const r = await deleteTelegramMessage(product.telegram_chat_id, product.telegram_reserve_message_id);
      console.log(`[Internal Delete] TG reserve ${product.telegram_reserve_message_id}: ${r.ok ? 'OK' : 'FAIL — ' + (r.description || 'unknown')}`);
    } catch(e) { console.error('[Internal Delete] TG reserve delete error:', e.message); }
  }

  // Delete local photo if exists
  if (product.photos) {
    try {
      const photos = JSON.parse(product.photos);
      for (const p of photos) {
        // Accept both relative ("/photos/x") and absolute URLs.
        let rel = p;
        if (typeof p === 'string' && p.startsWith('http')) { try { rel = new URL(p).pathname; } catch (e) {} }
        if (typeof rel === 'string' && rel.startsWith('/photos/')) {
          const fullPath = path.join(__dirname, 'public', rel);
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

  // Recently reserved products
  const reservedProducts = db.prepare(
    "SELECT id, title, price, price_currency, photos, seller_telegram, reserved_by, reserved_at FROM products WHERE reserved = 1 AND reserved_at > ? ORDER BY reserved_at DESC LIMIT 10"
  ).all(since);

  res.json({ newProducts, newRatings, removedProducts, soldProducts, reservedProducts });
});

// --- Expiration sweep (NIP-40): auto-delete products past expires_at ---
async function sweepExpiredProducts() {
  try {
    const now = Math.floor(Date.now() / 1000);
    const expired = db.prepare(
      'SELECT * FROM products WHERE active = 1 AND expires_at IS NOT NULL AND expires_at <= ?'
    ).all(now);
    if (!expired.length) return;
    console.log(`[ExpSweep] Found ${expired.length} expired product(s)`);
    for (const product of expired) {
      try {
        const reason = 'Caducat (NIP-40 expiration)';
        db.prepare("UPDATE products SET active = 0, removal_reason = ?, updated_at = datetime('now') WHERE id = ?")
          .run(reason, product.id);
        if (product.telegram_message_id && product.telegram_chat_id) {
          try {
            await deleteTelegramMessage(product.telegram_chat_id, product.telegram_message_id);
            if (product.telegram_long_message_id) {
              await deleteTelegramMessage(product.telegram_chat_id, product.telegram_long_message_id);
            }
          }
          catch(e) { console.error(`[ExpSweep] TG delete error for ${product.id}:`, e.message); }
        }
        if (product.nostr_event_id) {
          try { await deleteFromNostr(product.nostr_event_id, product.id); }
          catch(e) { console.error(`[ExpSweep] Nostr delete error for ${product.id}:`, e.message); }
        }
        console.log(`[ExpSweep] Product ${product.id} "${product.title}" expired and removed`);
      } catch(e) { console.error(`[ExpSweep] Product ${product.id} error:`, e.message); }
    }
  } catch(e) { console.error('[ExpSweep] sweep error:', e.message); }
}

// --- CORS preflight for DELETE ---
app.options('/api/products/:id', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).end();
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Merkasats API on http://127.0.0.1:${PORT}`);
  // NIP-40 expiration sweep: run once on start, then every hour
  sweepExpiredProducts();
  setInterval(sweepExpiredProducts, 60 * 60 * 1000);
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
