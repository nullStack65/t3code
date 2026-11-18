#!/usr/bin/env python3
"""Qualify a packaged desktop app's resources and write a provenance manifest.

Usage: qualify-desktop-app.py --resources DIR --node NODE --asar ASAR_MJS --version X.Y.Z
         --out MANIFEST.json [--info-plist PATH --bundle-id ID] [--meta KEY=VALUE ...]
Exits 1 and lists the failed gates when the app is not the expected build.
"""
import argparse, hashlib, json, os, plistlib, re, subprocess, sys, tempfile

MARKERS = {
    "assemblyai_sync_endpoint": ("server", "sync.assemblyai.com/v1/transcribe"),
    "assemblyai_model_header": ("server", "universal-3-5-pro"),
    "assemblyai_word_boost": ("server", "word_boost"),
    "assemblyai_settings": ("web", "assemblyai"),
    "founder_inbox_settings": ("web", "founderInboxFilter"),
    "founder_inbox_filter_menu": ("web", ", the last one shown, so it stays checked"),
    "public_relay_url": ("server", "relay.t3.codes"),
    "public_relay_url_web": ("web", "relay.t3.codes"),
}
CREDENTIAL_PATTERNS = [
    rb"gh[opusr]_[A-Za-z0-9]{36}",
    rb"github_pat_[A-Za-z0-9_]{40,}",
    rb"sk-ant-[A-Za-z0-9_-]{20,}",
    rb"xox[baprs]-[A-Za-z0-9-]{10,}",
    rb"-----BEGIN [A-Z ]*PRIVATE KEY-----",
]


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree(root, skip=None):
    """sha256 over '<sha256>  <relative path>' lines sorted by UTF-8 path bytes."""
    lines = []
    for directory, dirs, files in os.walk(root):
        if skip:
            dirs[:] = [d for d in dirs if os.path.join(directory, d) != skip]
        for name in files:
            path = os.path.join(directory, name)
            lines.append((os.path.relpath(path, root).encode(), sha256(path)))
    body = b"".join(h.encode() + b"  " + p + b"\n" for p, h in sorted(lines))
    return hashlib.sha256(body).hexdigest(), len(lines)


def contains(root, needle, skip=None):
    data = needle.encode()
    for directory, dirs, files in os.walk(root):
        if skip:
            dirs[:] = [d for d in dirs if os.path.join(directory, d) != skip]
        for name in files:
            with open(os.path.join(directory, name), "rb") as handle:
                if data in handle.read():
                    return True
    return False


def main():
    parser = argparse.ArgumentParser()
    for flag in ("--resources", "--node", "--asar", "--version", "--out"):
        parser.add_argument(flag, required=True)
    parser.add_argument("--info-plist")
    parser.add_argument("--bundle-id")
    parser.add_argument("--meta", action="append", default=[])
    args = parser.parse_args()
    failures = []
    resources = os.path.abspath(args.resources)
    asar = os.path.join(resources, "app.asar")
    result = {"meta": dict(item.split("=", 1) for item in args.meta), "gates": {}}

    def gate(name, ok, detail=None):
        result["gates"][name] = {"ok": bool(ok), **({"detail": detail} if detail else {})}
        if not ok:
            failures.append(name)

    gate("no_update_feed", not os.path.exists(os.path.join(resources, "app-update.yml")))
    if args.info_plist:
        with open(args.info_plist, "rb") as handle:
            plist = plistlib.load(handle)
        result["info_plist"] = {
            key: plist.get(key)
            for key in ("CFBundleIdentifier", "CFBundleName", "CFBundleShortVersionString",
                        "LSMinimumSystemVersion", "CFBundleExecutable")
        }
        gate("plist_version", plist.get("CFBundleShortVersionString") == args.version)
        if args.bundle_id:
            gate("bundle_id", plist.get("CFBundleIdentifier") == args.bundle_id)

    with tempfile.TemporaryDirectory() as work:
        app = os.path.join(work, "app")
        subprocess.run([args.node, args.asar, "extract", asar, app], check=True)
        with open(os.path.join(app, "package.json")) as handle:
            version = json.load(handle).get("version")
        gate("app_version", version == args.version, version)
        dist = os.path.join(app, "apps/server/dist")
        client = os.path.join(dist, "client")
        server_tree, server_files = tree(dist, skip=client)
        web_tree, web_files = tree(client)
        result["hashes"] = {
            "app_asar_sha256": sha256(asar),
            "server_dist_tree_sha256": server_tree,
            "server_dist_files": server_files,
            "server_bin_mjs_sha256": sha256(os.path.join(dist, "bin.mjs")),
            "web_client_tree_sha256": web_tree,
            "web_client_files": web_files,
        }
        for name, (where, needle) in MARKERS.items():
            root, skip = (dist, client) if where == "server" else (client, None)
            gate(f"marker_{name}", contains(root, needle, skip))
        found = []
        for directory, _, files in os.walk(resources):
            for name in files:
                with open(os.path.join(directory, name), "rb") as handle:
                    blob = handle.read()
                found += [p.decode() for p in CREDENTIAL_PATTERNS if re.search(p, blob)]
        gate("no_credential_patterns", not found, sorted(set(found)) or None)

    result["failed_gates"] = failures
    with open(args.out, "w") as handle:
        json.dump(result, handle, indent=1)
    print(json.dumps({"failed_gates": failures, **result["hashes"]}, indent=1))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
