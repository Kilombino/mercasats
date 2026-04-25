// Generic photo fallbacks for ads that don't include their own image.
// Used by both the Telegram scraper (telegram-scraper.js) and the
// manual /api/products and /api/internal/product endpoints in server.js.

// Keyword-based matches on title+description. First match wins.
const KEYWORD_PHOTOS = [
  { keywords: ['solar', 'panel', 'fotovolt', 'energía', 'energia'], photo: 'https://images.unsplash.com/photo-1509391366360-2e959784a276?w=800&q=80' },
  { keywords: ['colch', 'cama', 'alojamiento', 'dormir', 'habitaci', 'hotel', 'hostal'], photo: 'https://images.unsplash.com/photo-1631049307264-da0ec9d70304?w=800&q=80' },
  { keywords: ['piso', 'alquiler', 'lloguer', 'apartament', 'casa', 'vivienda'], photo: 'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=800&q=80' },
  { keywords: ['esquí', 'esqui', 'ski', 'neu', 'nieve', 'montaña'], photo: 'https://images.unsplash.com/photo-1551524559-8af4e6624178?w=800&q=80' },
  { keywords: ['gestor', 'impuesto', 'fiscal', 'comptab', 'contab', 'factura'], photo: 'https://images.unsplash.com/photo-1554224155-6726b3ff858f?w=800&q=80' },
  { keywords: ['jardí', 'jardin', 'planta', 'hort', 'huerto'], photo: 'https://images.unsplash.com/photo-1416879595882-3373a0480b5b?w=800&q=80' },
  { keywords: ['camiset', 'ropa', 'roba', 'chandal', 'vestir'], photo: 'https://images.unsplash.com/photo-1523381210434-271e8be1f52b?w=800&q=80' },
  { keywords: ['ordenador', 'pc', 'portátil', 'laptop', 'informàtic', 'tech'], photo: 'https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=800&q=80' },
  { keywords: ['coche', 'cotxe', 'moto', 'vehicle', 'carro', 'viaje', 'trayecto', 'viatge'], photo: 'https://images.unsplash.com/photo-1549317661-bd32c8ce0afa?w=800&q=80' },
  { keywords: ['comida', 'menjar', 'carne', 'aceite', 'miel', 'aliment'], photo: 'https://images.unsplash.com/photo-1506784983877-45594efa4cbe?w=800&q=80' },
  { keywords: ['moneda', 'plata', 'oro', 'divisa', 'corona'], photo: 'https://images.unsplash.com/photo-1610375228550-d5cabc1aee48?w=800&q=80' },
  { keywords: ['masaje', 'osteopat', 'salud', 'terapi', 'salut'], photo: 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800&q=80' },
  { keywords: ['joc', 'juego', 'gaming', 'consol'], photo: 'https://images.unsplash.com/photo-1493711662062-fa541adb3fc8?w=800&q=80' },
];

// Per-category fallback when no keyword matches. Reuses the same Unsplash URLs.
const CATEGORY_PHOTOS = {
  informatica: 'https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=800&q=80',
  energia: 'https://images.unsplash.com/photo-1509391366360-2e959784a276?w=800&q=80',
  alimentacio: 'https://images.unsplash.com/photo-1506784983877-45594efa4cbe?w=800&q=80',
  roba: 'https://images.unsplash.com/photo-1523381210434-271e8be1f52b?w=800&q=80',
  gaming: 'https://images.unsplash.com/photo-1493711662062-fa541adb3fc8?w=800&q=80',
  finances: 'https://images.unsplash.com/photo-1610375228550-d5cabc1aee48?w=800&q=80',
  vehicle: 'https://images.unsplash.com/photo-1549317661-bd32c8ce0afa?w=800&q=80',
  esport: 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=800&q=80',
  llar: 'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=800&q=80',
};

function findGenericPhoto(text) {
  const lower = (text || '').toLowerCase();
  for (const entry of KEYWORD_PHOTOS) {
    if (entry.keywords.some(kw => lower.includes(kw))) {
      return entry.photo;
    }
  }
  return null;
}

function pickPhotoForProduct({ title, description, category }) {
  const text = `${title || ''} ${description || ''}`;
  return findGenericPhoto(text) || (category && CATEGORY_PHOTOS[category]) || null;
}

module.exports = { KEYWORD_PHOTOS, CATEGORY_PHOTOS, findGenericPhoto, pickPhotoForProduct };
