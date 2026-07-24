//! In-app updates for the Debian-package build (the Raspberry Pi).
//!
//! Tauri's own updater can only install AppImage bundles on Linux and we
//! ship a `.deb`, so the plugin's install path is unavailable — see
//! `platform::Caps::in_app_updates`. This module is the replacement: it
//! does what `scripts/update-pi.sh` does (read the latest GitHub
//! release, download the `.deb` for this architecture, hand it to apt)
//! but from inside the app, reporting progress to the same update banner
//! the Windows updater drives.
//!
//! The frontend never supplies a URL. `install` re-reads the release
//! itself and picks the asset, so "install a package as root" can't be
//! pointed at an arbitrary file by anything running in the webview.

use serde::Serialize;
use std::path::PathBuf;
use std::time::Duration;
use tauri::Emitter;
use tokio::io::AsyncWriteExt;

const RELEASES_API: &str =
    "https://api.github.com/repos/xiabo-lab/YTMLite/releases/latest";
/// GitHub's API rejects requests without one.
const USER_AGENT: &str = "YTMLite-updater";
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);

/// Emitted while the package downloads so the banner can show a bar.
const PROGRESS_EVENT: &str = "deb-update-progress";

#[derive(Debug, Clone, Serialize)]
pub struct DebUpdate {
    /// Release version without the leading `v`.
    pub version: String,
    /// Bytes, straight from the release asset — 0 if GitHub omits it.
    pub size: u64,
}

#[derive(Clone, Serialize)]
struct Progress {
    downloaded: u64,
    total: u64,
}

/// `.deb` architecture suffix for the running build. `None` on
/// architectures we don't publish a package for.
fn deb_arch() -> Option<&'static str> {
    match std::env::consts::ARCH {
        "aarch64" => Some("arm64"),
        "x86_64" => Some("amd64"),
        "arm" => Some("armhf"),
        _ => None,
    }
}

/// Numeric, component-wise version compare — `0.1.10` is newer than
/// `0.1.9`, which a string compare gets wrong. Non-numeric suffixes are
/// ignored rather than guessed at; we only ever publish `x.y.z`.
fn is_newer(candidate: &str, current: &str) -> bool {
    let parts = |v: &str| -> Vec<u64> {
        v.split('.')
            .map(|p| {
                p.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse()
                    .unwrap_or(0)
            })
            .collect()
    };
    let (a, b) = (parts(candidate), parts(current));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

/// The latest published release's version + `.deb` asset URL, or `None`
/// when there's nothing published for this architecture.
async fn latest_asset() -> Result<Option<(String, String, u64)>, String> {
    let Some(arch) = deb_arch() else {
        return Ok(None);
    };
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    // `.text()` + serde_json rather than `.json()`: reqwest is built
    // with default-features off (see Cargo.toml) and its `json` feature
    // isn't among the ones we enable.
    let text = client
        .get(RELEASES_API)
        .send()
        .await
        .map_err(|e| format!("request: {e}"))?
        .error_for_status()
        .map_err(|e| format!("github: {e}"))?
        .text()
        .await
        .map_err(|e| format!("read: {e}"))?;
    let body: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("parse: {e}"))?;

    let tag = body
        .get("tag_name")
        .and_then(|t| t.as_str())
        .ok_or("release has no tag_name")?;
    let version = tag.trim_start_matches('v').to_string();

    let suffix = format!("_{arch}.deb");
    let asset = body
        .get("assets")
        .and_then(|a| a.as_array())
        .and_then(|assets| {
            assets.iter().find(|a| {
                a.get("name")
                    .and_then(|n| n.as_str())
                    .is_some_and(|n| n.ends_with(&suffix))
            })
        });
    let Some(asset) = asset else {
        return Ok(None);
    };
    let url = asset
        .get("browser_download_url")
        .and_then(|u| u.as_str())
        .ok_or("asset has no download url")?
        .to_string();
    let size = asset.get("size").and_then(|s| s.as_u64()).unwrap_or(0);
    Ok(Some((version, url, size)))
}

/// Is there a newer published release than the running build?
#[tauri::command]
pub async fn deb_update_check() -> Result<Option<DebUpdate>, String> {
    let Some((version, _url, size)) = latest_asset().await? else {
        return Ok(None);
    };
    if !is_newer(&version, env!("CARGO_PKG_VERSION")) {
        return Ok(None);
    }
    Ok(Some(DebUpdate { version, size }))
}

