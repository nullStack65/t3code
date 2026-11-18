#!/usr/bin/env bash
# Unsigned macOS arm64 desktop build for an Apple Silicon host (bash 3.2 compatible), with pinned
# inputs, no update feed, and gates on version, bundle id, arch, signature, features and the
# server/web bundles of the Linux reference build of the same app source.
# Usage: --work DIR --output-dir DIR --build-version X.Y.Z [--target zip|dmg] [--preflight-only]
set -euo pipefail

UPSTREAM_BASE="7d32075e3757ded707914e2450c3e392a9665765" # pingdotgg/t3code v0.1.10
OFFICIAL_ZIP_URL="https://github.com/pingdotgg/t3code/releases/download/v0.1.10/T3-Code-0.1.10-arm64.zip"
OFFICIAL_ZIP_SHA256="3d34c9ef7956495a2c830d3280c217c299bae47cb2b9144152607f68174cf116"
MONITOR_MEMBER="T3 Code (Beta).app/Contents/Resources/resource-monitor/t3-resource-monitor"
MONITOR_SHA256="f021339a35a894cae92842aa463c6cc2ed4c1b99ad36007e28f81eb15c34186f"
RUST_TARGET="aarch64-apple-darwin"
BUNDLE_ID="com.t3tools.t3code"
APP_NAME="T3 Code (Beta)"
# Linux reference build of the same app source; upstream's official 0.1.10 Linux and macOS
# apps carry byte-identical bundled server and web trees.
REFERENCE_COMMIT="09531d17b2e11ba84defa47b326b149321e573af"
REFERENCE_SERVER_TREE="b7e326c1a66c308ff47db2cb27d8bd4fa7822dc19fd0fa9cc425c9ede02d7f74"
REFERENCE_SERVER_BIN="a3e0ee70898c631ee73f827c8cedaf3e2a0e14bb75160710b5a9527e4ca7791f"
REFERENCE_WEB_TREE="9f66fd68570234545f25336a2cf280d1ef584d64ae5b1a29794f595b3fb3f73e"

work="" out="" version="" target="zip" preflight_only=0
while [ $# -gt 0 ]; do
  case "$1" in
    --work) work="$2"; shift 2 ;;
    --output-dir) out="$2"; shift 2 ;;
    --build-version) version="$2"; shift 2 ;;
    --target) target="$2"; shift 2 ;;
    --preflight-only) preflight_only=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$work" ] && [ -n "$out" ] && [ -n "$version" ] || {
  echo "usage: $0 --work DIR --output-dir DIR --build-version X.Y.Z [--target zip|dmg] [--preflight-only]" >&2
  exit 2
}
case "$target" in zip|dmg) ;; *) echo "--target must be zip or dmg" >&2; exit 2 ;; esac

repo="$(cd "$(dirname "$0")/../.." && pwd)"
fail() { echo "build-mac-arm64-desktop: $*" >&2; exit 1; }
sha() { shasum -a 256 "$1" | cut -c1-64; }

# ---- preflight (Air-only gate) ------------------------------------------------
[ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ] || fail "needs an Apple Silicon macOS host"
macos="$(sw_vers -productVersion)"
[ "${macos%%.*}" -ge 13 ] || fail "macOS $macos is older than the app's 13.0 minimum"
missing=""
for tool in xcrun clang clang++ make sips python3 curl shasum ditto git node codesign lipo otool; do
  command -v "$tool" >/dev/null || missing="$missing $tool"
done
[ -z "$missing" ] || fail "missing host tools:$missing (install Xcode Command Line Tools)"
xcode-select -p >/dev/null || fail "no active developer directory (xcode-select --install)"
xcrun --find iconutil >/dev/null || fail "iconutil not found"
want_node="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["engines"]["node"])' "$repo/package.json")"
have_node="$(node --version | sed 's/^v//')"
[ "$have_node" = "$want_node" ] || fail "node $have_node on PATH; package.json engines require $want_node"
[ -d "$repo/node_modules" ] || fail "dependencies are not installed (run vp install)"
git -C "$repo" diff --quiet HEAD -- || fail "tracked files have local changes"
git -C "$repo" cat-file -e "$UPSTREAM_BASE^{commit}" 2>/dev/null || fail "upstream v0.1.10 commit is not in this clone"
git -C "$repo" diff --quiet "$UPSTREAM_BASE" HEAD -- native \
  || fail "native/ differs from upstream v0.1.10; the official resource monitor would not match"
