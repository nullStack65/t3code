#!/usr/bin/env bash
# Linux x64 desktop build compiled with Ubuntu noble gcc-13 and a glibc 2.39 sysroot, so
# node-pty passes scripts/linux-glibc.ts on newer hosts and on the stock noble ARC runner
# (--provide-build-tools adds binutils/make there). Inputs are pinned; no update feed is set.
# Usage: --work SHORT_DIR --output-dir DIR --build-version X.Y.Z [--provide-build-tools] [--preflight-only]
set -euo pipefail

SNAPSHOT="20261117T000000Z"
UPSTREAM_BASE="7d32075e3757ded707914e2450c3e392a9665765" # pingdotgg/t3code v0.1.10
OFFICIAL_DEB_URL="https://github.com/pingdotgg/t3code/releases/download/v0.1.10/T3-Code-0.1.10-amd64.deb"
OFFICIAL_DEB_SHA256="c06f7eee35ad0d066ba023539c46901d2d6b9121842077f83d3b4fe7f877d360"
MAGICK_URL="https://github.com/ImageMagick/ImageMagick/releases/download/7.1.2-36/ImageMagick-7.1.2-36-portable-Q16-HDRI-linux-x64.tar.xz"
MAGICK_SHA256="72c8dd0268f824f621e1628737b79d8e80bc63a5d46a69950dabb13c5de80c91"
RUST_TARGET="x86_64-unknown-linux-gnu"

work="" out="" version="" provide_tools=0 preflight_only=0
while [ $# -gt 0 ]; do
  case "$1" in
    --work) work="$2"; shift 2 ;;
    --output-dir) out="$2"; shift 2 ;;
    --build-version) version="$2"; shift 2 ;;
    --provide-build-tools) provide_tools=1; shift ;;
    --preflight-only) preflight_only=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$work" ] && [ -n "$out" ] && [ -n "$version" ] || {
  echo "usage: $0 --work DIR --output-dir DIR --build-version X.Y.Z [--provide-build-tools] [--preflight-only]" >&2
  exit 2
}

repo="$(cd "$(dirname "$0")/../.." && pwd)"
lock="$repo/scripts/closura/noble-desktop-toolchain.lock"
fail() { echo "build-linux-desktop-noble: $*" >&2; exit 1; }

# ---- preflight -------------------------------------------------------------
[ "$(uname -s)-$(uname -m)" = "Linux-x86_64" ] || fail "needs x86_64 Linux"
missing=()
for tool in curl sha256sum dpkg-deb tar xz python3 git node; do
  command -v "$tool" >/dev/null || missing+=("$tool")
done
if [ "$provide_tools" -eq 0 ]; then
  for tool in make as ld ar readelf; do command -v "$tool" >/dev/null || missing+=("$tool"); done
fi
[ ${#missing[@]} -eq 0 ] || fail "missing host tools: ${missing[*]}${provide_tools:+ (try --provide-build-tools for binutils/make)}"
want_node="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["engines"]["node"])' "$repo/package.json")"
have_node="$(node --version | sed 's/^v//')"
[ "$have_node" = "$want_node" ] || fail "node $have_node on PATH; package.json engines require $want_node"
[ -d "$repo/node_modules" ] || fail "dependencies are not installed (run vp install)"
git -C "$repo" cat-file -e "$UPSTREAM_BASE^{commit}" 2>/dev/null \
  || fail "upstream v0.1.10 commit $UPSTREAM_BASE is not in this clone; fetch it to verify native/"
git -C "$repo" diff --quiet "$UPSTREAM_BASE" HEAD -- native \
  || fail "native/ differs from upstream v0.1.10; the official prebuilt helpers would not match this source"
for rel in native/resource-monitor/target native/hyprland-snap-shot/target native/kde-snap-shot/target; do
  git -C "$repo" check-ignore -q "$rel/$RUST_TARGET/release/x" || fail "$rel is not gitignored"
done
[ -f "$lock" ] || fail "missing $lock"
echo "preflight ok: node $have_node, native/ == upstream v0.1.10, provide-build-tools=$provide_tools"
[ "$preflight_only" -eq 1 ] && exit 0

mkdir -p "$work" "$out"
work="$(cd "$work" && pwd)"; out="$(cd "$out" && pwd)"
debs="$work/debs"; sysroot="$work/sysroot"; crt="$work/compiler-runtime"; tools="$work/build-tools"
bin="$work/bin"; tmp="$work/tmp"
mkdir -p "$debs" "$sysroot" "$crt" "$tools" "$bin" "$tmp"

fetch() { # url sha256 dest
  if [ ! -f "$3" ] || ! printf '%s  %s\n' "$2" "$3" | sha256sum -c --quiet - 2>/dev/null; then
    curl -fsSL --retry 3 --connect-timeout 20 --max-time 900 -o "$3.part" "$1"
    printf '%s  %s\n' "$2" "$3.part" | sha256sum -c --quiet - || fail "SHA-256 mismatch for $1"
    mv "$3.part" "$3"
  fi
}

# ---- noble packages (extracted, never installed) -----------------------------
while read -r group sha path pkg; do
  case "$group" in ''|'#'*) continue ;; esac
  file="$debs/$(basename "$path")"
  fetch "https://snapshot.ubuntu.com/ubuntu/$SNAPSHOT/$path" "$sha" "$file"
  case "$group" in
    sysroot) dpkg-deb -x "$file" "$sysroot" ;;
    compiler-runtime) dpkg-deb -x "$file" "$crt" ;;
    build-tools) dpkg-deb -x "$file" "$tools" ;;
    *) fail "unknown lock group $group for $pkg" ;;
  esac
