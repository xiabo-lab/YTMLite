#!/usr/bin/env bash
#
# One-shot build-environment setup for YTMLite on Raspberry Pi OS
# (64-bit, Bookworm or newer) running on a Pi 4 or Pi 5.
#
#   curl -fsSL .../setup-pi.sh | bash     # or just: bash scripts/setup-pi.sh
#
# Installs the Tauri/WebKitGTK build dependencies, the GStreamer decoders
# playback needs, a Rust toolchain and a current Node, then prints the
# build command. Idempotent — safe to re-run.
#
# See docs/raspberry-pi.md for what this build does and doesn't support.

set -euo pipefail

log()  { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\n\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

# ── Preflight ─────────────────────────────────────────────────────────

[ "$(id -u)" -ne 0 ] || die "Run as your normal user, not root (the script calls sudo itself)."

ARCH="$(uname -m)"
case "$ARCH" in
  aarch64) ;;
  armv7l|armv6l)
    die "This is a 32-bit userland ($ARCH). YTMLite targets 64-bit Raspberry Pi OS.
     Reflash with the 64-bit image, or see docs/raspberry-pi.md for why
     32-bit is not supported."
    ;;
  *) warn "Unexpected architecture '$ARCH' — continuing, but this is untested." ;;
esac

command -v apt-get >/dev/null || die "This script expects a Debian-based OS (Raspberry Pi OS / Ubuntu)."

# The build peaks around 3-4 GB of RAM while linking the Rust binary.
# A 2 GB Pi with the stock 100 MB swap file reliably OOM-kills the
# linker, and the failure looks like a mysterious "signal: 9" from cc.
mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
swap_mb=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$((mem_mb + swap_mb))" -lt 4000 ]; then
  warn "Only ${mem_mb} MB RAM + ${swap_mb} MB swap. Linking will likely be OOM-killed.
     Raise the swap file first:
       sudo dphys-swapfile swapoff
       sudo sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=4096/' /etc/dphys-swapfile
       sudo dphys-swapfile setup && sudo dphys-swapfile swapon"
  read -r -p "Continue anyway? [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || exit 1
fi

# ── System packages ───────────────────────────────────────────────────

log "Installing build + runtime dependencies (sudo)"
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  build-essential curl wget file git pkg-config \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libssl-dev \
  libxdo-dev \
  libdbus-1-dev \
  gstreamer1.0-plugins-base \
  gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad \
  gstreamer1.0-libav \
  gstreamer1.0-alsa \
  gstreamer1.0-pulseaudio

# Why each of the non-obvious ones:
#   libwebkit2gtk-4.1-dev  the webview Tauri renders the UI in
#   libayatana-appindicator3-dev  the tray icon
#   libxdo-dev             Tauri's tray/window activation on X11
#   libdbus-1-dev          souvlaki's MPRIS backend (media keys, playerctl)
#   gstreamer1.0-*         WebKit decodes <audio> through GStreamer, and
#                          the Opus/WebM and AAC/M4A streams yt-dlp hands
#                          us need plugins-good and libav respectively.
#                          Without these, playback fails silently with an
#                          empty MediaError.

# ── Rust ──────────────────────────────────────────────────────────────

if command -v cargo >/dev/null; then
  log "Rust already installed: $(cargo --version)"
else
  log "Installing Rust (rustup, stable)"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi

# ── Node + pnpm ───────────────────────────────────────────────────────

node_major=0
if command -v node >/dev/null; then
  node_major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
fi
# Vite 7 requires Node >= 20.19. Raspberry Pi OS Bookworm ships Node 18.
if [ "$node_major" -lt 20 ]; then
  log "Installing Node 22 (found: ${node_major:-none}, need >= 20)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  log "Node already suitable: $(node -v)"
fi

log "Enabling pnpm via corepack"
sudo corepack enable
corepack prepare pnpm@latest --activate

# ── Done ──────────────────────────────────────────────────────────────

log "Setup complete."
cat <<'EOF'

Next, from the repo root:

    pnpm install
    pnpm tauri build          # produces src-tauri/target/release/bundle/deb/*.deb

Expect roughly 10-15 min for the first Rust build on a Pi 5 (longer on a
Pi 4) — it is compiling WebKit bindings and the whole dependency tree.
Rebuilds after that are incremental and quick.

Then install it:

    sudo apt install ./src-tauri/target/release/bundle/deb/YTMLite_*_arm64.deb

For an iterative dev loop instead:

    pnpm tauri dev

If the window comes up blank, see the "Blank window" section of
docs/raspberry-pi.md.
EOF
