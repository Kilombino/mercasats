/**
 * Telegram Scraper for MercaSats
 *
 * Polls the Mercabot Telegram bot for new messages in the "Mercats de sats" topic
 * and forwards them to the MercaSats backend via /api/internal/product
 *
 * Environment variables:
 *   MERCABOT_TOKEN - Telegram bot token for Mercabot
 *   MERCASATS_API  - Backend URL (default: http://localhost:3102)
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.MERCABOT_TOKEN;
const API_BASE = process.env.MERCASATS_API || 'http://localhost:3102';
const OFFSET_FILE = path.join(__dirname, '.scraper-offset');
const POLL_INTERVAL = 30_000; // 30 seconds
const TARGET_CHAT_ID = -1002457902120; // Trobades bitcoiners
const TARGET_THREAD_ID = 2106; // Mercats de sats topic

if (!BOT_TOKEN) {
  console.error('[Scraper] MERCABOT_TOKEN not set');
  process.exit(1);
}

// Load last processed update offset
function loadOffset() {
  try {
    return parseInt(fs.readFileSync(OFFSET_FILE, 'utf8').trim(), 10);
  } catch {
    return 0;
  }
}

function saveOffset(offset) {
  fs.writeFileSync(OFFSET_FILE, String(offset));
}

// Telegram API call
function tgApi(method, params = {}) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(params);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok) resolve(parsed.result);
          else reject(new Error(parsed.description || 'TG API error'));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Download a photo from Telegram and save locally
async function downloadPhoto(fileId) {
  const file = await tgApi('getFile', { file_id: fileId });
  const filePath = file.file_path;
  const ext = path.extname(filePath) || '.jpg';
  const localName = `tg-${Date.now()}${ext}`;
  const localPath = path.join(__dirname, 'photos', localName);

  return new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(localPath);
    https.get(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`, (res) => {
      res.pipe(dest);
      dest.on('finish', () => {
        dest.close();
        const url = `/photos/${localName}`;
        generateThumbAsync(url);
        resolve(url);
      });
    }).on('error', (e) => {
      fs.unlink(localPath, () => {});
      reject(e);
    });
  });
}

// Post product to MercaSats backend
function postProduct(product) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(product);
    const url = new URL(`${API_BASE}/api/internal/product`);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

const { findGenericPhoto, pickPhotoForProduct } = require('./generic-photos');
const { generateThumbAsync } = require('./thumb');

// Detects messages that mimic the bot's announcement format. These are
// usually copy-pastes from a previous bot post and the actual title lives
// in the "📝 #DESCRIPCION X" line, not the first line. Match any 🛒-prefixed
// hashtag at the start (VENDE/VENDO/COMPRA/COMPRO/SERVEI/SERVICIO/etc.) —
// users mix Catalan/Spanish freely.
function isBotFormatMimicry(text) {
  return /^\s*🛒\s*#[A-Za-zÀ-ÿ]+/i.test(text || '');
}

// Parse a message into a product listing
function parseMessage(msg) {
  const text = msg.text || msg.caption || '';
  if (!text || text.length < 10) return null; // Too short to be a listing

  const from = msg.from || {};
  const username = from.username ? `@${from.username}` : from.first_name || 'Anónimo';

  // Detect "#node X" / "nodo X" → region id, and capture the phrase to strip
  // it before category detection (so "node Barcelona" doesn't match the
  // bitcoin keyword set).
  const { region, phrase: nodePhrase } = detectNodeRegion(text);

  // Try to extract price (numbers + optional k/M suffix + sats/btc/€/eur).
  // Examples: "28k sats" → 28000, "1.5M sats" → 1500000, "30.000 sats" → 30000.
  let price = 'A convenir';
  let priceCurrency = 'sats';
  const priceMatch = text.match(/(\d[\d.,]*)\s*([kKmM])?\s*(sats?|btc|€|eur|euros?)/i);
  if (priceMatch) {
    const rawPrice = priceMatch[1];
    const mult = (priceMatch[2] || '').toLowerCase();
    const unit = priceMatch[3].toLowerCase();
    if (unit.startsWith('btc')) priceCurrency = 'btc';
    else if (unit === '€' || unit.startsWith('eur')) priceCurrency = 'eur';
    else priceCurrency = 'sats';

    const numStr = rawPrice.replace(/\./g, '').replace(',', '.');
    let value = parseFloat(numStr);
    if (mult === 'k') value *= 1000;
    else if (mult === 'm') value *= 1000000;

    if (Number.isFinite(value)) {
      price = priceCurrency === 'sats' ? String(Math.round(value)) : String(value);
    }
  }

  // Title extraction. Default = first non-meta line (skip bare-hashtag and
  // "#node X" lines so "#Informàtica\n#node Barcelona\nDisc Dur..." titles as
  // "Disc Dur..."). If the message mimics the bot format (🛒 #VENDE/#COMPRA),
  // pull from the 📝 #DESCRIPCION line.
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const isMetaLine = (l) =>
    /^#?(?:node|nodo)\s+\S+/i.test(l) ||
    /^#[A-Za-zÀ-ÿ]+\s*$/.test(l);
  let titleSource = lines.find(l => !isMetaLine(l)) || lines[0] || '';
  if (isBotFormatMimicry(text)) {
    // Title lives on the action line: "🛒 #VENDE <title>". Take the text after
    // the action hashtag.
    const actionLine = lines.find(l => /#(VEN[DT]|COMPR|SERVE?I|SERVICIO|REGAL)/i.test(l));
    if (actionLine) {
      const t = actionLine.replace(/^[^#]*#[A-Za-zÀ-ÿ]+\s*/, '').replace(/[*_`]/g, '').trim();
      if (t) titleSource = t;
    }
    // Fallback: inline text on the 📝 #DESCRIPCION line, or the line right after it.
    if (!titleSource.trim()) {
      const di = lines.findIndex(l => /^📝\s*#DESCRIP/i.test(l));
      if (di >= 0) {
        const inline = lines[di].replace(/^📝\s*#DESCRIP\w*\s*/i, '').trim();
        titleSource = inline || lines[di + 1] || '';
      }
    }
  }
  const title = titleSource.length > 60 ? titleSource.substring(0, 57) + '...' : titleSource;

  // Category: explicit hashtag (#Informàtica, #Bitcoin) wins over keyword
  // heuristics. Strip the "#node X" phrase first to avoid false matches.
  const textForCategory = nodePhrase ? text.replace(nodePhrase, ' ') : text;
  const category = detectCategoryHashtag(textForCategory) || detectCategory(textForCategory);

  return {
    title,
    description: text,
    price,
    price_currency: priceCurrency,
    region,
    category,
    photos: [],
    seller_telegram: username,
    telegram_message_id: String(msg.message_id),
    telegram_chat_id: String(msg.chat.id)
  };
}

// Known Telegram username → Nostr npub (hex) mappings
// These are auto-applied to products from these sellers
const KNOWN_NPUBS = {
  '@Kilombino': '00000000507f1a27b43d2c47da2ee826378dba007501d66691fada36fa931856',
  '@kilombino': '00000000507f1a27b43d2c47da2ee826378dba007501d66691fada36fa931856',
  '@eznomada': 'c8a6fdb60aa9b1df56b360e0ab5ae14de6c970aac234aeb12817a188d0dc1350',
  '@androdebian': '9a43f3ee53d67c6cc24aeeda2f575548db352f60f8b9d997ce32a995bd353e59',
  '@r4f4_th': '1d5357bf36c53d0921f461cf199832da78d9238b4968d3b5185051d11bdf0a52',
  '@LadySilSol': '49e38160c791790321bc93711576cbd4e0fce9895ce7b5e7abe64ad26d17f4e8',
  '@mussolhold': '0c6ab0cabb62bcee2b2a35f49a35716f5766c6a2476134a18a3316579133b99e',
};

// Auto-detect product category from text
const CATEGORY_RULES = [
  { id: 'informatica', keywords: ['pc', 'ordenador', 'portátil', 'laptop', 'monitor', 'teclado', 'ratón', 'impresora', 'usb', 'ssd', 'ram', 'gpu', 'cpu', 'raspberry', 'arduino'] },
  { id: 'bitcoin', keywords: ['wallet', 'hardware wallet', 'seedsigner', 'coldcard', 'trezor', 'ledger', 'krux', 'umbrel', 'minibolt', 'start9', 'miner', 'asic', 'bitaxe', 'nerdminer', 'lightning', 'lnd', 'cln'] },
  { id: 'energia', keywords: ['solar', 'panel', 'fotovolt', 'batería', 'inversor', 'energía', 'watt'] },
  { id: 'alimentacio', keywords: ['miel', 'aceite', 'oliva', 'carne', 'fruta', 'verdura', 'vino', 'cerveza', 'café', 'chocolate', 'queso', 'jamón', 'embutido', 'huevo', 'aliment'] },
  { id: 'roba', keywords: ['camiseta', 'zapatilla', 'zapato', 'pantalón', 'chandal', 'jersey', 'chaqueta', 'abrigo', 'gorra', 'ropa', 'roba', 'vestido', 'mcqueen', 'nike', 'adidas', 'jordan', 'sneaker', 'bambas', 'vaquero'] },
  { id: 'complements', keywords: ['reloj', 'rellotge', 'pulsera', 'collar', 'anillo', 'gafas', 'cartera', 'bolso', 'mochila', 'funda'] },
  { id: 'gaming', keywords: ['consola', 'playstation', 'xbox', 'nintendo', 'switch', 'juego', 'joc', 'gaming', 'mando', 'steam'] },
  { id: 'finances', keywords: ['moneda', 'plata', 'oro', 'divisa', 'corona', 'duro', 'numismát'] },
  { id: 'serveis', keywords: ['servicio', 'servei', 'clase', 'classes', 'masaje', 'osteopat', 'gestor', 'impuesto', 'reparación', 'instalación'] },
  { id: 'vehicle', keywords: ['coche', 'cotxe', 'moto', 'bici', 'patinete', 'rueda', 'casco', 'motor'] },
  { id: 'esport', keywords: ['deporte', 'esport', 'gym', 'fitness', 'yoga', 'esquí', 'esqui', 'pelota', 'raqueta'] },
  { id: 'llar', keywords: ['piso', 'casa', 'alquiler', 'lloguer', 'habitación', 'colchón', 'mueble', 'alojamiento', 'inmueble', 'immoble'] },
  { id: 'eines', keywords: ['eina', 'eines', 'herramienta', 'bricolaje', 'bricolatge', 'destornillador', 'tornavís', 'taladro', 'martillo', 'martell', 'sierra', 'serra', 'llave', 'clau anglesa', 'facom', 'bosch', 'makita', 'dewalt', 'milwaukee', 'stanley'] },
  { id: 'art', keywords: ['pintura', 'cuadro', 'quadre', 'escultura', 'lienzo', 'llenç', 'acuarela', 'aquarel·la', 'dibuix', 'ilustración', 'il·lustració', 'artesania', 'artesanía', 'óleo', 'pintor', 'escultor', 'galeria d\'art', 'galería de arte'] },
  { id: 'p2p', keywords: ['p2p', 'peer-to-peer', 'peer to peer', 'mostro', 'nostromostro', 'robosats', 'hodlhodl', 'hodl hodl', 'agorabtc', 'agora btc', 'bisq', 'lnp2pbot', 'peach', 'sin kyc', 'no-kyc', 'no kyc', 'sense kyc'] },
  { id: 'llibres', keywords: ['llibre', 'llibres', 'libro', 'libros', 'novela', 'novel·la', 'novel.la', 'manual', 'ensayo', 'assaig', 'poesía', 'poesia', 'cómic', 'còmic', 'comic', 'manga', 'enciclopedia', 'enciclopèdia', 'diccionari', 'diccionario'] },
];

function detectCategory(text) {
  const lower = text.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some(kw => lower.includes(kw))) {
      return rule.id;
    }
  }
  return null;
}

// "#node Barcelona" / "nodo Maresme" → region id. Cities/comarques map to the
// canonical Mercasats region they belong to.
const NODE_KEYWORDS = {
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

function detectNodeRegion(text) {
  const m = text.match(/#?(?:node|nodo)[ \t]+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ \t]{0,30})/i);
  if (!m) return { region: null, phrase: null };
  const phrase = m[0];
  const candidate = m[1].trim().toLowerCase().replace(/\s+/g, ' ');
  const id = NODE_KEYWORDS[candidate]
    || NODE_KEYWORDS[candidate.replace(/\s+/g, '')]
    || NODE_KEYWORDS[candidate.split(/\s+/)[0]]
    || null;
  return { region: id, phrase };
}

// Map "#Informàtica", "#Bitcoin" etc. to category ids by name match.
const CATEGORY_NAME_MAP = {
  'informàtica': 'informatica', 'informatica': 'informatica',
  'bitcoin': 'bitcoin',
  'energia': 'energia', 'energía': 'energia',
  'alimentació': 'alimentacio', 'alimentacio': 'alimentacio', 'alimentación': 'alimentacio',
  'roba': 'roba', 'ropa': 'roba',
  'complements': 'complements', 'complementos': 'complements',
  'gaming': 'gaming',
  'finances': 'finances', 'finanzas': 'finances',
  'serveis': 'serveis', 'servicios': 'serveis',
  'vehicle': 'vehicle', 'vehiculo': 'vehicle', 'vehículo': 'vehicle',
  'esport': 'esport', 'deporte': 'esport',
  'llar': 'llar', 'hogar': 'llar',
  'eines': 'eines', 'herramientas': 'eines',
  'art': 'art', 'arte': 'art',
  'p2p': 'p2p',
  'llibres': 'llibres', 'libros': 'llibres', 'llibre': 'llibres', 'libro': 'llibres',
  'altres': 'altres', 'otros': 'altres',
};

function detectCategoryHashtag(text) {
  const re = /#([A-Za-zÀ-ÿ]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const tag = m[1].toLowerCase();
    if (CATEGORY_NAME_MAP[tag]) return CATEGORY_NAME_MAP[tag];
  }
  return null;
}

// Track recent products to link follow-up photos (user_id -> { productId, timestamp })
const recentProducts = new Map();
const PHOTO_LINK_WINDOW = 5 * 60_000; // 5 minutes window to link photos

function addPhotoToProduct(productId, photoPath) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ photos: [photoPath] });
    const url = new URL(`${API_BASE}/api/internal/product/${productId}/photos`);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Main polling loop
async function poll() {
  let offset = loadOffset();

  try {
    const updates = await tgApi('getUpdates', {
      offset: offset > 0 ? offset : undefined,
      limit: 50,
      timeout: 10,
      allowed_updates: ['message']
    });

    for (const update of updates) {
      const msg = update.message;
      if (!msg) { offset = update.update_id + 1; continue; }

      // Only process messages from the target topic
      if (msg.chat.id !== TARGET_CHAT_ID || msg.message_thread_id !== TARGET_THREAD_ID) {
        offset = update.update_id + 1;
        continue;
      }

      // Skip service messages (topic created, pinned, etc.)
      if (msg.forum_topic_created || msg.pinned_message) {
        offset = update.update_id + 1;
        continue;
      }

      const fromId = msg.from?.id;
      const fromUser = msg.from?.username || 'unknown';
      console.log(`[Scraper] Processing message ${msg.message_id} from @${fromUser}`);

      // Check if this is a follow-up photo for a recent product from the same user.
      // Treat as follow-up when: photo present + same user within window AND the
      // message does NOT look like a fresh listing — i.e. it doesn't open with
      // the bot-format header 🛒 #VENDE/#COMPRA/#SERVEI AND its caption doesn't
      // carry its own price tag (e.g. "30000 sats", "40€"). A caption with a
      // price strongly signals a separate item — collapsing it into the
      // previous listing loses the second product.
      const hasPhoto = msg.photo && msg.photo.length > 0;
      const text = msg.text || msg.caption || '';
      const looksFresh = isBotFormatMimicry(text);
      const hasOwnPrice = /(\d[\d.,]*)\s*(sats?|btc|€|eur|euros?)/i.test(text);
      if (hasPhoto && !looksFresh && !hasOwnPrice && fromId && recentProducts.has(fromId)) {
        const recent = recentProducts.get(fromId);
        if (Date.now() - recent.timestamp < PHOTO_LINK_WINDOW) {
          try {
            const largest = msg.photo[msg.photo.length - 1];
            const localPath = await downloadPhoto(largest.file_id);
            await addPhotoToProduct(recent.productId, localPath);
            console.log(`[Scraper] Linked follow-up photo to product ${recent.productId}: ${localPath} (caption=${text.length} chars)`);
          } catch (e) {
            console.error(`[Scraper] Failed to link follow-up photo:`, e.message);
          }
          offset = update.update_id + 1;
          continue;
        }
      }

      const product = parseMessage(msg);
      if (!product) {
        console.log(`[Scraper] Skipped message ${msg.message_id} (too short or unparseable)`);
        offset = update.update_id + 1;
        continue;
      }

      // Download photos if any, otherwise use generic
      if (msg.photo && msg.photo.length > 0) {
        try {
          const largest = msg.photo[msg.photo.length - 1];
          const localPath = await downloadPhoto(largest.file_id);
          product.photos = [localPath];
          console.log(`[Scraper] Downloaded photo: ${localPath}`);
        } catch (e) {
          console.error(`[Scraper] Photo download failed:`, e.message);
        }
      }
      if (product.photos.length === 0) {
        const generic = pickPhotoForProduct({
          title: product.title,
          description: product.description,
          category: product.category,
        });
        if (generic) {
          product.photos = [generic];
          console.log(`[Scraper] Using generic photo: ${generic}`);
        }
      }

      // Auto-assign known npub
      const knownNpub = KNOWN_NPUBS[product.seller_telegram];
      if (knownNpub) {
        product.seller_npub = knownNpub;
        console.log(`[Scraper] Auto-assigned npub for ${product.seller_telegram}`);
      }

      // Post to backend
      try {
        const result = await postProduct(product);
        console.log(`[Scraper] Product created: ID ${result.id} - "${product.title}"`);
        // Track for follow-up photo linking
        if (fromId) {
          recentProducts.set(fromId, { productId: result.id, timestamp: Date.now() });
        }
        // Probe copyability ONCE — if the sender has forwarding disabled, the
        // deletion checker can never distinguish "deleted" from "unforwardable",
        // so mark this product as uncheckable permanently.
        try {
          const probe = await probeMessage(product.telegram_chat_id, product.telegram_message_id);
          if (probe !== 'exists') {
            console.log(`[Scraper] Product ${result.id} msg ${product.telegram_message_id} not copyable (${probe}) — marking can_check_deletion=0`);
            db.prepare('UPDATE products SET can_check_deletion = 0 WHERE id = ?').run(result.id);
          }
        } catch (e) {
          console.error(`[Scraper] Probe failed for product ${result.id}:`, e.message);
        }
      } catch (e) {
        console.error(`[Scraper] Failed to post product:`, e.message);
      }

      offset = update.update_id + 1;
    }

    saveOffset(offset);
  } catch (e) {
    console.error(`[Scraper] Poll error:`, e.message);
  }
}

// --- Deletion checker: detect messages deleted from Telegram ---
const CHECK_DELETED_INTERVAL = 24 * 60 * 60_000; // 24 hours
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '628227864'; // Kilombino DM — silent copy target
// DB opened read-write: we need to mark can_check_deletion for newly-scraped products
const db = require('better-sqlite3')(path.join(__dirname, 'merkasats.db'));

// Telegram Bot API cannot distinguish a deleted message from one whose sender
// has forwarding/copying disabled — both return "message to copy not found".
// So: test copyability ONCE right after scraping. If it fails then, the user
// has forwarding disabled permanently → mark can_check_deletion=0 so the
// deletion checker skips it forever (we accept we can't auto-delete that one).
// Result: 'exists' | 'missing' | 'uncopyable' (private/protected content — exists but can't copy)
async function probeMessage(chatId, messageId) {
  try {
    const result = await tgApi('copyMessage', {
      chat_id: ADMIN_CHAT_ID,
      from_chat_id: chatId,
      message_id: Number(messageId),
      disable_notification: true
    });
    if (result && result.message_id) {
      await tgApi('deleteMessage', {
        chat_id: ADMIN_CHAT_ID,
        message_id: result.message_id
      }).catch(() => {});
    }
    return 'exists';
  } catch (e) {
    const msg = e.message || '';
    if (msg.includes('message to copy not found') || msg.includes('message not found')) {
      return 'missing';
    }
    if (msg.includes("can't be copied")) {
      return 'uncopyable';
    }
    console.error(`[Checker] Probe error for msg ${messageId}:`, msg);
    return 'uncopyable'; // fail-safe: treat unknown errors as uncopyable (don't delete)
  }
}

// Notify Kilombino when a product is auto-deleted — so false positives
// surface quickly and can be restored.
async function notifyDeletion(product, reason) {
  try {
    await tgApi('sendMessage', {
      chat_id: ADMIN_CHAT_ID,
      text: `🗑️ Auto-borrado: producto #${product.id} "${product.title}"\n` +
            `Msg ID: ${product.telegram_message_id}\n` +
            `Motivo: ${reason}\n\n` +
            `Si es un falso positivo, avísame y lo restauramos.`,
      disable_notification: true
    });
  } catch (e) {
    console.error('[Checker] Failed to notify deletion:', e.message);
  }
}

