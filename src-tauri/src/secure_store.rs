//! Platform-native symmetric "encrypt with the current user's
//! credentials" primitive, used for the Google cookie jar.
//!
//! **Windows** — DPAPI (`CryptProtectData`). The blob is only
//! decryptable by the same Windows user on the same machine.
//!
//! **Linux** (Raspberry Pi) — there is no DPAPI equivalent that works
//! without a session keyring, and Raspberry Pi OS Lite / kiosk setups
//! routinely run without `gnome-keyring`, so binding to libsecret would
//! make the jar undecryptable on exactly the installs this build targets.
//! Instead we encrypt with XChaCha20-Poly1305 under a key derived from
//! the host's machine id plus a per-install random salt stored `0600`
//! next to the jar. That binds the blob to *this machine and this
//! install* — copying `cookies.enc` to another Pi yields nothing — and
//! keeps the session cookies off disk in cleartext.
//!
//! Be honest about the boundary this does and doesn't draw: the salt
//! sits next to the ciphertext and the machine id is world-readable, so
//! anything running **as this user** can re-derive the key. That is the
//! same boundary DPAPI draws on Windows. It defends against a stolen SD
//! card, a backup, or another user on the Pi — not against malware
//! running as you. See `docs/raspberry-pi.md`.
//!
//! **macOS / other** — plaintext passthrough, unchanged. Not a shipped
//! target.

use std::path::PathBuf;
use std::sync::OnceLock;

/// Fixed entropy mixed into every derivation.
///
/// Keeps the historical "ytm-native" tag on purpose: this string is
/// baked into every existing encrypted cookie jar (as the DPAPI entropy
/// blob), and changing it would orphan them all. It's an opaque salt,
/// not a product name.
#[allow(dead_code)] // unused on macOS / other
const ENTROPY: &[u8] = b"ytm-native/cookies.enc v1";

/// App-data directory, needed on Linux to locate the per-install salt.
/// Set once from `setup()`; [`encrypt`] / [`decrypt`] take no app handle
/// because they run on a blocking pool with no Tauri context.
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Point the Linux key derivation at the app-data directory. Call once
/// from `setup()`, before anything reads or writes a jar. No-op on
/// platforms that don't need it; harmless to call twice (first wins).
pub fn init(app_data_dir: PathBuf) {
    let _ = DATA_DIR.set(app_data_dir);
}

// ── Windows: DPAPI ────────────────────────────────────────────────────

#[cfg(windows)]
pub fn encrypt(plain: &[u8]) -> Result<Vec<u8>, String> {
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: plain.len() as u32,
            pbData: plain.as_ptr() as *mut u8,
        };
        let ent_blob = CRYPT_INTEGER_BLOB {
            cbData: ENTROPY.len() as u32,
            pbData: ENTROPY.as_ptr() as *mut u8,
        };
        let mut out_blob: CRYPT_INTEGER_BLOB = std::mem::zeroed();
        let ok = CryptProtectData(
            &in_blob,
            ptr::null(),
            &ent_blob,
            ptr::null_mut(),
            ptr::null(),
            0,
            &mut out_blob,
        );
        if ok == 0 {
            return Err("CryptProtectData failed".into());
        }
        let data = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
        LocalFree(out_blob.pbData as _);
        Ok(data)
    }
}

#[cfg(windows)]
pub fn decrypt(encrypted: &[u8]) -> Result<Vec<u8>, String> {
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: encrypted.len() as u32,
            pbData: encrypted.as_ptr() as *mut u8,
        };
        let ent_blob = CRYPT_INTEGER_BLOB {
            cbData: ENTROPY.len() as u32,
            pbData: ENTROPY.as_ptr() as *mut u8,
        };
        let mut out_blob: CRYPT_INTEGER_BLOB = std::mem::zeroed();
        let ok = CryptUnprotectData(
            &in_blob,
            ptr::null_mut(),
            &ent_blob,
            ptr::null_mut(),
            ptr::null(),
            0,
            &mut out_blob,
        );
        if ok == 0 {
            return Err("CryptUnprotectData failed".into());
        }
        let data = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
        LocalFree(out_blob.pbData as _);
        Ok(data)
    }
}

// ── Linux: XChaCha20-Poly1305, machine + install bound ────────────────

#[cfg(target_os = "linux")]
mod linux {
    use super::{DATA_DIR, ENTROPY};
    use chacha20poly1305::aead::{Aead, KeyInit};
    use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
    use sha2::{Digest, Sha256};
    use std::path::PathBuf;

    /// Blob header. Anything without it is a jar written by an older
    /// build whose non-Windows path was a plaintext passthrough — we
    /// read those transparently and re-encrypt on the next write, so an
    /// upgrade doesn't sign the user out.
    const MAGIC: &[u8; 4] = b"YTC1";
    const NONCE_LEN: usize = 24;
    const SALT_LEN: usize = 32;

