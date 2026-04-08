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
        resolve(`/photos/${localName}`);
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

// Generic photos by keyword — external URLs to avoid filling local disk
const GENERIC_PHOTOS = [
  { keywords: ['solar', 'panel', 'fotovolt', 'energía', 'energia'], photo: 'https://images.unsplash.com/photo-1509391366360-2e959784a276?w=800&q=80' },
  { keywords: ['colch', 'cama', 'alojamiento', 'dormir', 'habitaci', 'hotel', 'hostal'], photo: 'https://images.unsplash.com/photo-1631049307264-da0ec9d70304?w=800&q=80' },
  { keywords: ['piso', 'alquiler', 'lloguer', 'apartament', 'casa', 'vivienda'], photo: 'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=800&q=80' },
  { keywords: ['esquí', 'esqui', 'ski', 'neu', 'nieve', 'montaña'], photo: 'https://images.unsplash.com/photo-1551524559-8af4e6624178?w=800&q=80' },
  { keywords: ['gestor', 'impuesto', 'fiscal', 'comptab', 'contab', 'factura'], photo: 'https://images.unsplash.com/photo-1554224155-6726b3ff858f?w=800&q=80' },
  { keywords: ['jardí', 'jardin', 'planta', 'hort', 'huerto'], photo: 'https://images.unsplash.com/photo-1416879595882-3373a0480b5b?w=800&q=80' },
  { keywords: ['camiset', 'ropa', 'roba', 'chandal', 'vestir'], photo: 'https://images.unsplash.com/photo-1523381210434-271e8be1f52b?w=800&q=80' },
  { keywords: ['ordenador', 'pc', 'portátil', 'laptop', 'informàtic', 'tech'], photo: 'https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=800&q=80' },
  { keywords: ['coche', 'cotxe', 'moto', 'vehicle', 'carro'], photo: 'https://images.unsplash.com/photo-1549317661-bd32c8ce0afa?w=800&q=80' },
  { keywords: ['comida', 'menjar', 'carne', 'aceite', 'miel', 'aliment'], photo: 'https://images.unsplash.com/photo-1506784983877-45594efa4cbe?w=800&q=80' },
  { keywords: ['moneda', 'plata', 'oro', 'divisa', 'corona'], photo: 'https://images.unsplash.com/photo-1610375228550-d5cabc1aee48?w=800&q=80' },
  { keywords: ['masaje', 'osteopat', 'salud', 'terapi', 'salut'], photo: 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800&q=80' },
  { keywords: ['joc', 'juego', 'gaming', 'consol'], photo: 'https://images.unsplash.com/photo-1493711662062-fa541adb3fc8?w=800&q=80' },
];

function findGenericPhoto(text) {
  const lower = text.toLowerCase();
  for (const entry of GENERIC_PHOTOS) {
    if (entry.keywords.some(kw => lower.includes(kw))) {
      return entry.photo;
    }
  }
  return null;
}

// Parse a message into a product listing
function parseMessage(msg) {
  const text = msg.text || msg.caption || '';
  if (!text || text.length < 10) return null; // Too short to be a listing

  const from = msg.from || {};
  const username = from.username ? `@${from.username}` : from.first_name || 'Anónimo';

  // Try to extract price (look for numbers followed by sats/btc/€/eur)
  let price = 'A convenir';
  let priceCurrency = 'sats';
  const priceMatch = text.match(/(\d[\d.,]*)\s*(sats?|btc|€|eur|euros?)/i);
  if (priceMatch) {
    const rawPrice = priceMatch[1];
    const unit = priceMatch[2].toLowerCase();
    if (unit.startsWith('btc')) priceCurrency = 'btc';
    else if (unit === '€' || unit.startsWith('eur')) priceCurrency = 'eur';
    else priceCurrency = 'sats';

    if (priceCurrency === 'sats') {
      // Sats are always integers — remove thousand separators (. or ,)
      price = rawPrice.replace(/[.,]/g, '');
    } else {
      // For EUR/BTC, convert comma decimal to dot
      price = rawPrice.replace(',', '.');
    }
  }

  // First line or first sentence as title (max 60 chars)
  const firstLine = text.split('\n')[0].trim();
  const title = firstLine.length > 60 ? firstLine.substring(0, 57) + '...' : firstLine;

  // Auto-detect category by keywords
  const category = detectCategory(text);

  return {
    title,
    description: text,
    price,
    price_currency: priceCurrency,
    region: null,
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
};

// Auto-detect product category from text
const CATEGORY_RULES = [
  { id: 'informatica', keywords: ['pc', 'ordenador', 'portátil', 'laptop', 'monitor', 'teclado', 'ratón', 'impresora', 'usb', 'ssd', 'ram', 'gpu', 'cpu', 'raspberry', 'arduino'] },
  { id: 'bitcoin', keywords: ['wallet', 'hardware wallet', 'seedsigner', 'coldcard', 'trezor', 'ledger', 'krux', 'node', 'miner', 'asic', 'bitaxe', 'nerdminer'] },
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
  console.log(`[Scraper] Starting poll, offset: ${offset}`);

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

      // Check if this is a photo-only follow-up to a recent product
      const hasPhoto = msg.photo && msg.photo.length > 0;
      const text = msg.text || msg.caption || '';
      if (hasPhoto && text.length < 10 && fromId && recentProducts.has(fromId)) {
        const recent = recentProducts.get(fromId);
        if (Date.now() - recent.timestamp < PHOTO_LINK_WINDOW) {
          try {
            const largest = msg.photo[msg.photo.length - 1];
            const localPath = await downloadPhoto(largest.file_id);
            await addPhotoToProduct(recent.productId, localPath);
            console.log(`[Scraper] Linked follow-up photo to product ${recent.productId}: ${localPath}`);
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
        const generic = findGenericPhoto(product.description);
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
const CHECK_DELETED_INTERVAL = 10 * 60_000; // 10 minutes
const db = require('better-sqlite3')(path.join(__dirname, 'merkasats.db'), { readonly: true });

async function checkMessageExists(chatId, messageId) {
  // Try to copy the message to the bot's own context; if it fails, message was deleted
  try {
    // Use forwardMessage to a temporary destination (same chat) and immediately delete
    // Actually, use copyMessage which is lighter
    const result = await tgApi('copyMessage', {
      chat_id: chatId,
      from_chat_id: chatId,
      message_id: Number(messageId),
      disable_notification: true
    });
    // Message exists — delete the copy
    if (result && result.message_id) {
      await tgApi('deleteMessage', {
        chat_id: chatId,
        message_id: result.message_id
      }).catch(() => {}); // ignore if delete fails
    }
    return true;
  } catch (e) {
    if (e.message && (e.message.includes('message to copy not found') ||
        e.message.includes('message not found'))) {
      return false;
    }
    // "can't be copied" means message EXISTS but has restrictions — not deleted
    if (e.message && e.message.includes("message can't be copied")) {
      return true;
    }
    // Other error (rate limit, network) — assume message still exists
    console.error(`[Checker] Error checking msg ${messageId}:`, e.message);
    return true;
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

async function checkDeleted() {
  console.log('[Checker] Checking for deleted Telegram messages...');
  // Re-read DB each time (readonly connection)
  // Only check products that came from the telegram scraper (source='telegram')
  // Products published via web have bot announcement IDs which are different
  const products = db.prepare(
    "SELECT id, title, telegram_message_id, telegram_chat_id FROM products WHERE active = 1 AND source = 'telegram' AND telegram_message_id IS NOT NULL AND telegram_message_id != '' AND telegram_chat_id IS NOT NULL"
  ).all();

  let deleted = 0;
  for (const p of products) {
    const exists = await checkMessageExists(p.telegram_chat_id, p.telegram_message_id);
    if (!exists) {
      console.log(`[Checker] Message ${p.telegram_message_id} deleted — removing product ${p.id} "${p.title}"`);
      try {
        await deleteProduct(p.id);
        deleted++;
      } catch (e) {
        console.error(`[Checker] Failed to delete product ${p.id}:`, e.message);
      }
    }
    // Rate limit: small delay between checks
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

// Deletion checker disabled — copyMessage+deleteMessage causes visible spam in the group.
// To remove products when TG messages are deleted, use /borrar command or manual removal.
// setTimeout(checkDeleted, 60_000);
// setInterval(checkDeleted, CHECK_DELETED_INTERVAL);
