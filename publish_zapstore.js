const { finalizeEvent } = require('nostr-tools/pure');
const { useWebSocketImplementation, Relay } = require('nostr-tools/relay');
useWebSocketImplementation(require('ws'));

const sk = Uint8Array.from(Buffer.from('cdccdb9c6ba6210db4fe0a28e3c3cbcd648eec672e14dd9720df22aafbf74e0d','hex'));

const SHA256 = '516fd0a4fa106431fa76b52ffcb46c468b3755d86c33940a6a369fd15a3243c7';
const SIZE = 3415816;
const URL = 'https://blossom.primal.net/' + SHA256;
const VERSION = '1.7.1';
const IDENTIFIER = 'com.kilombino.mercasats';
const D_TAG = `${IDENTIFIER}@${VERSION}`;

const RELAYS = [
  'wss://relay.zapstore.dev',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
];

// === kind 3063: File metadata ===
const fileEvent = finalizeEvent({
  kind: 3063,
  created_at: Math.floor(Date.now()/1000),
  tags: [
    ['i', IDENTIFIER],
    ['x', SHA256],
    ['version', VERSION],
    ['url', URL],
    ['m', 'application/vnd.android.package-archive'],
    ['size', String(SIZE)],
    ['f', 'android-arm64-v8a'],
    ['f', 'android-armeabi-v7a'],
    ['f', 'android-x86'],
    ['f', 'android-x86_64'],
    ['min_platform_version', '26'],
    ['target_platform_version', '34'],
    ['filename', 'mercasats-v1.7.1.apk'],
    ['version_code', '11'],
    ['apk_certificate_hash', 'e061195de1680cede938baa54979f5258a8148910091b4a888d0bb5170ff88ec'],
  ],
  content: '',
}, sk);

// === kind 30063: Release event ===
const changelog = `- 🔐 Primera versión firmada con keystore propio (RSA 4096) — fuera del auto-firma de debug
- 📦 R8/minify activado: APK pasa de 19 MB a 3,3 MB
- ✅ Reglas ProGuard completas para Gson + Retrofit (signature, type adapters, kotlin metadata)
- ⚠️ Hay que desinstalar la versión anterior antes de instalar esta (cambio de firma)`;

const releaseEvent = finalizeEvent({
  kind: 30063,
  created_at: Math.floor(Date.now()/1000),
  tags: [
    ['i', IDENTIFIER],
    ['version', VERSION],
    ['d', D_TAG],
    ['c', 'main'],
    ['e', fileEvent.id, 'wss://relay.zapstore.dev'],
  ],
  content: changelog,
}, sk);

// === kind 5: Delete the broken @v1.7.1 event from earlier publish ===
const BROKEN_IDS = [
  '760694c95e2f1f27', // truncated; need full IDs
];

async function publish(event, relayUrl) {
  try {
    const r = await Relay.connect(relayUrl);
    await r.publish(event);
    console.log(relayUrl, 'OK kind', event.kind, event.id.slice(0,16));
    r.close();
  } catch(e) {
    console.log(relayUrl, 'FAIL kind', event.kind, e.message);
  }
}

(async () => {
  console.log('=== file event ===');
  console.log(JSON.stringify(fileEvent, null, 2));
  console.log('\n=== release event ===');
  console.log(JSON.stringify(releaseEvent, null, 2));
  console.log('\n=== publishing ===');
  for (const url of RELAYS) {
    await publish(fileEvent, url);
    await publish(releaseEvent, url);
  }
  process.exit(0);
})();
