#!/usr/bin/env python3
"""Incremente la version du dashboard Hermes Mission Control.

Usage:
    python3 bump_version.py            # bump le patch (x.y.Z -> x.y.Z+1)
    python3 bump_version.py minor       # bump le minor (x.Y.0 -> x.Y+1.0)
    python3 bump_version.py major       # bump le major (X.0.0 -> X+1.0.0)
    python3 bump_version.py 1.18.0      # force une version exacte

Le fichier VERSION (a la racine) est la source de verite. Le frontend
(src/components/TopNav.tsx) et le backend (server_version) le lisent au runtime.

Ce script est appele automatiquement par le hook .git/hooks/pre-commit
(qui bump le patch a chaque commit sur le dashboard), et peut aussi etre
lance manuellement par un agent (Manager / Developpeur) apres une modif.
"""
import os
import sys

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
VERSION_PATH = os.path.join(PROJECT_DIR, "VERSION")


def read_version():
    try:
        with open(VERSION_PATH, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except FileNotFoundError:
        return "0.0.0"


def parse_version(s):
    parts = s.split(".")
    nums = []
    for p in parts[:3]:
        try:
            nums.append(int(p))
        except ValueError:
            nums.append(0)
    while len(nums) < 3:
        nums.append(0)
    return nums[0], nums[1], nums[2]


def write_version(major, minor, patch):
    with open(VERSION_PATH, "w", encoding="utf-8") as fh:
        fh.write(f"{major}.{minor}.{patch}\n")


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else "patch"

    if arg in ("major", "minor", "patch"):
        major, minor, patch = parse_version(read_version())
        if arg == "major":
            major, minor, patch = major + 1, 0, 0
        elif arg == "minor":
            minor, patch = minor + 1, 0
        else:
            patch += 1
    else:
        # version forcee: valider le format x.y.z
        try:
            major, minor, patch = parse_version(arg)
        except Exception:
            print(f"Version invalide: {arg!r} (attendu x.y.z)", file=sys.stderr)
            sys.exit(1)

    write_version(major, minor, patch)
    new = f"{major}.{minor}.{patch}"
    print(new)
    return new


if __name__ == "__main__":
    main()
