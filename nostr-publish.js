/**
 * Nostr publishing and zap monitoring for Mercasats
 *
 * - Publishes product listings as Nostr events (kind 30402)
 * - Monitors zap receipts (kind 9735) for payments
 * - Notifies sellers when their product is zapped/sold
 */

const { finalizeEvent, getPublicKey } = require('nostr-tools/pure');
const WebSocket = require('ws');

const RELAYS = [
  'wss://relay.primal.net',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band'
];

const WEB_URL = 'https://mercasats.kilombino.com';

// Marketplace Nostr identity — set via NOSTR_NSEC_HEX environment variable
if (!process.env.NOSTR_NSEC_HEX) {
  console.error('[Nostr] WARNING: NOSTR_NSEC_HEX not set, Nostr publishing disabled');
}
const sk = process.env.NOSTR_NSEC_HEX
  ? Uint8Array.from(Buffer.from(process.env.NOSTR_NSEC_HEX, 'hex'))
  : null;
const pk = sk ? getPublicKey(sk) : null;

if (pk) console.log('[Nostr] Marketplace pubkey:', pk);

// Publish event to relays
function publishToRelays(event) {
  const msg = JSON.stringify(['EVENT', event]);
  const results = [];

  for (const url of RELAYS) {
    results.push(new Promise((resolve) => {
      try {
        const ws = new WebSocket(url);
        const timer = setTimeout(() => { ws.close(); resolve({ relay: url, ok: false, err: 'timeout' }); }, 10000);

        ws.on('open', () => ws.send(msg));
        ws.on('message', (data) => {
          const resp = JSON.parse(data.toString());
          if (resp[0] === 'OK') {
            clearTimeout(timer);
            ws.close();
            resolve({ relay: url, ok: resp[2], err: resp[3] || null });
          }
        });
        ws.on('error', (e) => { clearTimeout(timer); resolve({ relay: url, ok: false, err: e.message }); });
      } catch (e) {
        resolve({ relay: url, ok: false, err: e.message });
      }
    }));
  }

  return Promise.all(results);
}

/**
 * Publish a product listing to Nostr as kind 30402 (classified listing)
 * If a valid signed_event from the client is provided, publish that directly.
 * Otherwise, fall back to signing with the marketplace key.
 */
async function publishProduct(product, signedEvent) {
  const { id, title, description, price, price_currency, seller_npub, seller_telegram, photos, category, region } = product;

  // If we have a properly signed event from the client, publish it directly
  if (signedEvent && signedEvent.sig && signedEvent.id && signedEvent.pubkey &&
      signedEvent.sig !== '00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000') {

    // Publish the event exactly as the client signed it — do NOT recompute the ID
    // The signature is valid for this exact event (id + content + tags)
    console.log(`[Nostr] Publishing client-signed event for product ${id} (pubkey: ${signedEvent.pubkey.substring(0, 12)}..., id: ${signedEvent.id.substring(0, 16)}...)`);

    // Ensure the event has the exact structure relays expect
    const cleanEvent = {
      id: signedEvent.id,
      pubkey: signedEvent.pubkey,
      created_at: signedEvent.created_at,
      kind: signedEvent.kind,
      tags: signedEvent.tags || [],
      content: signedEvent.content || '',
      sig: signedEvent.sig
    };

    const results = await publishToRelays(cleanEvent);
    const successes = results.filter(r => r.ok);
    const failures = results.filter(r => !r.ok);
    console.log(`[Nostr] Published client event to ${successes.length}/${results.length} relays (event: ${signedEvent.id})`);
    if (failures.length > 0) {
      console.log(`[Nostr] Relay errors:`, failures.map(f => `${f.relay}: ${f.err}`).join(', '));
    }
    return signedEvent.id;
  }

  // Fallback: sign with marketplace key
  const currUpper = (price_currency || 'sats').toUpperCase();
  const currSymbol = currUpper === 'EUR' ? '€' : currUpper === 'BTC' ? 'BTC' : 'sats';
  const content = `${title}\n\n${description || ''}\n\n💰 ${price} ${currSymbol}\n👤 ${seller_telegram || ''}\n🔗 ${WEB_URL}`;

  const tags = [
    ['d', `mercasats-${id}`],
    ['title', title],
    ['summary', (description || '').substring(0, 200)],
    ['published_at', String(Math.floor(Date.now() / 1000))],
    ['location', region || 'Catalunya'],
    ['price', String(price), currUpper === 'EUR' ? 'EUR' : currUpper === 'BTC' ? 'BTC' : 'SAT'],
    ['t', 'mercasats'],
    ['t', 'p2p'],
    ['t', 'bitcoin'],
    ['r', `${WEB_URL}`],
  ];

  if (category) tags.push(['t', category]);
  if (seller_npub) tags.push(['p', seller_npub, '', 'seller']);

  if (photos && photos.length > 0) {
    for (const photo of photos) {
      const photoUrl = photo.startsWith('http') ? photo : `${WEB_URL}${photo}`;
      tags.push(['image', photoUrl]);
    }
  }

  const event = finalizeEvent({
    kind: 30402,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content,
  }, sk);

  const results = await publishToRelays(event);
  const successes = results.filter(r => r.ok);
  console.log(`[Nostr] Published product ${id} (marketplace key) to ${successes.length}/${results.length} relays (event: ${event.id})`);

  return event.id;
}

