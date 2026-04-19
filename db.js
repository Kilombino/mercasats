const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'merkasats.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    price TEXT,
    price_currency TEXT DEFAULT 'sats',
    region TEXT,
    photos TEXT,  -- JSON array of photo URLs/paths
    seller_telegram TEXT,
    seller_npub TEXT,
    source TEXT DEFAULT 'telegram',  -- 'telegram' or 'manual'
    telegram_message_id TEXT,
    telegram_chat_id TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rater_npub TEXT NOT NULL,
    rated_npub TEXT NOT NULL,
    stars INTEGER NOT NULL CHECK(stars >= 1 AND stars <= 5),
    comment TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(rater_npub, rated_npub)
  );

  CREATE TABLE IF NOT EXISTS npub_profiles (
    npub TEXT PRIMARY KEY,
    telegram_username TEXT,
    display_name TEXT,
    picture TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);
  CREATE INDEX IF NOT EXISTS idx_products_region ON products(region);
  CREATE INDEX IF NOT EXISTS idx_ratings_rated ON ratings(rated_npub);

`);

// Add columns if they don't exist (safe migration)
const columns = db.prepare("PRAGMA table_info(products)").all().map(c => c.name);
if (!columns.includes('nostr_event_id')) db.exec(`ALTER TABLE products ADD COLUMN nostr_event_id TEXT`);
if (!columns.includes('sold')) db.exec(`ALTER TABLE products ADD COLUMN sold INTEGER DEFAULT 0`);
if (!columns.includes('buyer_npub')) db.exec(`ALTER TABLE products ADD COLUMN buyer_npub TEXT`);
if (!columns.includes('sold_at')) db.exec(`ALTER TABLE products ADD COLUMN sold_at TEXT`);
if (!columns.includes('category')) db.exec(`ALTER TABLE products ADD COLUMN category TEXT`);
if (!columns.includes('reserved')) db.exec(`ALTER TABLE products ADD COLUMN reserved INTEGER DEFAULT 0`);
if (!columns.includes('reserved_by')) db.exec(`ALTER TABLE products ADD COLUMN reserved_by TEXT`);
if (!columns.includes('reserved_at')) db.exec(`ALTER TABLE products ADD COLUMN reserved_at TEXT`);
if (!columns.includes('expires_at')) db.exec(`ALTER TABLE products ADD COLUMN expires_at INTEGER`);

module.exports = db;
