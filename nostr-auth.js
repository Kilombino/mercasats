// NIP-46 Nostr Connect client for Mercasats
// Uses nostr-tools BunkerSigner + createNostrConnectURI (same as aqstr.com)

import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { BunkerSigner, createNostrConnectURI } from 'nostr-tools/nip46';

const NIP46_RELAYS = [
  'wss://relay.bullishbounty.com',
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://bucket.coracle.social'
];

function randomHex(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

class MercasatsAuth {
  constructor() {
    this.sk = generateSecretKey();
    this.pk = getPublicKey(this.sk);
    this.secret = randomHex(16);
    this.signer = null;
    this.userPubkey = null;
    this.isAborted = false;
    console.log('[NIP-46] Client pubkey:', this.pk);
  }

  getConnectionString() {
    return createNostrConnectURI({
      clientPubkey: this.pk,
      relays: NIP46_RELAYS,
      secret: this.secret,
      name: 'Merca-sats',
      url: 'https://mercasats.kilombino.com',
      image: 'https://mercasats.kilombino.com/logo.jpg',
    });
  }

  async attemptConnection(timeout) {
    const connStr = this.getConnectionString();
    console.log('[NIP-46] URI:', connStr.substring(0, 100) + '...');

    this.signer = await BunkerSigner.fromURI(
      this.sk,
      connStr,
      { onauth: (url) => { console.log('[NIP-46] Auth URL:', url); window.open(url, '_blank'); } },
      timeout
    );

    this.userPubkey = await this.signer.getPublicKey();
    console.log('[NIP-46] Connected! User pubkey:', this.userPubkey);
    return this.userPubkey;
  }

  async waitForConnection(timeout = 120000) {
    let lastError = null;
    for (let attempt = 0; attempt < 5 && !this.isAborted; attempt++) {
      if (attempt > 0) {
        this.signer = null;
        console.log(`[NIP-46] Retry ${attempt + 1}/5`);
        await new Promise(r => setTimeout(r, 1500));
      }
      if (this.isAborted) throw new Error('Aborted');
      try {
        return await this.attemptConnection(timeout);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const msg = lastError.message.toLowerCase();
        if (msg.includes('subscription closed') || msg.includes('connection') ||
            msg.includes('websocket') || msg.includes('timeout')) {
          console.warn(`[NIP-46] Attempt ${attempt + 1} failed:`, lastError.message);
          continue;
        }
        throw lastError;
      }
    }
    throw lastError || new Error('Failed after retries');
  }

  async waitForConnectionWithVisibility(timeout = 120000) {
    return new Promise((resolve, reject) => {
      let done = false;

      const onVisible = () => {
        if (document.visibilityState === 'visible' && !done && !this.isAborted) {
          console.log('[NIP-46] Page visible again, retrying...');
          setTimeout(() => tryConnect(), 800);
        }
      };

      const tryConnect = async () => {
        if (done || this.isAborted) return;
        try {
          const pk = await this.waitForConnection(timeout);
          if (!done) { done = true; cleanup(); resolve(pk); }
        } catch(e) {
          if (!done) console.warn('[NIP-46] Will retry on next visibility change:', e.message);
        }
      };

      const cleanup = () => document.removeEventListener('visibilitychange', onVisible);
      document.addEventListener('visibilitychange', onVisible);

      tryConnect().catch(e => { if (!done) { done = true; cleanup(); reject(e); } });

      setTimeout(() => { if (!done) { done = true; this.isAborted = true; cleanup(); reject(new Error('Timeout')); } }, timeout);
    });
  }

  async getPublicKey() {
    if (this.userPubkey) return this.userPubkey;
    if (this.signer) return await this.signer.getPublicKey();
    throw new Error('Not connected');
  }

  async signEvent(event) {
    if (!this.signer) throw new Error('Not connected');
    return await this.signer.signEvent(event);
  }

  abort() {
    this.isAborted = true;
    this.signer = null;
    this.userPubkey = null;
  }
}

window.MercasatsAuth = MercasatsAuth;
window.NIP46_RELAYS = NIP46_RELAYS;
