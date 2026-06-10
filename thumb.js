// WebP thumbnail generation for product photos.
//
// Cards on the home page only need a small image (~400px wide) but the
// originals are often 1–6 MB JPEGs straight from a phone camera. This module
// produces a 400×400 cover-cropped WebP in /photos/thumbs/ that the frontend
// loads instead of the original. The product detail view still uses the full
// resolution image.
//
// External URLs (Unsplash, etc.) are skipped — they're already optimized.

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const PHOTOS_DIR = path.join(__dirname, 'photos');
const THUMBS_DIR = path.join(PHOTOS_DIR, 'thumbs');
const THUMB_SIZE = 400;

if (!fs.existsSync(THUMBS_DIR)) fs.mkdirSync(THUMBS_DIR, { recursive: true });

// Returns the public URL of the thumb for a given photo URL/path, or null if
// the photo isn't a local /photos/ file we can thumbnail.
function thumbUrlFor(photoUrl) {
  if (!photoUrl || typeof photoUrl !== 'string') return null;
  if (!photoUrl.startsWith('/photos/')) return null;
  if (photoUrl.startsWith('/photos/thumbs/')) return photoUrl;
  const base = path.basename(photoUrl, path.extname(photoUrl));
  return `/photos/thumbs/${base}.webp`;
}

// Generate a thumb for a single photo. Idempotent: skips if up-to-date.
async function generateThumb(localPath) {
  if (!localPath || !localPath.startsWith('/photos/')) return null;
  if (localPath.startsWith('/photos/thumbs/')) return localPath;

  const srcAbs = path.join(__dirname, localPath);
  if (!fs.existsSync(srcAbs)) return null;

  const base = path.basename(localPath, path.extname(localPath));
  const dstAbs = path.join(THUMBS_DIR, `${base}.webp`);
  const dstUrl = `/photos/thumbs/${base}.webp`;

  // Skip if existing thumb is newer than the source.
  try {
    const srcStat = fs.statSync(srcAbs);
    const dstStat = fs.statSync(dstAbs);
    if (dstStat.mtimeMs >= srcStat.mtimeMs) return dstUrl;
  } catch { /* dst doesn't exist yet */ }

  try {
    await sharp(srcAbs)
      .rotate() // honor EXIF orientation before resizing
      .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover', position: 'attention' })
      .webp({ quality: 78 })
      .toFile(dstAbs);
    return dstUrl;
  } catch (e) {
    console.error(`[thumb] Failed for ${localPath}:`, e.message);
    return null;
  }
}

// Fire-and-forget version for hot paths (scraper download, upload endpoint).
// We don't want the HTTP response or scrape loop to wait on image processing.
function generateThumbAsync(localPath) {
  generateThumb(localPath).catch(() => {});
}

module.exports = { generateThumb, generateThumbAsync, thumbUrlFor };