git -C "$repo" check-ignore -q "native/resource-monitor/target/$RUST_TARGET/release/x" \
  || fail "native/resource-monitor/target is not gitignored"

export SDKROOT="${SDKROOT:-$(xcrun --sdk macosx --show-sdk-path)}"
probe_dir="$(mktemp -d)"
printf '#include <cstdlib>\n#include <string>\n#include <vector>\nint main(){std::vector<std::string> v{"t3"};return v.size()==1?EXIT_SUCCESS:EXIT_FAILURE;}\n' > "$probe_dir/p.cc"
probe() { clang++ $1 -std=c++20 -o "$probe_dir/p" "$probe_dir/p.cc" 2>"$probe_dir/err" && "$probe_dir/p"; }
if [ -z "${CXXFLAGS:-}" ]; then
  if probe "-isysroot $SDKROOT"; then CXXFLAGS="-isysroot $SDKROOT"
  elif probe "-isysroot $SDKROOT -I$SDKROOT/usr/include/c++/v1"; then CXXFLAGS="-isysroot $SDKROOT -I$SDKROOT/usr/include/c++/v1"
  else fail "clang++ cannot build C++ against $SDKROOT; set SDKROOT/CXXFLAGS as recorded for this host"; fi
else
  probe "$CXXFLAGS" || fail "clang++ cannot build C++ with the given CXXFLAGS"
fi
export CXXFLAGS
rm -rf "$probe_dir"
echo "preflight ok: macOS $macos arm64, node $have_node, native/ == v0.1.10, SDKROOT=$SDKROOT, CXXFLAGS=$CXXFLAGS"
[ "$preflight_only" -eq 1 ] && exit 0

mkdir -p "$work" "$out"
work="$(cd "$work" && pwd)"; out="$(cd "$out" && pwd)"
[ -z "$(ls -A "$out")" ] || fail "output directory $out is not empty"

# ---- official v0.1.10 resource monitor -----------------------------------------
zip="$work/official-arm64.zip"
if [ ! -f "$zip" ] || [ "$(sha "$zip")" != "$OFFICIAL_ZIP_SHA256" ]; then
  curl -fsSL --retry 3 --connect-timeout 20 --max-time 1800 -o "$zip.part" "$OFFICIAL_ZIP_URL"
  [ "$(sha "$zip.part")" = "$OFFICIAL_ZIP_SHA256" ] || fail "official zip SHA-256 mismatch"
  mv "$zip.part" "$zip"
fi
monitor="$repo/native/resource-monitor/target/$RUST_TARGET/release/t3-resource-monitor"
mkdir -p "$(dirname "$monitor")"
python3 -I -c 'import sys,zipfile; open(sys.argv[3],"wb").write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))' \
  "$zip" "$MONITOR_MEMBER" "$monitor"
chmod 755 "$monitor"
[ "$(sha "$monitor")" = "$MONITOR_SHA256" ] || fail "resource monitor SHA-256 mismatch"