    fn salt_path() -> PathBuf {
        DATA_DIR
            .get()
            .cloned()
            .unwrap_or_else(std::env::temp_dir)
            .join("cookies.key")
    }

    /// Host identity. `/etc/machine-id` is present on Raspberry Pi OS
    /// (systemd) and stable across reboots; the D-Bus copy is the
    /// fallback for non-systemd images. If neither exists we degrade to
    /// the username, which still separates users on a shared Pi.
    fn machine_id() -> Vec<u8> {
        for p in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
            if let Ok(s) = std::fs::read_to_string(p) {
                let t = s.trim();
                if !t.is_empty() {
                    return t.as_bytes().to_vec();
                }
            }
        }
        std::env::var("USER")
            .or_else(|_| std::env::var("LOGNAME"))
            .unwrap_or_default()
            .into_bytes()
    }

    /// Per-install random salt, created on first use with `0600`. Its
    /// only job is to make the key install-specific rather than purely
    /// machine-specific, so a re-install invalidates old blobs instead
    /// of silently reusing a key.
    fn load_or_create_salt() -> Result<[u8; SALT_LEN], String> {
        let path = salt_path();
        if let Ok(bytes) = std::fs::read(&path) {
            if bytes.len() == SALT_LEN {
                let mut salt = [0u8; SALT_LEN];
                salt.copy_from_slice(&bytes);
                return Ok(salt);
            }
            // Wrong length = truncated write from a previous crash.
            // Regenerating orphans the old jar (user signs in again),
            // which beats failing every read forever.
            eprintln!("[secure-store] salt file is malformed; regenerating");
        }
        let mut salt = [0u8; SALT_LEN];
        getrandom::getrandom(&mut salt).map_err(|e| format!("getrandom: {e}"))?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {dir:?}: {e}"))?;
        }
        write_private(&path, &salt)?;
        Ok(salt)
    }

    /// Write with `0600` from the moment the file exists — not a
    /// `create` + `set_permissions` pair, which leaves a window where
    /// the key material is world-readable.
    fn write_private(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| format!("open {path:?}: {e}"))?;
        f.write_all(bytes).map_err(|e| format!("write {path:?}: {e}"))
    }

    /// Returned as a plain array rather than a `Key` so the two crates'
    /// `generic-array` versions never have to unify for this to compile.
    fn key() -> Result<[u8; 32], String> {
        let salt = load_or_create_salt()?;
        let mut h = Sha256::new();
        h.update(ENTROPY);
        h.update(machine_id());
        h.update(salt);
        Ok(h.finalize().into())
    }

    pub fn encrypt(plain: &[u8]) -> Result<Vec<u8>, String> {
        let cipher = XChaCha20Poly1305::new(Key::from_slice(&key()?));
        let mut nonce = [0u8; NONCE_LEN];
        getrandom::getrandom(&mut nonce).map_err(|e| format!("getrandom: {e}"))?;
        let ct = cipher
            .encrypt(XNonce::from_slice(&nonce), plain)
            .map_err(|e| format!("encrypt: {e}"))?;
        let mut out = Vec::with_capacity(MAGIC.len() + NONCE_LEN + ct.len());
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ct);
        Ok(out)
    }

    pub fn decrypt(encrypted: &[u8]) -> Result<Vec<u8>, String> {
        if !encrypted.starts_with(MAGIC) {
            // Legacy plaintext jar from a pre-Pi build. Accept it so the
            // upgrade doesn't look like a forced sign-out.
            return Ok(encrypted.to_vec());
        }
        let body = &encrypted[MAGIC.len()..];
        if body.len() <= NONCE_LEN {
            return Err("ciphertext truncated".into());
        }
        let (nonce, ct) = body.split_at(NONCE_LEN);
        let cipher = XChaCha20Poly1305::new(Key::from_slice(&key()?));
        cipher
            .decrypt(XNonce::from_slice(nonce), ct)
            .map_err(|_| "decrypt failed (wrong machine, or salt was rotated)".to_string())
    }
}

#[cfg(target_os = "linux")]
pub use linux::{decrypt, encrypt};

// ── Everything else: plaintext passthrough ────────────────────────────

#[cfg(not(any(windows, target_os = "linux")))]
pub fn encrypt(plain: &[u8]) -> Result<Vec<u8>, String> {
    Ok(plain.to_vec())
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn decrypt(encrypted: &[u8]) -> Result<Vec<u8>, String> {
    Ok(encrypted.to_vec())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    #[test]
    fn roundtrip_and_legacy_plaintext() {
        super::init(std::env::temp_dir().join("ytmlite-secure-store-test"));
        let plain = b"# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tx\n";
        let blob = super::encrypt(plain).expect("encrypt");
        assert_ne!(&blob[..], &plain[..], "jar must not be stored in cleartext");
        assert_eq!(super::decrypt(&blob).expect("decrypt"), plain);
        // A jar from a pre-Pi build has no header and reads back as-is.
        assert_eq!(super::decrypt(plain).expect("legacy"), plain);
    }
}