/**
 * Start monitoring zap receipts for marketplace listings
 */
let onSaleCallback = null;

function startZapMonitor(db, saleCallback) {
  onSaleCallback = saleCallback || null;
  console.log('[Nostr] Starting zap monitor...');

  function connect(relayUrl) {
    let ws;
    try {
      ws = new WebSocket(relayUrl);
    } catch (e) {
      console.error(`[Nostr] Failed to create WS to ${relayUrl}:`, e.message);
      setTimeout(() => connect(relayUrl), 30000);
      return;
    }

    ws.on('open', () => {
      console.log(`[Nostr] Zap monitor connected to ${relayUrl}`);
      // Subscribe to zap receipts tagging our marketplace pubkey
      ws.send(JSON.stringify([
        'REQ', 'zap-monitor',
        { kinds: [9735], '#p': [pk], since: Math.floor(Date.now() / 1000) - 60 }
      ]));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg[0] === 'EVENT' && msg[2]?.kind === 9735) {
          handleZapReceipt(msg[2], db);
        }
      } catch (e) {
        // ignore parse errors
      }
    });

    ws.on('close', () => {
      console.log(`[Nostr] Zap monitor disconnected from ${relayUrl}, reconnecting...`);
      setTimeout(() => connect(relayUrl), 15000);
    });

    ws.on('error', (e) => {
      console.error(`[Nostr] Zap monitor error on ${relayUrl}:`, e.message);
    });
  }

  // Connect to multiple relays for redundancy
  for (const relay of RELAYS.slice(0, 2)) {
    connect(relay);
  }
}

/**
 * Handle incoming zap receipt
 */
