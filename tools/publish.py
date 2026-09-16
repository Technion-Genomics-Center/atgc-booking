# -*- coding: utf-8 -*-
"""Publish dist/ to the gh-pages branch - the branch the live page serves.

    python tools/publish.py "What changed"

Pushing to main does NOT change the live page: main holds the source, and GitHub
Pages serves gh-pages. So publishing is one command that cannot be half-done. It
builds with every publish check, refuses anything but pages and assets, replaces
gh-pages wholesale, pushes, turns Pages on the first time, and waits until the
live page serves the build just made before it says "live".

The same pattern as the ATGC submission forms.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
BRANCH = "gh-pages"
REPO = "Technion-Genomics-Center/atgc-booking"
LIVE = "https://technion-genomics-center.github.io/atgc-booking/"
WORKTREE = ROOT / ".ghpages"
ALLOWED = {".html", ".css", ".js", ".png", ".svg", ".ico"}


def run(*args, cwd=ROOT, check=True):
    # A checkout on a network drive trips git's dubious-ownership guard for a
    # fresh worktree. Scope the exception to this process.
    if args and args[0] == "git":
        args = ("git", "-c", "safe.directory=*") + args[1:]
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if check and r.returncode:
        sys.exit("$ %s\n%s%s" % (" ".join(args), r.stdout, r.stderr))
    return r.stdout.strip()


def build():
    r = subprocess.run([sys.executable, "build.py", "--for-publish"], cwd=ROOT,
                       capture_output=True, text=True)
    print(r.stdout)
    if r.returncode or "all build checks passed" not in r.stdout:
        sys.exit("build failed - nothing published")


def ensure_pages():
    """Turn GitHub Pages on for gh-pages, the first time only."""
    r = subprocess.run(["gh", "api", "repos/%s/pages" % REPO],
                       capture_output=True, text=True)
    if r.returncode == 0:
        return
    run("gh", "api", "-X", "POST", "repos/%s/pages" % REPO,
        "-f", "source[branch]=%s" % BRANCH, "-f", "source[path]=/")
    print("GitHub Pages turned on for %s" % BRANCH)


def is_live(rel, want):
    try:
        with urllib.request.urlopen(LIVE + rel.replace("\\", "/"), timeout=20) as f:
            got = f.read()
    except Exception:                                       # noqa: BLE001
        return False
    return got.replace(b"\r\n", b"\n") == want.replace(b"\r\n", b"\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("message", help='e.g. "Sign-in screen"')
    args = ap.parse_args()

    build()

    bad = [p for p in DIST.rglob("*")
           if p.is_file() and p.suffix.lower() not in ALLOWED and p.name != ".nojekyll"]
    if bad:
        sys.exit("refusing to publish, these are not pages or assets:\n  " +
                 "\n  ".join(str(p.relative_to(DIST)) for p in bad))

    if WORKTREE.exists():
        run("git", "worktree", "remove", "--force", str(WORKTREE), check=False)
        shutil.rmtree(WORKTREE, ignore_errors=True)

    exists = run("git", "ls-remote", "--heads", "origin", BRANCH)
    if exists:
        run("git", "fetch", "origin", BRANCH)
        run("git", "worktree", "add", "--detach", str(WORKTREE), "origin/%s" % BRANCH)
    else:
        # The first publish: gh-pages starts empty, with no source history in it.
        run("git", "worktree", "add", "--detach", str(WORKTREE), "HEAD")
        run("git", "checkout", "--orphan", "gh-pages-first", cwd=WORKTREE)
        run("git", "rm", "-rf", "-q", ".", cwd=WORKTREE, check=False)

    changed = []
    try:
        # Replace, don't merge: a file deleted from dist/ must disappear from
        # the site, not linger because nothing overwrote it.
        for p in WORKTREE.iterdir():
            if p.name == ".git":
                continue
            shutil.rmtree(p) if p.is_dir() else p.unlink()
        shutil.copytree(DIST, WORKTREE, dirs_exist_ok=True)

        run("git", "add", "-A", cwd=WORKTREE)
        status = run("git", "status", "--porcelain", cwd=WORKTREE)
        if not status:
            print("gh-pages already identical - nothing to push")
            return
        changed = [ln[3:].strip().strip('"') for ln in status.splitlines()
                   if not ln.lstrip().startswith("D")]
        print("%d file(s) changed: %s" % (len(changed), ", ".join(changed[:6])))
        run("git", "-c", "core.autocrlf=false", "commit", "-q", "-m", args.message,
            cwd=WORKTREE)
        run("git", "push", "-q", "origin", "HEAD:%s" % BRANCH, cwd=WORKTREE)
        print("pushed to %s" % BRANCH)
    finally:
        run("git", "worktree", "remove", "--force", str(WORKTREE), check=False)

    ensure_pages()

    probe = next((c for c in changed if c.endswith((".html", ".js", ".css"))), None)
    if not probe or not (DIST / probe).exists():
        print("pushed; no text file to verify against")
        return
    want = (DIST / probe).read_bytes()
    print("waiting for the deploy (watching %s)" % probe, end="", flush=True)
    for _ in range(40):                     # up to ~10 minutes
        time.sleep(15)
        print(".", end="", flush=True)
        if is_live(probe, want):
            print("\nLIVE - %s now serves the build just made" % LIVE)
            return
    sys.exit("\nthe deploy has not appeared yet. The push itself succeeded.")


if __name__ == "__main__":
    main()
