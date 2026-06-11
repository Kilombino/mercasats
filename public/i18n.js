// i18n.js — Translates static UI from Catalan (source) to ES / EN.
//
// Strategy:
//  - Dictionary keyed by exact Catalan source string (trimmed).
//  - TreeWalker visits text nodes + translatable attributes on initial pass.
//  - MutationObserver re-translates dynamic insertions / textContent changes.
//  - Patterns handle interpolated strings (e.g. "4.5/5 (12 valoracions)").
//  - alert/confirm monkey-patched so JS-side messages translate too.
//  - Category names exposed via window.tCat() for use inside render functions.
//
// Regions are NOT translated (per Kilombino, 2026-05-11). User-generated
// content (product titles, descriptions, ratings) is not in the dict so it
// passes through untouched.
(function () {
  'use strict';

  const LANG_KEY = 'mercasats_lang';
  const SUPPORTED = ['ca', 'es', 'en'];
  const LABELS = { ca: 'CAT', es: 'ES', en: 'EN' };

  // ---- Dictionary ----------------------------------------------------------
  // Key = Catalan source string (trimmed). Value = {es, en}.
  const I18N = {
    // --- Added jun 2026: map, meetups, coords, shipping, footer ---
    'Carregant mapa…': { es: 'Cargando mapa…', en: 'Loading map…' },
    'Contactar per Telegram': { es: 'Contactar por Telegram', en: 'Contact via Telegram' },
    'Coordenades (opcional)': { es: 'Coordenadas (opcional)', en: 'Coordinates (optional)' },
    'Copiar direcció onion de Merca-sats (Tor)': { es: 'Copiar dirección onion de Merca-sats (Tor)', en: 'Copy Merca-sats onion address (Tor)' },
    "Copiar npub d'aquest usuari": { es: 'Copiar npub de este usuario', en: "Copy this user's npub" },
    'Copiar npub de Trobades Bitcoiners': { es: 'Copiar npub de Trobades Bitcoiners', en: 'Copy Trobades Bitcoiners npub' },
    'Descarrega Merca-sats des de Zapstore': { es: 'Descarga Merca-sats desde Zapstore', en: 'Download Merca-sats from Zapstore' },
    "Fes clic al mapa per triar el punt. S'enviarà a Telegram i Nostr.": { es: 'Haz clic en el mapa para elegir el punto. Se enviará a Telegram y Nostr.', en: 'Click the map to pick the point. It will be sent to Telegram and Nostr.' },
    'Fes clic al mapa per triar el punt i prem "Fer servir".': { es: 'Haz clic en el mapa para elegir el punto y pulsa "Usar".', en: 'Click the map to pick the point and press "Use".' },
    'Fotos (fins a 5)': { es: 'Fotos (hasta 5)', en: 'Photos (up to 5)' },
    "Meetups Bitcoin d'Espanya": { es: 'Meetups Bitcoin de España', en: 'Bitcoin Meetups of Spain' },
    'O pega una URL de foto...': { es: 'O pega una URL de foto...', en: 'Or paste a photo URL...' },
    'Passa el cursor (o toca al mòbil) per veure cada zona. Fes clic per filtrar els anuncis.': { es: 'Pasa el cursor (o toca en el móvil) para ver cada zona. Haz clic para filtrar los anuncios.', en: 'Hover (or tap on mobile) to see each zone. Click to filter the listings.' },
    "Preu de l'enviament (opcional)": { es: 'Precio del envío (opcional)', en: 'Shipping price (optional)' },
    'Què és Merca-sats': { es: 'Qué es Merca-sats', en: 'What is Merca-sats' },
    "Ready to Meetup — Meetups Bitcoin d'Espanya": { es: 'Ready to Meetup — Meetups Bitcoin de España', en: 'Ready to Meetup — Bitcoin Meetups of Spain' },
    'Sense coordenades': { es: 'Sin coordenadas', en: 'No coordinates' },
    'Veure i filtrar per zones': { es: 'Ver y filtrar por zonas', en: 'View and filter by zones' },
    '📷 Pujar fotos de la galeria': { es: '📷 Subir fotos de la galería', en: '📷 Upload photos from gallery' },
    '🗺️ Filtrar per zona': { es: '🗺️ Filtrar por zona', en: '🗺️ Filter by zone' },
    '🗺️ Mostrar zones': { es: '🗺️ Mostrar zonas', en: '🗺️ Show zones' },
    '🗺️ Tria les coordenades': { es: '🗺️ Elige las coordenadas', en: '🗺️ Pick the coordinates' },
    '🗺️ Zones': { es: '🗺️ Zonas', en: '🗺️ Zones' },
    '🤝 Meetups': { es: '🤝 Meetups', en: '🤝 Meetups' },
    // Shipping field — form labels in Catalan; the Nostr/Telegram output stays Spanish
    'Enviaments': { es: 'Envíos', en: 'Shipping' },
    'No disponibles': { es: 'No disponibles', en: 'Not available' },
    'Inclosos en el preu': { es: 'Incluidos en el precio', en: 'Included in the price' },
    'Només península': { es: 'Solo península', en: 'Mainland only' },
    'Península i illes': { es: 'Península e islas', en: 'Mainland and islands' },
    'Internacional': { es: 'Internacional', en: 'International' },
    // Trust badge (Nostr key reputation)
    'Reputació de la clau Nostr: Alta': { es: 'Reputación de su llave Nostr: Alta', en: 'Nostr key reputation: High' },
    'Reputació de la clau Nostr: Mitjana': { es: 'Reputación de su llave Nostr: Media', en: 'Nostr key reputation: Medium' },
    'Reputació de la clau Nostr: Baixa': { es: 'Reputación de su llave Nostr: Baja', en: 'Nostr key reputation: Low' },
    'Alta': { es: 'Alta', en: 'High' },
    'Mitjana': { es: 'Media', en: 'Medium' },
    'Baixa': { es: 'Baja', en: 'Low' },
    'Reputació de la clau Nostr: sense dades encara': { es: 'Reputación de su llave Nostr: sin datos aún', en: 'Nostr key reputation: no data yet' },
    // Trust breakdown labels
    'Zaps rebuts': { es: 'Zaps recibidos', en: 'Zaps received' },
    'Zaps enviats': { es: 'Zaps enviados', en: 'Zaps sent' },
    'Identitat Nostr': { es: 'Identidad Nostr', en: 'Nostr identity' },
    'Seguiment mutu': { es: 'Seguimiento mutuo', en: 'Mutual follow' },
    'Activitat': { es: 'Actividad', en: 'Activity' },
    'Calculant confiança…': { es: 'Calculando confianza…', en: 'Computing trust…' },
    'Vols publicar també una insígnia de confiança a Nostr, firmada per tu? Quedarà guardada als relays i la podràs retirar esborrant la ressenya.': {
      es: '¿Quieres publicar también una insignia de confianza en Nostr, firmada por ti? Quedará guardada en los relays y podrás retirarla borrando la reseña.',
      en: 'Do you also want to publish a trust badge on Nostr, signed by you? It will be stored on the relays and you can remove it by deleting the review.',
    },
    'Segur que vols esborrar la teva ressenya? Si havies emès una insígnia, també es retirarà de Nostr.': {
      es: '¿Seguro que quieres borrar tu reseña? Si habías emitido una insignia, también se retirará de Nostr.',
      en: 'Are you sure you want to delete your review? If you had issued a badge, it will also be retracted from Nostr.',
    },
    '🗑️ Esborrar la meva ressenya': { es: '🗑️ Borrar mi reseña', en: '🗑️ Delete my review' },
    // Header
    '🟠 Què és Merca-sats?': {
      es: '🟠 ¿Qué es Merca-sats?',
      en: '🟠 What is Merca-sats?',
    },
    "Organitzador d'anuncis de béns i serveis per bitcoin a Catalunya. Connectem compradors i venedors de": {
      es: 'Organizador de anuncios de bienes y servicios por bitcoin en Cataluña. Conectamos compradores y vendedores de',
      en: 'Bulletin board for goods and services priced in bitcoin in Catalonia. We connect buyers and sellers from',
    },
    "a través de nostr, la web, l'app i Telegram. Pagaments directes entre parts, en bitcoin o sats.": {
      es: 'a través de nostr, la web, la app y Telegram. Pagos directos entre las partes, en bitcoin o sats.',
      en: 'via nostr, the web, the app and Telegram. Direct payments between parties, in bitcoin or sats.',
    },
    'Mercat P2P de Trobades Bitcoiners': {
      es: 'Mercado P2P de Trobades Bitcoiners',
      en: 'P2P Market by Trobades Bitcoiners',
    },
    '📋 Termes i condicions': {
      es: '📋 Términos y condiciones',
      en: '📋 Terms and conditions',
    },
    "Projecte sense ànim de lucre. Únic objectiu: posar en contacte compradors i venedors d'acord amb les lleis d'Espanya. No participem en transaccions ni gestionem pagaments. No ens fem responsables de tractes insatisfets. Les disputes repercuteixen en la reputació de l'anunciant. L'ús implica l'acceptació d'aquests termes.": {
      es: 'Proyecto sin ánimo de lucro. Único objetivo: poner en contacto a compradores y vendedores conforme a las leyes de España. No participamos en transacciones ni gestionamos pagos. No nos hacemos responsables de tratos insatisfechos. Las disputas repercuten en la reputación del anunciante. El uso implica la aceptación de estos términos.',
      en: 'Non-profit project. Sole purpose: putting buyers and sellers in touch in accordance with the laws of Spain. We do not take part in transactions nor handle payments. We are not responsible for unsatisfactory deals. Disputes affect the advertiser\u2019s reputation. Use implies acceptance of these terms.',
    },

    // Toolbar / filters
    'Buscar productes...': { es: 'Buscar productos...', en: 'Search products...' },
    '🔐 Login': { es: '🔐 Login', en: '🔐 Login' },
    '👤 Perfil': { es: '👤 Perfil', en: '👤 Profile' },
    '+ Publicar': { es: '+ Publicar', en: '+ Post' },
    'Totes les categories': { es: 'Todas las categorías', en: 'All categories' },
    'Totes les zones': { es: 'Todas las zonas', en: 'All regions' },

    // Loading / empty
    'Carregant productes...': { es: 'Cargando productos...', en: 'Loading products...' },
    '🛒 No hi ha productes encara': { es: '🛒 Aún no hay productos', en: '🛒 No products yet' },
    'Sigues el primer en publicar!': { es: '¡Sé el primero en publicar!', en: 'Be the first to post!' },
    'Error carregant productes': { es: 'Error cargando productos', en: 'Error loading products' },
    'Carregant...': { es: 'Cargando...', en: 'Loading...' },
    'Encara no hi ha usuaris registrats. Fes login amb Nostr!': {
      es: 'Aún no hay usuarios registrados. ¡Haz login con Nostr!',
      en: 'No registered users yet. Log in with Nostr!',
    },
    'Sense valoracions': { es: 'Sin valoraciones', en: 'No ratings' },
    'Sense valoracions encara': { es: 'Aún sin valoraciones', en: 'No ratings yet' },
    'Cap valoració encara': { es: 'Sin valoraciones aún', en: 'No ratings yet' },

    // Pagination
    '‹ Anterior': { es: '‹ Anterior', en: '‹ Previous' },
    'Següent ›': { es: 'Siguiente ›', en: 'Next ›' },

    // Sidebar
    '📲 Comunitat': { es: '📲 Comunidad', en: '📲 Community' },
    "Únete a la comunitat de Trobades Bitcoiners i descarrega't l'app de Merca-sats des de Zapstore.": {
      es: 'Únete a la comunidad de Trobades Bitcoiners y descarga la app de Merca-sats desde Zapstore.',
      en: 'Join the Trobades Bitcoiners community and get the Merca-sats app from Zapstore.',
    },
    'Copiar npub': { es: 'Copiar npub', en: 'Copy npub' },
    'Copiar adreça .onion': { es: 'Copiar dirección .onion', en: 'Copy .onion address' },
    '✅ Copiat!': { es: '✅ ¡Copiado!', en: '✅ Copied!' },
    '👥 Usuaris registrats': { es: '👥 Usuarios registrados', en: '👥 Registered users' },

    // Footer
    'Merca-sats — Mercat P2P de la comunitat': {
      es: 'Merca-sats — Mercado P2P de la comunidad',
      en: 'Merca-sats — P2P Market of the community',
    },
    'Pagaments en Bitcoin ⚡': { es: 'Pagos en Bitcoin ⚡', en: 'Payments in Bitcoin ⚡' },

    // New Product modal
    '📦 Publicar producte': { es: '📦 Publicar producto', en: '📦 Post product' },
    'Titol *': { es: 'Título *', en: 'Title *' },
    'Descripció': { es: 'Descripción', en: 'Description' },
    'Ex: Arduino Uno R3': { es: 'Ej: Arduino Uno R3', en: 'Ex: Arduino Uno R3' },
    'Detalls del producte...': { es: 'Detalles del producto...', en: 'Product details...' },
    'Preu *': { es: 'Precio *', en: 'Price *' },
    'Categoria': { es: 'Categoría', en: 'Category' },
    'Sense especificar': { es: 'Sin especificar', en: 'Unspecified' },
    'Zona': { es: 'Zona', en: 'Region' },
    'Telegram @ (per contactar)': {
      es: 'Telegram @ (para contactar)',
      en: 'Telegram @ (for contact)',
    },
    '@elteuuser': { es: '@tuusuario', en: '@yourhandle' },
    'Foto (URL)': { es: 'Foto (URL)', en: 'Photo (URL)' },
    'Caducitat (mesos)': { es: 'Caducidad (meses)', en: 'Expiry (months)' },
    "— l'anunci s'eliminarà dels relés Nostr al passar aquest termini": {
      es: '— el anuncio se eliminará de los relés Nostr al pasar este plazo',
      en: '— the listing is deleted from Nostr relays once this expires',
    },
    "— reinicia des d'avui": { es: '— reinicia desde hoy', en: '— restarts from today' },
    'Sense caducitat (permanent)': { es: 'Sin caducidad (permanente)', en: 'No expiry (permanent)' },
    'Publicar': { es: 'Publicar', en: 'Post' },
    'Cancel·lar': { es: 'Cancelar', en: 'Cancel' },

    // Product detail
    '📱 Telegram': { es: '📱 Telegram', en: '📱 Telegram' },
    '🌐 Web': { es: '🌐 Web', en: '🌐 Web' },
    'Veure a Nostr ↗': { es: 'Ver en Nostr ↗', en: 'View on Nostr ↗' },
    '👤 Venedor': { es: '👤 Vendedor', en: '👤 Seller' },
    'Treure reserva': { es: 'Quitar reserva', en: 'Unreserve' },
    '🔒 Reservar producte': { es: '🔒 Reservar producto', en: '🔒 Reserve product' },
    'Nom de qui reserva...': { es: 'Nombre de quien reserva...', en: 'Reserver name...' },
    'Reservar': { es: 'Reservar', en: 'Reserve' },
    '✏️ Editar anunci': { es: '✏️ Editar anuncio', en: '✏️ Edit listing' },
    'Sats': { es: 'Sats', en: 'Sats' },
    'Missatge (opcional):': { es: 'Mensaje (opcional):', en: 'Message (optional):' },
    'Escriu un missatge per al venedor...': {
      es: 'Escribe un mensaje para el vendedor...',
      en: 'Write a message for the seller...',
    },
    '⚡ Pagar amb Zap': { es: '⚡ Pagar con Zap', en: '⚡ Pay with Zap' },
    '⚡ Comprar amb Zap': { es: '⚡ Comprar con Zap', en: '⚡ Buy with Zap' },
    'Escaneja o copia la factura Lightning:': {
      es: 'Escanea o copia la factura Lightning:',
      en: 'Scan or copy the Lightning invoice:',
    },
    'Toca per copiar la factura': { es: 'Toca para copiar la factura', en: 'Tap to copy the invoice' },
    'VENUT': { es: 'VENDIDO', en: 'SOLD' },
    '⭐ Valorar venedor': { es: '⭐ Valorar vendedor', en: '⭐ Rate seller' },
    'Comentari opcional...': { es: 'Comentario opcional...', en: 'Optional comment...' },
    'Enviar valoració': { es: 'Enviar valoración', en: 'Send rating' },
    'Veure perfil': { es: 'Ver perfil', en: 'View profile' },
    'Veure valoracions': { es: 'Ver valoraciones', en: 'View ratings' },
    '🗑 Eliminar anunci': { es: '🗑 Eliminar anuncio', en: '🗑 Delete listing' },
    '🔗 Compartir': { es: '🔗 Compartir', en: '🔗 Share' },
    'Tancar': { es: 'Cerrar', en: 'Close' },
    'Ver en Nostr': { es: 'Ver en Nostr', en: 'View on Nostr' },
    '✅ Enllaç copiat!': { es: '✅ ¡Enlace copiado!', en: '✅ Link copied!' },
    'Anunci Merca-sats': { es: 'Anuncio Merca-sats', en: 'Merca-sats listing' },
    'Copia aquest enllaç:': { es: 'Copia este enlace:', en: 'Copy this link:' },

    // Login modal
    'Connect with your Nostr identity': {
      es: 'Conecta con tu identidad Nostr',
      en: 'Connect with your Nostr identity',
    },
    'Browser Extension': { es: 'Extensión del navegador', en: 'Browser Extension' },
    'Nostr Connect': { es: 'Nostr Connect', en: 'Nostr Connect' },
    'Extension Detected': { es: 'Extensión detectada', en: 'Extension Detected' },
    'Click below to sign in with your Nostr key': {
      es: 'Pulsa abajo para iniciar sesión con tu clave Nostr',
      en: 'Click below to sign in with your Nostr key',
    },
    'Sign in with Extension': { es: 'Entrar con extensión', en: 'Sign in with Extension' },
    'Looking for extension...': { es: 'Buscando extensión...', en: 'Looking for extension...' },
    'Waiting for Nostr extension to load': {
      es: 'Esperando a que cargue la extensión Nostr',
      en: 'Waiting for Nostr extension to load',
    },
    'No Extension Found': { es: 'No se encontró extensión', en: 'No Extension Found' },
    'Install a Nostr extension or use Nostr Connect': {
      es: 'Instala una extensión Nostr o usa Nostr Connect',
      en: 'Install a Nostr extension or use Nostr Connect',
    },
    'Try Login Anyway': { es: 'Probar igualmente', en: 'Try Login Anyway' },
    'Retry Detection': { es: 'Reintentar detección', en: 'Retry Detection' },
    'Use Nostr Connect instead →': {
      es: 'Usa Nostr Connect en su lugar →',
      en: 'Use Nostr Connect instead →',
    },
    'Login with Amber': { es: 'Entrar con Amber', en: 'Login with Amber' },
    'Login with Primal': { es: 'Entrar con Primal', en: 'Login with Primal' },
    'Escaneja i espera uns segons...': {
      es: 'Escanea y espera unos segundos...',
      en: 'Scan and wait a few seconds...',
    },
    '📋 Copy connection string': {
      es: '📋 Copiar cadena de conexión',
      en: '📋 Copy connection string',
    },
    '✅ Copied!': { es: '✅ ¡Copiado!', en: '✅ Copied!' },
    'Escanea amb Amber, Primal o qualsevol signer NIP-46': {
      es: 'Escanea con Amber, Primal o cualquier signer NIP-46',
      en: 'Scan with Amber, Primal or any NIP-46 signer',
    },
    '✅ Connected!': { es: '✅ ¡Conectado!', en: '✅ Connected!' },
    'Cancel': { es: 'Cancelar', en: 'Cancel' },
    'Sign in with Nostr': { es: 'Inicia sesión con Nostr', en: 'Sign in with Nostr' },

    // Profile modal
    '📦 Productes': { es: '📦 Productos', en: '📦 Products' },
    '⭐ Donades': { es: '⭐ Dadas', en: '⭐ Given' },
    '🌟 Rebudes': { es: '🌟 Recibidas', en: '🌟 Received' },
    'Desconnectar': { es: 'Desconectar', en: 'Log out' },
    'Cap producte publicat': { es: 'Sin productos publicados', en: 'No published products' },
    'Cap valoració donada': { es: 'Sin valoraciones dadas', en: 'No ratings given' },
    'Cap valoració rebuda': { es: 'Sin valoraciones recibidas', en: 'No ratings received' },
    'Error carregant perfil': { es: 'Error cargando perfil', en: 'Error loading profile' },

    // Edit modal
    '✏️ Editar producte': { es: '✏️ Editar producto', en: '✏️ Edit product' },
    'Guardar': { es: 'Guardar', en: 'Save' },
    'Error carregant producte': { es: 'Error cargando producto', en: 'Error loading product' },
    'La teva valoració': { es: 'Tu valoración', en: 'Your rating' },

    // Alerts / confirms
    'Titol i preu son obligatoris': {
      es: 'Título y precio son obligatorios',
      en: 'Title and price are required',
    },
    'Cal un signer Nostr per publicar.': {
      es: 'Se necesita un signer Nostr para publicar.',
      en: 'A Nostr signer is required to post.',
    },
    'Selecciona estrelles': { es: 'Selecciona estrellas', en: 'Select stars' },
    'Cal connectar amb Nostr primer': {
      es: 'Hay que conectar con Nostr primero',
      en: 'You need to connect with Nostr first',
    },
    'Cal un signer Nostr per valorar.': {
      es: 'Se necesita un signer Nostr para valorar.',
      en: 'A Nostr signer is required to rate.',
    },
    'Segur que vols eliminar aquest anunci?': {
      es: '¿Seguro que quieres eliminar este anuncio?',
      en: 'Are you sure you want to delete this listing?',
    },
    'Has de tenir sessio iniciada per eliminar': {
      es: 'Debes tener sesión iniciada para eliminar',
      en: 'You must be logged in to delete',
    },
    'Resolent prova de treball (anti-spam)...': {
      es: 'Resolviendo prueba de trabajo (anti-spam)...',
      en: 'Solving proof-of-work (anti-spam)...',
    },
    'PoW resolt! Enviant...': { es: '¡PoW resuelto! Enviando...', en: 'PoW solved! Sending...' },
    'Firmat! Enviant...': { es: '¡Firmado! Enviando...', en: 'Signed! Sending...' },
    'Cal iniciar sessió amb Nostr primer (botó Login). Si ja ho has fet, recarrega la pàgina i torna a provar.': {
      es: 'Hay que iniciar sesión con Nostr primero (botón Login). Si ya lo has hecho, recarga la página y vuelve a intentarlo.',
      en: 'You need to log in with Nostr first (Login button). If you already did, reload the page and try again.',
    },
    'Firma cancel·lada': { es: 'Firma cancelada', en: 'Signature cancelled' },
    'La sessió Nostr ha caducat. Recarrega la pàgina i fes login de nou.': {
      es: 'La sesión Nostr ha caducado. Recarga la página y vuelve a hacer login.',
      en: 'The Nostr session expired. Reload the page and log in again.',
    },
    'Error generant factura': { es: 'Error generando factura', en: 'Error generating invoice' },
    'Introdueix la quantitat en sats': {
      es: 'Introduce la cantidad en sats',
      en: 'Enter the amount in sats',
    },
    '⏳ Generant factura...': { es: '⏳ Generando factura...', en: '⏳ Generating invoice...' },
    'Escriu el nom de qui reserva': {
      es: 'Escribe el nombre de quien reserva',
      en: 'Enter the reserver\u2019s name',
    },
    'Error eliminant': { es: 'Error eliminando', en: 'Error deleting' },
    'Cal un signer Nostr per editar': {
      es: 'Se necesita un signer Nostr para editar',
      en: 'A Nostr signer is required to edit',
    },
    'Títol i preu obligatoris': {
      es: 'Título y precio obligatorios',
      en: 'Title and price are required',
    },
    'No es pot firmar amb el signer actual.': {
      es: 'No se puede firmar con el signer actual.',
      en: 'Cannot sign with the current signer.',
    },
    'Valoració enviada!': { es: '¡Valoración enviada!', en: 'Rating sent!' },
    'No es pot firmar la valoració (login de lectura). Vols enviar-la igualment sense verificació criptogràfica?': {
      es: 'No se puede firmar la valoración (login de lectura). ¿Quieres enviarla igualmente sin verificación criptográfica?',
      en: 'Cannot sign the rating (read-only login). Send it anyway without cryptographic verification?',
    },
    "Cal estar loguejat amb Nostr per publicar un anunci des de la web.\n\n· Accepta per iniciar sessió amb Nostr (extensió o Amber/NIP-46).\n· Cancel·la per publicar via Telegram al canal de Trobades Bitcoiners:\n  https://t.me/trobadesbitcoiners/2106": {
      es: 'Hay que estar logueado con Nostr para publicar un anuncio desde la web.\n\n· Acepta para iniciar sesión con Nostr (extensión o Amber/NIP-46).\n· Cancela para publicar vía Telegram en el canal de Trobades Bitcoiners:\n  https://t.me/trobadesbitcoiners/2106',
      en: 'You must be logged in with Nostr to post a listing from the web.\n\n· Accept to sign in with Nostr (extension or Amber/NIP-46).\n· Cancel to post via Telegram in the Trobades Bitcoiners channel:\n  https://t.me/trobadesbitcoiners/2106',
    },

    // Category names (used by tCat() called from render functions)
    'Informàtica': { es: 'Informática', en: 'Computing' },
    'Energia': { es: 'Energía', en: 'Energy' },
    'Alimentació': { es: 'Alimentación', en: 'Food' },
    'Roba': { es: 'Ropa', en: 'Clothing' },
    'Gaming': { es: 'Gaming', en: 'Gaming' },
    'Finances': { es: 'Finanzas', en: 'Finance' },
    'Vehicle': { es: 'Vehículo', en: 'Vehicle' },
    'Esport': { es: 'Deporte', en: 'Sports' },
    'Llar': { es: 'Hogar', en: 'Home' },
    'Art': { es: 'Arte', en: 'Art' },
    'P2P': { es: 'P2P', en: 'P2P' },
    'Llibres': { es: 'Libros', en: 'Books' },
    'Mobils & Tablets': { es: 'Móviles y Tablets', en: 'Mobiles & Tablets' },
  };

  // Map category id → CA name (used by tCat fallback chain).
  const CATEGORY_BY_ID = {
    informatica: 'Informàtica',
    energia: 'Energia',
    alimentacio: 'Alimentació',
    roba: 'Roba',
    gaming: 'Gaming',
    finances: 'Finances',
    vehicle: 'Vehicle',
    esport: 'Esport',
    llar: 'Llar',
    art: 'Art',
    p2p: 'P2P',
    llibres: 'Llibres',
    mobils: 'Mobils & Tablets',
  };

  // Regex patterns for interpolated strings (numbers / dynamic names).
  // Each entry: { re: RegExp, tpl: { es: (m) => string, en: (m) => string } }
  const I18N_PATTERNS = [
    {
      re: /^(\S+)\/5 \((\d+) valoracions\)$/,
      tpl: {
        es: (m) => `${m[1]}/5 (${m[2]} valoraciones)`,
        en: (m) => `${m[1]}/5 (${m[2]} ratings)`,
      },
    },
    {
      re: /^(\S+)\/5 \((\d+)\)$/,
      tpl: { es: (m) => `${m[1]}/5 (${m[2]})`, en: (m) => `${m[1]}/5 (${m[2]})` },
    },
    {
      re: /^🔒 RESERVAT$/,
      tpl: { es: () => '🔒 RESERVADO', en: () => '🔒 RESERVED' },
    },
    {
      re: /^🔒 RESERVAT per (.+)$/,
      tpl: {
        es: (m) => `🔒 RESERVADO por ${m[1]}`,
        en: (m) => `🔒 RESERVED by ${m[1]}`,
      },
    },
    {
      re: /^Resolent PoW\.\.\. \((\d+) intents\)$/,
      tpl: {
        es: (m) => `Resolviendo PoW... (${m[1]} intentos)`,
        en: (m) => `Solving PoW... (${m[1]} attempts)`,
      },
    },
    {
      re: /^✅ Producte reservat per (.+)$/,
      tpl: {
        es: (m) => `✅ Producto reservado por ${m[1]}`,
        en: (m) => `✅ Product reserved by ${m[1]}`,
      },
    },
    {
      re: /^Error: (.+)$/,
      tpl: { es: (m) => `Error: ${m[1]}`, en: (m) => `Error: ${m[1]}` },
    },
    {
      re: /^Error firmant: (.+)$/,
      tpl: { es: (m) => `Error firmando: ${m[1]}`, en: (m) => `Signing error: ${m[1]}` },
    },
    {
      re: /^Login error: (.+)$/,
      tpl: { es: (m) => `Error de login: ${m[1]}`, en: (m) => `Login error: ${m[1]}` },
    },
    {
      re: /^Connection failed: (.+)$/,
      tpl: { es: (m) => `Conexión fallida: ${m[1]}`, en: (m) => `Connection failed: ${m[1]}` },
    },
  ];

  // Attributes to translate.
  const ATTRS = ['placeholder', 'title', 'alt', 'aria-label'];

  // ---- State ---------------------------------------------------------------
  let currentLang = (() => {
    try {
      const stored = localStorage.getItem(LANG_KEY);
      if (stored && SUPPORTED.includes(stored)) return stored;
    } catch (_) {}
    return 'ca';
  })();

  // ---- Helpers -------------------------------------------------------------
  function translateString(value) {
    if (currentLang === 'ca' || !value) return value;
    const trimmed = value.trim();
    if (!trimmed) return value;
    const entry = I18N[trimmed];
    if (entry && entry[currentLang]) {
      const leading = value.slice(0, value.indexOf(trimmed));
      const trailing = value.slice(value.indexOf(trimmed) + trimmed.length);
      return leading + entry[currentLang] + trailing;
    }
    for (const p of I18N_PATTERNS) {
      const m = trimmed.match(p.re);
      if (m && p.tpl[currentLang]) {
        const leading = value.slice(0, value.indexOf(trimmed));
        const trailing = value.slice(value.indexOf(trimmed) + trimmed.length);
        return leading + p.tpl[currentLang](m) + trailing;
      }
    }
    return value;
  }

  // Walk a root node, translating text nodes + selected attributes.
  function translateTree(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) {
      translateTextNode(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    // Skip the language widget itself so it never gets re-translated.
    if (root.closest && root.closest('#i18n-widget')) return;
    // Translate attributes on root
    translateAttrs(root);
    // Walk descendants
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const tag = node.tagName;
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
              return NodeFilter.FILTER_REJECT;
            }
            if (node.id === 'i18n-widget' || node.closest('#i18n-widget')) {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_SKIP; // visit attrs but keep walking
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );
    let current = walker.nextNode();
    while (current) {
      if (current.nodeType === Node.ELEMENT_NODE) {
        translateAttrs(current);
      } else {
        translateTextNode(current);
      }
      current = walker.nextNode();
    }
    // The above walker with SHOW_ELEMENT and FILTER_SKIP still emits elements;
    // belt-and-braces, iterate elements directly for attrs in case of skip.
    const els = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of els) {
      if (el.closest && el.closest('#i18n-widget')) continue;
      translateAttrs(el);
    }
  }

  function translateTextNode(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    if (node.parentNode && node.parentNode.closest && node.parentNode.closest('#i18n-widget')) return;
    if (node._i18nOrig == null) node._i18nOrig = node.nodeValue;
    const src = node._i18nOrig;
    const out = translateString(src);
    if (out !== node.nodeValue) node.nodeValue = out;
  }

  function translateAttrs(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    for (const attr of ATTRS) {
      if (!el.hasAttribute(attr)) continue;
      const key = '_i18nAttrOrig_' + attr;
      if (el[key] == null) el[key] = el.getAttribute(attr);
      const src = el[key];
      const out = translateString(src);
      if (out !== el.getAttribute(attr)) el.setAttribute(attr, out);
    }
  }

  // Re-translate everything (called on language change).
  function applyAll() {
    translateTree(document.body);
    document.documentElement.setAttribute('lang', currentLang);
  }

  // ---- Public helpers ------------------------------------------------------
  window.tCat = function (id, fallback) {
    if (currentLang === 'ca') return fallback;
    const caName = CATEGORY_BY_ID[id] || fallback;
    const entry = I18N[caName];
    if (entry && entry[currentLang]) return entry[currentLang];
    return fallback;
  };

  window.tLang = function () {
    return currentLang;
  };

  window.setLang = function (lang) {
    if (!SUPPORTED.includes(lang)) return;
    currentLang = lang;
    try { localStorage.setItem(LANG_KEY, lang); } catch (_) {}
    applyAll();
    // Re-render dynamic content that uses tCat()
    try { window.renderCategories && window.renderCategories(); } catch (_) {}
    try { window.renderProducts && window.renderProducts(); } catch (_) {}
    updateWidgetActive();
  };

  // ---- Widget --------------------------------------------------------------
  function injectWidget() {
    if (document.getElementById('i18n-widget')) return;
    const style = document.createElement('style');
    style.textContent = `
      #i18n-widget { position: fixed; bottom: 18px; right: 18px; z-index: 9999;
        font-family: 'Chakra Petch', sans-serif; }
      #i18n-toggle { width: 48px; height: 48px; border-radius: 50%;
        background: #f7931a; color: #000; border: 2px solid #c77400;
        cursor: pointer; font-size: 13px; font-weight: 700;
        box-shadow: 0 4px 10px rgba(0,0,0,0.4); display: flex;
        align-items: center; justify-content: center; padding: 0;
        font-family: inherit; letter-spacing: 0.5px; }
      #i18n-toggle:hover { background: #e16d00; box-shadow: 0 0 12px rgba(247,147,26,0.5); }
      #i18n-menu { position: absolute; bottom: 56px; right: 0;
        background: #1a1a2e; border: 2px solid #f7931a; border-radius: 8px;
        padding: 6px; display: none; flex-direction: column; gap: 4px;
        box-shadow: 0 6px 14px rgba(0,0,0,0.5); min-width: 80px; }
      #i18n-widget.open #i18n-menu { display: flex; }
      .i18n-opt { background: transparent; color: #e0e0e0; border: none;
        padding: 8px 14px; cursor: pointer; font-size: 14px; font-weight: 600;
        border-radius: 4px; text-align: center; font-family: inherit;
        letter-spacing: 0.5px; }
      .i18n-opt:hover { background: #2a2a3e; color: #f7931a; }
      .i18n-opt.active { background: #f7931a; color: #000; }
    `;
    document.head.appendChild(style);

    const wrap = document.createElement('div');
    wrap.id = 'i18n-widget';
    wrap.innerHTML = `
      <div id="i18n-menu">
        <button class="i18n-opt" data-lang="ca">CAT</button>
        <button class="i18n-opt" data-lang="es">ES</button>
        <button class="i18n-opt" data-lang="en">EN</button>
      </div>
      <button id="i18n-toggle" title="Language / Idioma">${LABELS[currentLang]}</button>
    `;
    document.body.appendChild(wrap);

    const toggle = wrap.querySelector('#i18n-toggle');
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      wrap.classList.toggle('open');
    });
    wrap.querySelectorAll('.i18n-opt').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const lang = b.getAttribute('data-lang');
        window.setLang(lang);
        toggle.textContent = LABELS[lang];
        wrap.classList.remove('open');
      });
    });
    document.addEventListener('click', () => wrap.classList.remove('open'));
    updateWidgetActive();
  }

  function updateWidgetActive() {
    const wrap = document.getElementById('i18n-widget');
    if (!wrap) return;
    wrap.querySelectorAll('.i18n-opt').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-lang') === currentLang);
    });
    const t = wrap.querySelector('#i18n-toggle');
    if (t) t.textContent = LABELS[currentLang];
  }

  // ---- MutationObserver ----------------------------------------------------
  function startObserver() {
    const obs = new MutationObserver((mutations) => {
      if (currentLang === 'ca') return;
      for (const m of mutations) {
        if (m.type === 'childList') {
          for (const n of m.addedNodes) {
            if (n.nodeType === Node.TEXT_NODE) translateTextNode(n);
            else if (n.nodeType === Node.ELEMENT_NODE) translateTree(n);
          }
        } else if (m.type === 'characterData') {
          translateTextNode(m.target);
        } else if (m.type === 'attributes') {
          if (m.target && m.target.nodeType === Node.ELEMENT_NODE) {
            // Refresh stored "original" for this attr (someone just set it)
            const key = '_i18nAttrOrig_' + m.attributeName;
            const cur = m.target.getAttribute(m.attributeName);
            if (cur != null) {
              m.target[key] = cur;
              translateAttrs(m.target);
            }
          }
        }
      }
    });
    obs.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS,
    });
  }

  // ---- Monkey-patch alert / confirm / prompt -------------------------------
  const _alert = window.alert.bind(window);
  const _confirm = window.confirm.bind(window);
  const _prompt = window.prompt.bind(window);
  window.alert = function (msg) {
    return _alert(typeof msg === 'string' ? translateString(msg) : msg);
  };
  window.confirm = function (msg) {
    return _confirm(typeof msg === 'string' ? translateString(msg) : msg);
  };
  window.prompt = function (msg, def) {
    return _prompt(typeof msg === 'string' ? translateString(msg) : msg, def);
  };

  // ---- Boot ----------------------------------------------------------------
  function boot() {
    injectWidget();
    if (currentLang !== 'ca') applyAll();
    startObserver();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