done < "$lock"
ln -sfn usr/lib "$sysroot/lib"
ln -sfn usr/lib64 "$sysroot/lib64"

# cc1/cc1plus use host libraries when present; otherwise noble's (no libc in that dir).
compiler_ld=""
if ldd "$sysroot/usr/libexec/gcc/x86_64-linux-gnu/13/cc1plus" | grep -q 'not found'; then
  compiler_ld="$crt/usr/lib/x86_64-linux-gnu"
fi
tools_ld="$tools/usr/lib/x86_64-linux-gnu"
write_wrapper() { # name command-prefix ld-path
  {
    echo '#!/bin/sh'
    if [ -n "$3" ]; then echo "LD_LIBRARY_PATH=\"$3\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}\"; export LD_LIBRARY_PATH"; fi
    echo "exec $2 \"\$@\""
  } > "$bin/$1"
  chmod +x "$bin/$1"
}
cc_ld="$compiler_ld"
if [ "$provide_tools" -eq 1 ]; then cc_ld="${compiler_ld:+$compiler_ld:}$tools_ld"; fi
for name in cc gcc; do
  write_wrapper "$name" "\"$sysroot/usr/bin/x86_64-linux-gnu-gcc-13\" --sysroot=\"$sysroot\"" "$cc_ld"
done
for name in c++ g++; do
  write_wrapper "$name" "\"$sysroot/usr/bin/x86_64-linux-gnu-g++-13\" --sysroot=\"$sysroot\"" "$cc_ld"
done
{
  echo '#!/bin/sh'
  echo "PKG_CONFIG_SYSROOT_DIR=\"$sysroot\" PKG_CONFIG_LIBDIR=\"$sysroot/usr/lib/x86_64-linux-gnu/pkgconfig:$sysroot/usr/share/pkgconfig\" LD_LIBRARY_PATH=\"$tools_ld\" exec \"$tools/usr/bin/pkgconf\" \"\$@\""
} > "$bin/pkg-config"
chmod +x "$bin/pkg-config"
if [ "$provide_tools" -eq 1 ]; then
  for t in as ld ld.bfd ar ranlib nm objcopy objdump readelf strip; do
    write_wrapper "$t" "\"$tools/usr/bin/x86_64-linux-gnu-$t\"" "$tools_ld"
  done
  write_wrapper make "\"$tools/usr/bin/make\"" ""
fi

# ---- ImageMagick (Linux icon resizing) ---------------------------------------
fetch "$MAGICK_URL" "$MAGICK_SHA256" "$work/imagemagick.tar.xz"
mkdir -p "$work/imagemagick"
tar -xJf "$work/imagemagick.tar.xz" -C "$work/imagemagick"
ln -sfn "$(ls -d "$work"/imagemagick/ImageMagick-*/bin/magick)" "$bin/magick"

# ---- official v0.1.10 native helpers (native/ verified unchanged above) -------
fetch "$OFFICIAL_DEB_URL" "$OFFICIAL_DEB_SHA256" "$work/official.deb"
rm -rf "$work/official"
dpkg-deb -x "$work/official.deb" "$work/official"
res="$(ls -d "$work"/official/opt/*/resources)"
install -D -m 755 "$res/resource-monitor/t3-resource-monitor" \
  "$repo/native/resource-monitor/target/$RUST_TARGET/release/t3-resource-monitor"
install -D -m 755 "$res/hyprland-capture/t3-hyprland-snap-shot" \
  "$repo/native/hyprland-snap-shot/target/$RUST_TARGET/release/t3-hyprland-snap-shot"
install -D -m 755 "$res/kde-capture/t3-kde-snap-shot" \
  "$repo/native/kde-snap-shot/target/$RUST_TARGET/release/t3-kde-snap-shot"

# ---- build ----------------------------------------------------------------------
public_config=()
while IFS= read -r line; do public_config+=("$line"); done < <(
  grep -E '^T3CODE_(CLERK_PUBLISHABLE_KEY|CLERK_JWT_TEMPLATE|CLERK_CLI_OAUTH_CLIENT_ID|RELAY_URL)=' "$repo/.env.example"
)
[ ${#public_config[@]} -eq 4 ] || fail ".env.example does not define the four public cloud keys"

cd "$repo"
env -u T3CODE_DESKTOP_UPDATE_REPOSITORY -u GITHUB_REPOSITORY \
  "${public_config[@]}" \
  PATH="$bin:$PATH" TMPDIR="$tmp" CC="$bin/cc" CXX="$bin/c++" \
  T3CODE_TELEMETRY_CHANNEL=dev \
  T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true \
  T3CODE_DESKTOP_REUSE_LINUX_CAPTURE_HELPERS=true \
  node scripts/build-desktop-artifact.ts --platform linux --target AppImage --arch x64 \
    --build-version "$version" --output-dir "$out"

echo "artifacts:"
(cd "$out" && sha256sum -- *.AppImage *.deb)
