// Sealed messages between this page and the server (docs/21 §4).
//
// The JavaScript twin of booking/seal.py. Both must produce identical results,
// and tests/seal_roundtrip.html proves it:
//
//   ECDH P-256   -> shared secret      (public keys as raw uncompressed points)
//   HKDF-SHA256  -> 32-byte key        (salt: 32 zero bytes, info: atgc-booking-v1)
//   AES-256-GCM  -> ciphertext + tag   (fresh 12-byte IV, tag appended)
//
// Only the browser's own Web Crypto - no library is loaded.

const Seal = (() => {
  const VERSION = 1;
  const INFO = new TextEncoder().encode("atgc-booking-v1");
  const SALT = new Uint8Array(32);
  const CURVE = { name: "ECDH", namedCurve: "P-256" };

  function b64(buffer) {
    const bytes = new Uint8Array(buffer);
    let text = "";
    for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    return btoa(text);
  }

  function unb64(text) {
    const raw = atob(text);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  async function importPublic(rawB64) {
    return crypto.subtle.importKey("raw", unb64(rawB64), CURVE, false, []);
  }

  async function aesKey(privateKey, publicKey, usage) {
    const bits = await crypto.subtle.deriveBits(
      { name: "ECDH", public: publicKey }, privateKey, 256);
    const base = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: SALT, info: INFO },
      base, { name: "AES-GCM", length: 256 }, false, [usage]);
  }

  // This browser's own key pair. The private half is NOT extractable: no script
  // on the page, including this one, can ever read it out.
  async function newBrowserKey() {
    return crypto.subtle.generateKey(CURVE, false, ["deriveBits"]);
  }

  async function publicRaw(keyPair) {
    return b64(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  }

  // Seal an object to a recipient's public key, given as raw base64.
  async function seal(recipientRawB64, obj) {
    const recipient = await importPublic(recipientRawB64);
    const ephemeral = await crypto.subtle.generateKey(CURVE, true, ["deriveBits"]);
    const key = await aesKey(ephemeral.privateKey, recipient, "encrypt");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(JSON.stringify(obj));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
    return {
      v: VERSION,
      epk: b64(await crypto.subtle.exportKey("raw", ephemeral.publicKey)),
      iv: b64(iv),
      ct: b64(ct),
    };
  }

  // Open a box sealed to this browser. Throws if it is not ours or was altered.
  async function open(privateKey, box) {
    if (!box || box.v !== VERSION) throw new Error("not a sealed message");
    const epk = await importPublic(box.epk);
    const key = await aesKey(privateKey, epk, "decrypt");
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(box.iv) }, key, unb64(box.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  function randomB64(bytes) {
    return b64(crypto.getRandomValues(new Uint8Array(bytes)));
  }

  return { newBrowserKey, publicRaw, seal, open, randomB64 };
})();