/// Download the latest `.deb` and install it. Returns the version that
/// was installed; the caller restarts the app to run it.
#[tauri::command]
pub async fn deb_update_install(app: tauri::AppHandle) -> Result<String, String> {
    let Some((version, url, size)) = latest_asset().await? else {
        return Err("No package published for this architecture.".into());
    };
    if !is_newer(&version, env!("CARGO_PKG_VERSION")) {
        return Err(format!("Already on {version}."));
    }

    // Staged in /tmp on purpose: apt drops privileges to the `_apt` user
    // to fetch, and it can't traverse a 0700 home directory — installing
    // from ~/ works but prints a confusing "download is performed
    // unsandboxed" warning. Same reasoning as scripts/update-pi.sh.
    let deb: PathBuf = std::env::temp_dir().join(format!("YTMLite_{version}.deb"));
    download(&app, &url, &deb, size).await?;

    let result = install_package(&deb).await;
    let _ = tokio::fs::remove_file(&deb).await;
    result?;
    Ok(version)
}

async fn download(
    app: &tauri::AppHandle,
    url: &str,
    dest: &PathBuf,
    total: u64,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let fetch = async {
        let mut resp = client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("request: {e}"))?
            .error_for_status()
            .map_err(|e| format!("download: {e}"))?;
        // Prefer the real content-length; the asset size is a hint.
        let total = resp.content_length().unwrap_or(total);
        let mut file = tokio::fs::File::create(dest)
            .await
            .map_err(|e| format!("create {dest:?}: {e}"))?;
        let mut downloaded: u64 = 0;
        let mut last_emit: u64 = 0;
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| format!("read body: {e}"))?
        {
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("write: {e}"))?;
            downloaded += chunk.len() as u64;
            // Throttle to ~every 256 KB: the banner can't show more
            // resolution than that and each emit crosses the IPC bridge.
            if downloaded - last_emit >= 256 * 1024 || downloaded == total {
                last_emit = downloaded;
                let _ = app.emit(PROGRESS_EVENT, Progress { downloaded, total });
            }
        }
        file.flush().await.map_err(|e| format!("flush: {e}"))?;
        Ok::<(), String>(())
    };

    match tokio::time::timeout(DOWNLOAD_TIMEOUT, fetch).await {
        Err(_) => {
            let _ = tokio::fs::remove_file(dest).await;
            Err("Download timed out.".into())
        }
        Ok(Err(e)) => {
            let _ = tokio::fs::remove_file(dest).await;
            Err(e)
        }
        Ok(Ok(())) => Ok(()),
    }
}

/// Hand the package to apt with elevated privileges.
///
/// `sudo -n` first (it's how the Pi is normally set up, and it needs no
/// interaction), then `pkexec`, which pops the desktop's own
/// authentication dialog. If neither is available we say so and name the
/// command to run by hand rather than failing silently — installing a
/// system package is not something the app can talk its way into.
async fn install_package(deb: &PathBuf) -> Result<(), String> {
    let path = deb.to_string_lossy().to_string();

    // No TTY here, so debconf must not try to open one.
    let sudo = tokio::process::Command::new("sudo")
        .args(["-n", "apt-get", "install", "-y", &path])
        .env("DEBIAN_FRONTEND", "noninteractive")
        .output()
        .await;
    if let Ok(out) = &sudo {
        if out.status.success() {
            return Ok(());
        }
    }

    let pkexec = tokio::process::Command::new("pkexec")
        .args(["apt-get", "install", "-y", &path])
        .env("DEBIAN_FRONTEND", "noninteractive")
        .output()
        .await;
    match pkexec {
        Ok(out) if out.status.success() => Ok(()),
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let detail = stderr.lines().last().unwrap_or("").trim();
            Err(format!(
                "Install needs administrator rights. {detail} Run: sudo apt-get install -y {path}"
            ))
        }
        Err(_) => Err(format!(
            "Couldn't elevate to install the package. Run: sudo apt-get install -y {path}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::is_newer;

    #[test]
    fn compares_numerically_not_lexically() {
        assert!(is_newer("0.1.10", "0.1.9"));
        assert!(is_newer("0.2.0", "0.1.99"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(!is_newer("0.1.4", "0.1.4"));
        assert!(!is_newer("0.1.3", "0.1.4"));
    }

    #[test]
    fn tolerates_missing_and_odd_components() {
        assert!(is_newer("0.2", "0.1.9"));
        assert!(!is_newer("0.1", "0.1.0"));
        assert!(is_newer("0.1.5-rc1", "0.1.4"));
    }
}