function deleteProduct(productId) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${API_BASE}/api/internal/product/${productId}`);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Consecutive-miss counter: require 2 consecutive "missing" results before deleting,
// to guard against transient network issues.
const missCounts = new Map(); // productId -> consecutive miss count
const REQUIRED_MISSES = 2;

async function checkDeleted() {
  console.log('[Checker] Checking for deleted Telegram messages...');
  // Only check products that (a) came from telegram scraper, (b) still active,
  // (c) are known to be copyable (can_check_deletion=1 — set at scrape time).
  const products = db.prepare(
    "SELECT id, title, telegram_message_id, telegram_chat_id FROM products " +
    "WHERE active = 1 AND source = 'telegram' AND telegram_message_id IS NOT NULL " +
    "AND telegram_message_id != '' AND telegram_chat_id IS NOT NULL " +
    "AND can_check_deletion = 1"
  ).all();

  let deleted = 0;
  for (const p of products) {
    const result = await probeMessage(p.telegram_chat_id, p.telegram_message_id);
    if (result === 'missing') {
      const count = (missCounts.get(p.id) || 0) + 1;
      missCounts.set(p.id, count);
      console.log(`[Checker] Msg ${p.telegram_message_id} (product ${p.id}) missing — consecutive misses: ${count}/${REQUIRED_MISSES}`);
      if (count >= REQUIRED_MISSES) {
        console.log(`[Checker] Threshold reached — deleting product ${p.id} "${p.title}"`);
        try {
          await deleteProduct(p.id);
          await notifyDeletion(p, `mensaje de Telegram no accesible en ${REQUIRED_MISSES} chequeos consecutivos`);
          missCounts.delete(p.id);
          deleted++;
        } catch (e) {
          console.error(`[Checker] Failed to delete product ${p.id}:`, e.message);
        }
      }
    } else if (result === 'uncopyable') {
      // Unexpected — product was marked checkable but now isn't. Flip the flag.
      console.log(`[Checker] Product ${p.id} msg ${p.telegram_message_id} became uncopyable — marking can_check_deletion=0`);
      db.prepare('UPDATE products SET can_check_deletion = 0 WHERE id = ?').run(p.id);
      missCounts.delete(p.id);
    } else {
      // exists — reset miss counter
      missCounts.delete(p.id);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`[Checker] Done. Checked ${products.length} products, removed ${deleted}.`);
}

// Run
console.log('[Scraper] MercaSats Telegram Scraper started');
console.log(`[Scraper] Watching chat ${TARGET_CHAT_ID}, thread ${TARGET_THREAD_ID}`);
console.log(`[Scraper] Backend: ${API_BASE}`);

// Initial poll
poll();

// Repeat polls for new messages
setInterval(poll, POLL_INTERVAL);

// Deletion checker: copies the message to ADMIN_CHAT_ID (Kilombino DM) to test
// existence, then deletes the copy. Silent with disable_notification.
setTimeout(checkDeleted, 60_000);
setInterval(checkDeleted, CHECK_DELETED_INTERVAL);
