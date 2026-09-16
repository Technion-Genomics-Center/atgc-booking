# ATGC booking page

The page researchers use to book services at the Azrieli–Technion Genomics
Center: sign in, order, and follow their orders.

**This repository is public**, and so is the page it publishes. That is safe
because of how the page works:

- **It holds no secret.** It carries only the address of a letterbox and the
  public half of the lab server's key.
- **Everything it sends is sealed in the browser** (ECDH P-256, HKDF-SHA256,
  AES-256-GCM, with the browser's own Web Crypto) before it leaves, so the
  letterbox only ever holds messages it cannot read.
- **It decides nothing.** Every rule — who may order, on which budget, what they
  may see — is enforced by the lab's server, which is not part of this repository.
- **It loads no code from anywhere else.**

---

## Build and publish

    python build.py                      # src/ -> dist/, with every check
    python tools/publish.py "What changed"

`src/` is the page. `dist/` is generated wholesale — never hand-edit it.

**`main` is not what the live page serves.** GitHub Pages serves `gh-pages`, and
pushing a change to `main` changes nothing a researcher can see. Always publish
with `tools/publish.py`: it builds, refuses anything but pages and assets, replaces
`gh-pages` wholesale, pushes, and waits until the live page serves the new build.

## What the build refuses

| Check | Why |
|---|---|
| only `.html`, `.css`, `.js` and images | nothing else belongs on a public page |
| no private key, no server secret, no secret-looking value | the page must hold none |
| no detail of the lab's servers | not for the public |
| no script loaded from another site | the page runs only its own code |
| `letterboxUrl` is an Apps Script web app address | messages go to the letterbox, nowhere else |
| `serverPublicKey` is a real P-256 public key — required to publish | a wrong key would seal messages nobody can open |

## Layout

    src/index.html        the page
    src/config.js         the letterbox address and the server's public key
    src/assets/seal.js    sealing and opening messages
    src/assets/page.css
    tests/seal_roundtrip.html   proves seal.js agrees with the server
    build.py
    tools/publish.py
