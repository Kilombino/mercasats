<p align="center">
  <img src="public/logo.jpg" alt="Merca-sats" width="300">
</p>

<h1 align="center">Merca-sats</h1>

<p align="center">
  <b>Marketplace P2P con autenticacion Nostr y pagos en Bitcoin/sats</b><br>
  Compra y vende productos y servicios entre personas, sin intermediarios.
</p>

<p align="center">
  <a href="https://mercasats.kilombino.com">mercasats.kilombino.com</a>
</p>

---

## Que es Merca-sats?

Merca-sats es un marketplace peer-to-peer donde cualquiera puede publicar anuncios de productos y servicios, pagando en **Bitcoin (sats)** o euros. La identidad de los usuarios se gestiona mediante **Nostr**, sin necesidad de cuentas, emails ni passwords.

## Como funciona?

Merca-sats es **bidireccional**:

- Publica tus productos y servicios por sats en [mercasats.kilombino.com](https://mercasats.kilombino.com) y se publicaran automaticamente en el [Telegram de Mercasats](https://t.me/trobadesbitcoiners/2106) **y en Nostr**
- Publica tus productos y servicios en el [Telegram de Mercasats](https://t.me/trobadesbitcoiners/2106) y se publicaran automaticamente en la web y en Nostr

### Compra con Zaps

Cada anuncio se publica como un evento Nostr ([kind 30402](https://github.com/nostr-protocol/nips/blob/master/99.md)). Cuando alguien **zapea** el evento con la cantidad indicada en el precio, el producto se marca como **vendido** automaticamente y el vendedor recibe una notificacion en Nostr.

### Resenas npub a npub

Deja valoraciones verificables de tus trades, firmadas con tu clave Nostr. La reputacion va ligada a tu npub, no a una cuenta centralizada.

## Caracteristicas

- **Publicacion tripartita Web <-> Telegram <-> Nostr** — Publica en un sitio y aparece en los demas automaticamente
- **Compra via Zaps** — Zapea un anuncio con el precio indicado y se marca como vendido, notificando al vendedor
- **Login con Nostr** — Compatible con extensiones de navegador (Alby, nos2x) via NIP-07 y con apps moviles (Amber, Primal) via Nostr Connect (NIP-46)
- **Resenas npub a npub** — Valora vendedores con firmas Nostr verificables, reputacion ligada a tu identidad
- **Anti-spam con Proof of Work** — Para publicar un anuncio tu navegador resuelve un pequeno reto computacional, sin captchas ni registro
- **Categorias y regiones** — Filtra por tipo de producto y zona geografica
- **Fotos** — Sube imagenes directamente desde el navegador
- **Sin base de datos centralizada de usuarios** — Tu identidad es tu clave Nostr

## Stack

| Componente | Tecnologia |
|---|---|
| Backend | Node.js + Express |
| Base de datos | SQLite (better-sqlite3) |
| Frontend | HTML/CSS/JS vanilla |
| Autenticacion | Nostr (NIP-07 + NIP-46) |
| Publicacion | Nostr kind 30402 (classified listings) |
| Pagos | Zaps (Lightning via Nostr) |
| Notificaciones | Telegram Bot API + Nostr |

## Instalacion

```bash
git clone https://github.com/Kilombino/mercasats.git
cd mercasats
npm install
node server.js
```

La app arranca en `http://localhost:3102`.

Al primer arranque se genera automaticamente una clave Nostr para el marketplace (`.nostr-key`). Esta clave se usa para publicar los anuncios y monitorizar los zaps.

### Variables de entorno opcionales

| Variable | Descripcion |
|---|---|
| `TG_BOT_TOKEN` | Token de bot de Telegram para notificaciones de nuevos anuncios |

## Estructura

```
mercasats/
├── server.js              # API y servidor Express
├── db.js                  # Esquema e inicializacion SQLite
├── nostr-publish.js       # Publicacion a Nostr + monitor de zaps
├── nostr-auth.js          # Cliente NIP-46 (Nostr Connect)
├── public/
│   ├── index.html         # Frontend SPA
│   ├── nostr-auth.bundle.js
│   └── logo.jpg
└── photos/                # Fotos subidas (no incluidas en el repo)
```

## Flujo de compra via Zap

```
1. Vendedor publica anuncio (web o Telegram)
2. Anuncio se publica como evento Nostr kind 30402
3. Comprador ve el anuncio en Nostr / web
4. Comprador zapea el evento con el precio indicado
5. El monitor de zaps detecta el pago
6. Producto se marca como vendido
7. Vendedor recibe notificacion en Nostr
```

## Licencia

MIT