# ---- build -----------------------------------------------------------------------
public_config=()
while IFS= read -r line; do public_config+=("$line"); done < <(
  grep -E '^T3CODE_(CLERK_PUBLISHABLE_KEY|CLERK_JWT_TEMPLATE|CLERK_CLI_OAUTH_CLIENT_ID|RELAY_URL)=' "$repo/.env.example"
)
[ ${#public_config[@]} -eq 4 ] || fail ".env.example does not define the four public cloud keys"
cd "$repo"
env -u T3CODE_DESKTOP_UPDATE_REPOSITORY -u GITHUB_REPOSITORY \
  "${public_config[@]}" SDKROOT="$SDKROOT" CXXFLAGS="$CXXFLAGS" \
  T3CODE_TELEMETRY_CHANNEL=dev T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true \
  node scripts/build-desktop-artifact.ts --platform mac --target "$target" --arch arm64 \
    --build-version "$version" --output-dir "$out"

# ---- qualify -----------------------------------------------------------------------
artifact="$(ls "$out"/*."$target" | head -1)"
[ -f "$artifact" ] || fail "no .$target artifact in $out"
verify="$work/verify"; rm -rf "$verify"; mkdir -p "$verify"
if [ "$target" = zip ]; then
  ditto -x -k "$artifact" "$verify"
else
  hdiutil attach -nobrowse -readonly -mountpoint "$work/mnt" "$artifact" >/dev/null
  ditto "$work/mnt/$APP_NAME.app" "$verify/$APP_NAME.app"
  hdiutil detach "$work/mnt" >/dev/null
fi
app="$verify/$APP_NAME.app"
[ "$(lipo -archs "$app/Contents/MacOS/$APP_NAME")" = arm64 ] || fail "main executable is not arm64-only"
pty="$app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node"
[ "$(lipo -archs "$pty")" = arm64 ] || fail "compiled node-pty is not arm64"
codesign --verify --deep --strict "$app" || fail "codesign verification failed"
pty_minos="$(otool -l "$pty" | awk '/LC_BUILD_VERSION/{f=1} f&&/minos/{print $2; exit}')"
asar="$(ls "$repo"/node_modules/.pnpm/@electron+asar@*/node_modules/@electron/asar/bin/asar.mjs | head -1)"
python3 -I "$repo/scripts/closura/qualify-desktop-app.py" \
  --resources "$app/Contents/Resources" --info-plist "$app/Contents/Info.plist" --bundle-id "$BUNDLE_ID" \
  --node "$(command -v node)" --asar "$asar" --version "$version" --out "$out/manifest.json" \
  --meta "source_commit=$(git rev-parse HEAD)" --meta "source_tree=$(git rev-parse 'HEAD^{tree}')" \
  --meta "artifact=$(basename "$artifact")" --meta "artifact_sha256=$(sha "$artifact")" \
  --meta "host_macos=$macos" --meta "clang=$(clang --version | head -1)" --meta "node=$have_node" \
  --meta "sdkroot=$SDKROOT" --meta "cxxflags=$CXXFLAGS" --meta "pty_node_minos=$pty_minos" \
  --meta "signature=$(codesign -dv "$app" 2>&1 | grep -E '^(Signature|TeamIdentifier)=' | tr '\n' ' ')" \
  --meta "flags=--platform mac --target $target --arch arm64 --build-version $version; T3CODE_TELEMETRY_CHANNEL=dev; T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true; public config from .env.example; no update repository"

if git diff --quiet "$REFERENCE_COMMIT" HEAD -- . ':!scripts/closura' ':!.github' 2>/dev/null; then
  python3 -I - "$out/manifest.json" "$REFERENCE_SERVER_TREE" "$REFERENCE_SERVER_BIN" "$REFERENCE_WEB_TREE" <<'EOF'
import json, sys
h = json.load(open(sys.argv[1]))["hashes"]
want = dict(zip(("server_dist_tree_sha256", "server_bin_mjs_sha256", "web_client_tree_sha256"), sys.argv[2:]))
bad = [k for k, v in want.items() if h[k] != v]
sys.exit(f"bundles differ from the Linux reference: {bad}" if bad else 0)
EOF
  echo "bundled server and web match the Linux reference build of $REFERENCE_COMMIT"
else
  echo "warning: app source differs from $REFERENCE_COMMIT; reference bundle comparison skipped" >&2
fi
echo "artifact: $artifact"
echo "sha256:   $(sha "$artifact")"
echo "manifest: $out/manifest.json"
