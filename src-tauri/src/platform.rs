//! Per-platform capability reporting and Linux/Raspberry Pi startup fixups.
//!
//! The app was written Windows-first. Rather than let the Linux build
//! ship features that silently misbehave, the frontend asks Rust what
//! this build can actually do (`platform_caps`) and hides the rest. Each
//! `false` below is a real, documented gap — see `docs/raspberry-pi.md`.

use serde::Serialize;

/// What the running build supports. Serialized to the frontend once at
/// boot and cached; nothing here changes at runtime.
#[derive(Debug, Clone, Serialize)]
pub struct Caps {
    /// `"windows"` | `"linux"` | `"macos"` | `"unknown"`.
    pub os: &'static str,
    /// Can the user hold more than one signed-in Google account?
    ///
    /// Requires per-webview profile isolation so a second sign-in starts
    /// from a blank Google session. Tauri's `data_directory` builder
    /// option is unsupported on Linux (all webviews share one WebKitGTK
    /// cookie store), so on Linux a second "add account" would just
    /// re-capture the session already signed in and produce a duplicate
    /// row. We surface a single account instead of a broken multi.
    #[serde(rename = "multiAccount")]
    pub multi_account: bool,
    /// Whether **Tauri's updater plugin** can install a new version.
    /// It only supports AppImage on Linux and we ship a `.deb`.
    ///
    /// This being false no longer means "no in-app updates": on Linux
    /// the frontend falls back to the `deb_update_*` commands, which
    /// fetch the release and hand the package to apt. See
    /// `deb_update.rs` and `src/lib/updater.ts`.
    #[serde(rename = "inAppUpdates")]
    pub in_app_updates: bool,
    /// Whether left-clicking the tray icon raises the window. Linux tray
    /// support goes through AppIndicator, which only delivers menu
    /// activations — there is no click event to hook.
    #[serde(rename = "trayLeftClick")]
    pub tray_left_click: bool,
    /// Human-readable name of the OS media-control integration, for the
    /// Settings copy ("Windows SMTC" vs "MPRIS").
    #[serde(rename = "mediaControls")]
    pub media_controls: &'static str,
}

pub const CAPS: Caps = Caps {
    os: if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "unknown"
    },
    multi_account: cfg!(windows),
    in_app_updates: cfg!(windows),
    tray_left_click: cfg!(windows),
    media_controls: if cfg!(windows) {
        "Windows SMTC"
    } else if cfg!(target_os = "linux") {
        "MPRIS"
    } else {
        "none"
    },
};

#[tauri::command]
pub fn platform_caps() -> Caps {
    CAPS.clone()
}

/// Linux-only environment fixups that must run before GTK/WebKit is
/// initialized — i.e. at the very top of `run()`, before the builder.
///
/// WebKitGTK's DMABUF renderer is the single most common cause of a
/// blank white Tauri window on Raspberry Pi OS and on VMs: it negotiates
/// a buffer format the V3D driver / compositor combination can't
/// present, and the page renders to nothing with no error. Disabling it
/// falls back to a compatible path that still uses the GPU for
/// compositing. Set `YTMLITE_ENABLE_DMABUF=1` to keep the default
/// renderer if your Pi is happy with it.
///
/// Only fills in variables the user hasn't set, so an explicit
/// `WEBKIT_DISABLE_DMABUF_RENDERER=0` in the environment still wins.
pub fn init_env() {
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("YTMLITE_ENABLE_DMABUF").is_none()
            && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
        {
            // SAFETY: single-threaded here — this runs as the first
            // statement of `run()`, before any window, plugin or async
            // runtime exists.
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }
}

/// Tighten permissions on the app-data directory.
///
/// Necessary on Linux because we are not the only writer there: wry
/// configures WebKitGTK's cookie manager with
/// `CookiePersistentStorage::Text`, so the webview mirrors the live
/// Google session into `<app-data>/cookies` as a **plaintext** jar —
/// next to, and independent of, our encrypted one. We can't turn that
/// off through Tauri, so the next best thing is to make the directory
/// untraversable by other users on the Pi (`0700`) and the file itself
/// owner-only (`0600`).
///
/// Best-effort: a chmod failure is logged, not fatal. Re-applied on
/// every launch because WebKit recreates the file when it's missing.
pub fn harden_data_dir(dir: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let chmod = |p: &std::path::Path, mode: u32| {
            if !p.exists() {
                return;
            }
            if let Err(e) = std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)) {
                eprintln!("[platform] chmod {mode:o} {p:?}: {e}");
            }
        };
        chmod(dir, 0o700);
        chmod(&dir.join("cookies"), 0o600);
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// Sign the shared WebKitGTK cookie store out of Google.
///
/// On Windows every account owns an isolated webview profile, so
/// deleting `accounts/<id>/` is a complete sign-out. Linux has one
/// shared store (see [`Caps::multi_account`]): deleting our jar leaves
/// the *webview* still logged in, so the next "Sign in" would skip the
/// password prompt and instantly re-capture the account the user just
/// removed. Driving a hidden window through Google's logout URL is the
/// only handle Tauri gives us on that store.
///
/// Best-effort and bounded: a failure here means the user sees Google's
/// account chooser instead of a password prompt on the next sign-in,
/// which is annoying but not wrong.
#[cfg(target_os = "linux")]
pub async fn webview_signout(app: &tauri::AppHandle) {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    // Close the session-keeper first — it holds the same store open and
    // would race the logout by re-authenticating from its live session.
    for (label, w) in app.webview_windows() {
        if label.starts_with("keeper-") {
            let _ = w.close();
        }
    }

    let Ok(url) = "https://accounts.google.com/Logout".parse::<tauri::Url>() else {
        return;
    };
    let win = WebviewWindowBuilder::new(app, "logout", WebviewUrl::External(url))
        .title("Signing out…")
        .visible(false)
        .decorations(false)
        .focused(false)
        .skip_taskbar(true)
        .inner_size(800.0, 600.0)
        .build();
    let Ok(win) = win else {
        eprintln!("[auth] linux sign-out: could not open logout window");
        return;
    };
    let _ = win.hide();
    // Google's logout is a redirect chain; give it a few seconds rather
    // than polling, since there is no cookie state that reliably marks
    // "done" (the auth cookies disappear early in the chain).
    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    let _ = win.close();
}

/// No-op on platforms with per-account webview profiles.
#[cfg(not(target_os = "linux"))]
pub async fn webview_signout(_app: &tauri::AppHandle) {}
