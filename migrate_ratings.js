#!/usr/bin/env node
// One-time migration: allow rated_telegram in ratings table
const db = require('better-sqlite3')('merkasats.db');

const existing = db.prepare("SELECT sql FROM sqlite_master WHERE name='ratings'").get();
console.log('Current schema:\n' + existing.sql);

if (existing.sql.includes('rated_telegram')) {
  console.log('Already migrated. Nothing to do.');
  process.exit(0);
}

db.exec('BEGIN');
try {
  db.exec(`
    CREATE TABLE ratings_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rater_npub TEXT NOT NULL,
      rated_npub TEXT,
      rated_telegram TEXT,
      stars INTEGER NOT NULL CHECK(stars >= 1 AND stars <= 5),
      comment TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      CHECK (rated_npub IS NOT NULL OR rated_telegram IS NOT NULL)
    );
    INSERT INTO ratings_new (id, rater_npub, rated_npub, stars, comment, created_at)
      SELECT id, rater_npub, rated_npub, stars, comment, created_at FROM ratings;
    DROP TABLE ratings;
    ALTER TABLE ratings_new RENAME TO ratings;
    CREATE INDEX idx_ratings_rated ON ratings(rated_npub) WHERE rated_npub IS NOT NULL;
    CREATE INDEX idx_ratings_rated_tg ON ratings(rated_telegram) WHERE rated_telegram IS NOT NULL;
    CREATE UNIQUE INDEX idx_ratings_unique_npub ON ratings(rater_npub, rated_npub)
      WHERE rated_npub IS NOT NULL;
    CREATE UNIQUE INDEX idx_ratings_unique_tg ON ratings(rater_npub, rated_telegram)
      WHERE rated_telegram IS NOT NULL;
  `);
  db.exec('COMMIT');
  console.log('\nMigration successful.');
  const after = db.prepare("SELECT sql FROM sqlite_master WHERE name='ratings'").get();
  console.log('New schema:\n' + after.sql);
  const n = db.prepare('SELECT COUNT(*) as n FROM ratings').get().n;
  console.log(`Rows preserved: ${n}`);
} catch (e) {
  db.exec('ROLLBACK');
  console.error('Migration failed:', e.message);
  process.exit(1);
}