function handleZapReceipt(event, db) {
  try {
    // Extract the zapped event ID from 'e' tag
    const eTag = event.tags.find(t => t[0] === 'e');
    if (!eTag) return;
    const zappedEventId = eTag[1];

    // Find the product by nostr_event_id
    const product = db.prepare('SELECT * FROM products WHERE nostr_event_id = ? AND active = 1 AND sold = 0').get(zappedEventId);
    if (!product) return;

    // Extract zap amount from bolt11 in the description tag
    const descTag = event.tags.find(t => t[0] === 'description');
    if (!descTag) return;

    let zapRequest;
    try { zapRequest = JSON.parse(descTag[1]); } catch { return; }

    const bolt11Tag = event.tags.find(t => t[0] === 'bolt11');
    if (!bolt11Tag) return;

    // Decode bolt11 to get amount
    const amountMsat = decodeBolt11Amount(bolt11Tag[1]);
    if (!amountMsat) return;

    const amountSats = Math.floor(amountMsat / 1000);

    // Check if amount matches price
    const productPrice = parseInt(product.price);
    if (isNaN(productPrice)) return; // Skip non-numeric prices like "Consultar"

    if (product.price_currency === 'sats' && amountSats >= productPrice) {
      // SOLD!
      const buyerPubkey = zapRequest.pubkey || null;
      db.prepare('UPDATE products SET sold = 1, buyer_npub = ?, sold_at = datetime(\'now\') WHERE id = ?')
        .run(buyerPubkey, product.id);

      console.log(`[Nostr] Product ${product.id} "${product.title}" SOLD for ${amountSats} sats to ${buyerPubkey || 'unknown'}`);

      // Notify seller via Nostr
      if (product.seller_npub) {
        notifySeller(product, amountSats, buyerPubkey);
      }

      // Notify sale via callback (Telegram, etc.)
      if (onSaleCallback) {
        onSaleCallback(product, amountSats, buyerPubkey);
      }
    }
  } catch (e) {
    console.error('[Nostr] Error handling zap receipt:', e.message);
  }
}

/**
 * Simple bolt11 amount extraction
 */
function decodeBolt11Amount(bolt11) {
  try {
    // Amount is encoded after 'lnbc' prefix
    const lower = bolt11.toLowerCase();
    let amountStr = '';
    let multiplier = 1;

    // Find amount section: lnbc<amount><multiplier>1...
    const match = lower.match(/^lnbc(\d+)([munp]?)1/);
    if (!match) return null;

    amountStr = match[1];
    const mult = match[2];

    // Multipliers relative to BTC, convert to msats
    const multipliers = {
      '': 100000000000, // BTC to msat
      'm': 100000000,   // milli-BTC to msat
      'u': 100000,      // micro-BTC to msat
      'n': 100,         // nano-BTC to msat
      'p': 0.1,         // pico-BTC to msat
    };

    return Math.floor(parseInt(amountStr) * (multipliers[mult] || 1));
  } catch {
    return null;
  }
}

/**
 * Send a Nostr DM (kind 4) to the seller notifying the sale
 */
async function notifySeller(product, amountSats, buyerPubkey) {
  try {
    const buyerStr = buyerPubkey ? buyerPubkey.substring(0, 12) + '...' : 'un comprador';
    const content = `🛒 Tu producto "${product.title}" ha sido comprado!\n\n💰 ${amountSats} sats recibidos\n👤 Comprador: ${buyerStr}\n\nContacta con el comprador para coordinar la entrega.`;

    // Publish as kind 1 mention instead of DM (DMs require NIP-44 encryption)
    const event = finalizeEvent({
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['p', product.seller_npub],
        ['t', 'mercasats'],
        ['e', product.nostr_event_id],
      ],
      content,
    }, sk);

    await publishToRelays(event);
    console.log(`[Nostr] Seller ${product.seller_npub.substring(0, 12)}... notified about sale`);
  } catch (e) {
    console.error('[Nostr] Failed to notify seller:', e.message);
  }
}

/**
 * Delete a Nostr event by publishing a kind 5 (NIP-09 deletion)
 */
async function deleteFromNostr(eventId, productId) {
  const event = finalizeEvent({
    kind: 5,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['e', eventId],
      ['a', `30402:${pk}:mercasats-${productId}`],
    ],
    content: 'Product deleted from Mercasats',
  }, sk);

  const results = await publishToRelays(event);
  const successes = results.filter(r => r.ok);
  console.log(`[Nostr] Deletion event published to ${successes.length}/${results.length} relays`);
  return event.id;
}

module.exports = { publishProduct, startZapMonitor, deleteFromNostr, pk, RELAYS };
