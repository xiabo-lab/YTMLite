# YTMLite on Raspberry Pi

The Pi build targets **Raspberry Pi 4 or 5 running 64-bit Raspberry Pi OS
(Bookworm or newer) with the desktop**. It is the same app as the Windows
build — same InnerTube client, same React UI, same yt-dlp streaming — with
the Windows-only integrations swapped for their Linux equivalents.

Read [Limitations](#limitations) before you commit to it. Several are
structural rather than "not done yet".

---

## Build

Everything is compiled on the Pi itself.

```bash
git clone <this repo> && cd YTMLite
bash scripts/setup-pi.sh     # build deps, GStreamer, Rust, Node 22, pnpm
pnpm install
pnpm tauri build
```

The `.deb` lands in `src-tauri/target/release/bundle/deb/`:

```bash
sudo apt install ./src-tauri/target/release/bundle/deb/YTMLite_*_arm64.deb
```

Notes:

- **First build takes roughly 10–15 min on a Pi 5**, longer on a Pi 4. It's
  compiling the whole Rust dependency tree including WebKit bindings.
  Incremental rebuilds are quick. (Measured: 10m51s for a cold
  `pnpm tauri build` on a Pi 5 8 GB booted from SD card, all four cores.)
- **You need ~4 GB of RAM + swap combined.** Linking is the peak. On a
  2 GB Pi the linker gets OOM-killed and reports an unhelpful
  `signal: 9`; `setup-pi.sh` checks for this and tells you how to grow
  the swap file.
- Build on an SSD or good USB drive if you have one. A slow SD card is
  the single biggest factor in build time.
- If `scripts/setup-pi.sh` fails with `bad interpreter: No such file or
  directory`, the file picked up CRLF line endings in transit — run
  `sed -i 's/\r$//' scripts/setup-pi.sh`.

For an iterative loop, `pnpm tauri dev` works normally.

---

## What changed for Linux

| Area | Windows | Raspberry Pi |
| --- | --- | --- |
| Webview | WebView2 (Chromium) | WebKitGTK 4.1 |
| Media controls | System Media Transport Controls | MPRIS (`playerctl`, panel applets, Bluetooth AVRCP) |
| Cookie jar at rest | DPAPI | XChaCha20-Poly1305, key bound to machine-id + a per-install salt |
| yt-dlp binary | `yt-dlp.exe` | `yt-dlp_linux_aarch64` (self-contained, no system Python) |
| Package | NSIS installer + in-app updater | `.deb`, updated through `apt` |
| Autostart | Registry Run key | XDG autostart `.desktop` |
| Accounts | Multiple | One at a time |

The app reports what it supports to the UI through the `platform_caps`
command (`src-tauri/src/platform.rs` ↔ `src/lib/platform.ts`), and hides
the affordances it can't honour rather than offering ones that misbehave.

---

## Limitations

### Structural — these need upstream changes to fix

**One Google account at a time.**
Multi-account requires each sign-in to run in an isolated webview profile,
so Google presents a fresh login instead of silently reusing the session
already in the browser. Tauri's `data_directory` builder option is
unsupported on Linux — every webview shares one WebKitGTK cookie store —
so a second "add account" would just re-capture account #1 and create a
duplicate row. "Add another account" is hidden on Linux, and the Rust
command rejects the call as a backstop. To switch accounts: sign out,
then sign in as the other one.

**The webview keeps a plaintext copy of your Google session.**
Our own cookie jar is encrypted (see below), but wry configures
WebKitGTK's cookie manager with `CookiePersistentStorage::Text`, so the
webview independently writes the live session to
`~/.local/share/com.fuwenxu.ytmlite/cookies` as a plaintext Netscape
jar. There is no Tauri API to disable or relocate that. The app chmods
its data directory to `0700` and the file to `0600` on every launch, so
other users on the Pi can't read it — but anything running **as you** can.
If that matters for your threat model, this build is not for you.

**Cookie encryption is weaker than on Windows.**
Windows has DPAPI, which ties the blob to the OS user account. Linux has
no equivalent that works without a session keyring, and Raspberry Pi OS
Lite / kiosk setups routinely run without `gnome-keyring` — binding to
libsecret would make the jar undecryptable on exactly the installs this
targets. Instead the jar is encrypted under a key derived from
`/etc/machine-id` plus a per-install random salt stored `0600` beside it
(`src-tauri/src/secure_store.rs`). That defends against a stolen SD card,
a cloned image, or a backup. It does **not** defend against code running
as your user, because the salt sits next to the ciphertext. Same boundary
DPAPI draws — just with a more obvious key.

**In-app updates work, but not through Tauri's updater.** That plugin can
only install AppImage bundles on Linux, and this ships a `.deb` so it
stays integrated with apt and the desktop menu. The app therefore uses
its own path on Linux (`src-tauri/src/deb_update.rs`): *⋯ → Check for
Updates* reads the newest published GitHub release, and the update banner
downloads the `.deb` and installs it with `sudo -n apt-get install`,
falling back to `pkexec` if passwordless sudo isn't configured. If
neither can elevate, the error names the command to run by hand.

The script does the same job from a terminal — useful over SSH, or when
the app won't start:

```bash
bash scripts/update-pi.sh            # install the latest release
bash scripts/update-pi.sh --check    # just report what's available
```

It pulls the prebuilt `arm64` `.deb` from the newest **published** GitHub
release (a draft release is invisible to it), compares versions with
`dpkg --compare-versions`, and installs only if the release is genuinely
newer. Takes seconds, versus the ~11 minutes a source rebuild costs. Your
library, cache and sign-in survive the upgrade.

**Tray icon: menu only.**
Linux tray icons go through AppIndicator, which delivers menu
activations but no click events. Left-clicking the icon will not raise
the window — use the icon's menu → *Show YTMLite*. The Settings copy for
"Close to tray" says so on Linux.

**32-bit Raspberry Pi OS is not supported.**
`setup-pi.sh` refuses to run on an armv7 userland. yt-dlp ships its armv7
build only as a `.zip` (needs unpacking, which the managed-binary
downloader doesn't do), and Pi 3 / Zero-class hardware is well below what
this UI needs regardless.

### Performance

**WebKitGTK is meaningfully slower than WebView2.** This is a React 19 app
with virtualized lists, blurred artwork backdrops and Motion animations —
it was tuned against Chromium. On a **Pi 5** it is comfortable: navigation
is quick, scrolling is smooth, playback is unaffected. On a **Pi 4** it is
usable but visibly heavier — expect dropped frames when scrolling long
library lists and during page transitions. Playback and audio quality are
identical on both; it's purely the UI.

**Streaming is download-then-play.** The Rust stream server has yt-dlp
fetch the whole track before serving it, so the first play of an
uncached track costs a full download. On a Pi's Wi-Fi that's usually a
second or three. It also means every played track hits the disk — if
you're on an SD card and listening for hours a day, point the cache at a
USB SSD in *Settings → Storage* to avoid chewing through write cycles.

**Wayland vs X11.** Bookworm defaults to a Wayland compositor (labwc or
wayfire) on Pi 4/5. Both work. Two Wayland-specific quirks:

- The window has no native decorations (the app draws its own title bar),
  and Wayland gives clients no resize handles in that mode. Resize with
  your compositor's modifier drag — `Super` + right-drag on the stock Pi
  setup — or use the maximize button.
- Clients can't position their own windows on Wayland, so the
  floating-player window ignores the "drop it where the cursor is"
  placement and appears wherever the compositor puts it.

### Integrations

**MPRIS needs a desktop session.** Media controls register on the session
D-Bus, which a normal desktop login has. Launched over bare SSH or on a
headless image there is no session bus, registration fails, and it's
logged and skipped — playback still works, the app just won't show up in
`playerctl` or the panel applet.

**Synced lyrics, hi-res cover art, notifications and autostart all work
unchanged.** Notifications need a notification daemon, which the Pi
desktop provides.

### Codecs

WebKit decodes `<audio>` through GStreamer, so playback depends on
plugins being installed — `setup-pi.sh` installs them and the `.deb`
declares them as dependencies. If you install by some other route and
tracks fail with an empty `MediaError`, that's a missing decoder:

```bash
sudo apt install gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
                 gstreamer1.0-plugins-bad gstreamer1.0-libav
```

Opus-in-WebM (what yt-dlp usually returns) needs `plugins-good`; the AAC
/ M4A fallback for tracks with no WebM audio needs `libav`.

---

## Troubleshooting

**Blank / white / visually corrupted window on launch.**
Almost always WebKitGTK's DMABUF renderer failing to negotiate a buffer
format with the V3D driver. The app sets
`WEBKIT_DISABLE_DMABUF_RENDERER=1` for itself at startup to avoid this.

The symptom is not always a *blank* window. Verified on a Pi 5 running
Bookworm-successor Debian 13 with the labwc Wayland compositor: launching
with `YTMLITE_ENABLE_DMABUF=1` renders the window as torn horizontal bands
of garbage pixels rather than white, while the default (workaround
active) renders correctly. If the UI looks shredded rather than empty,
this is the same bug.

If you still get a blank window, try disabling compositing too:

```bash
WEBKIT_DISABLE_COMPOSITING_MODE=1 ytmlite
```

To go the other way and test whether your Pi is fine with the default
renderer, launch with `YTMLITE_ENABLE_DMABUF=1`.

**No audio at all.** Check the track resolves first — run the app from a
terminal and look for `[stream]` lines. If downloads complete but nothing
plays, it's the codec issue above. If downloads fail, it's yt-dlp: the
managed copy lives in `~/.local/share/com.fuwenxu.ytmlite/bin/yt-dlp`
and self-updates every ~3 days.

**The library goes empty after a while.** The session-keeper refresh has
stopped renewing the Google session. Sign out and back in. Worth filing
with the log output if it recurs.

**Build dies with `signal: 9` or `collect2: fatal error`.** Out of memory
while linking. Grow the swap file (see [Build](#build)).

**Tray icon missing.** Confirm your panel has a StatusNotifier/tray
plugin enabled. On the stock Pi panel it's *Add / Remove Panel Items →
System Tray*.
