# -*- coding: utf-8 -*-
"""Build the ATGC booking page: src/ -> dist/, and refuse anything unsafe to publish.

    python build.py                # build and check
    python build.py --for-publish  # ...and also require everything publishing needs

`dist/` is generated wholesale. Never hand-edit anything in it.

This repository is public, and so is everything the page serves. The checks
below are the reason that is safe: the page carries no secret, loads no code from
anywhere else, and every message it sends is sealed before it leaves the browser.
"""

from __future__ import annotations

import argparse
import base64
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
DIST = ROOT / "dist"

ALLOWED = {".html", ".css", ".js", ".png", ".svg", ".ico"}

LETTERBOX = re.compile(r"^https://script\.google\.com/macros/s/[A-Za-z0-9_-]{20,}/exec$")

# Text that has no business in a public page. A match fails the build.
FORBIDDEN = [
    (re.compile(r"PRIVATE KEY"), "a private key"),
    (re.compile(r"SERVER_SECRET|letterbox_secret"), "the letterbox's server secret"),
    (re.compile(r"secret\s*[:=]\s*[\"'][A-Za-z0-9_\-+/=]{24,}[\"']", re.I), "a secret value"),
    # Generic on purpose: this file is public too, so it must not name the very
    # details it keeps out. A network share path, a hidden folder in a home
    # directory, or a key file are enough to catch a server detail leaking in.
    (re.compile(r"\\\\[\w.-]+\\|~/\.\w|\.pem\b", re.I), "a detail of a server"),
    (re.compile(r"<script[^>]+src\s*=\s*[\"']?(https?:)?//", re.I), "a script loaded from elsewhere"),
]


def read_config(text):
    url = re.search(r"letterboxUrl\s*:\s*\"([^\"]*)\"", text)
    key = re.search(r"serverPublicKey\s*:\s*(null|\"([^\"]*)\")", text)
    return (url.group(1) if url else None,
            (key.group(2) if key and key.group(1) != "null" else None),
            bool(key))


def valid_public_key(value):
    try:
        raw = base64.b64decode(value, validate=True)
    except Exception:                                   # noqa: BLE001
        return False
    return len(raw) == 65 and raw[0] == 4        # an uncompressed P-256 point


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--for-publish", action="store_true")
    args = ap.parse_args()

    failures, notes = [], []

    files = [p for p in SRC.rglob("*") if p.is_file()]
    for p in files:
        if p.suffix.lower() not in ALLOWED:
            failures.append("not a page or asset: %s" % p.relative_to(SRC))
            continue
        if p.suffix.lower() in (".png", ".ico"):
            continue                          # an image: nothing in it to leak
        text = p.read_text(encoding="utf-8")
        for pattern, what in FORBIDDEN:
            if pattern.search(text):
                failures.append("%s contains %s" % (p.relative_to(SRC), what))

    if not (SRC / "index.html").exists():
        failures.append("there is no index.html")

    config = SRC / "config.js"
    if not config.exists():
        failures.append("there is no config.js")
    else:
        url, key, key_present = read_config(config.read_text(encoding="utf-8"))
        if not url or not LETTERBOX.match(url):
            failures.append("config.js: letterboxUrl is not an Apps Script web app address")
        if not key_present:
            failures.append("config.js: serverPublicKey is missing")
        elif key is None:
            (failures if args.for_publish else notes).append(
                "config.js: serverPublicKey is not set yet - the page cannot be published")
        elif not valid_public_key(key):
            failures.append("config.js: serverPublicKey is not a P-256 public key")

    if failures:
        print("BUILD FAILED")
        for f in failures:
            print("  - " + f)
        return 1

    if DIST.exists():
        shutil.rmtree(DIST)
    shutil.copytree(SRC, DIST)
    (DIST / ".nojekyll").touch()

    print("built %d file(s) into dist/" % len(files))
    for n in notes:
        print("note: " + n)
    print("all build checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
