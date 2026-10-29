//! Device tokens live in the OS keychain (Keychain on macOS, Credential
//! Manager on Windows, Secret Service on Linux), never in a file the app
//! owns. The frontend sees three verbs and a key; the service name is fixed.

use keyring::{Entry, Error as KeyringError};

const SERVICE: &str = "sh.mercuryagent.desktop";
const MAX_KEY_LEN: usize = 128;
const MAX_VALUE_LEN: usize = 4096;

fn entry(key: &str) -> Result<Entry, String> {
    let valid = !key.is_empty()
        && key.len() <= MAX_KEY_LEN
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'));
    if !valid {
        return Err("bad secret key".to_string());
    }
    Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    match entry(&key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    if value.len() > MAX_VALUE_LEN {
        return Err("secret too large".to_string());
    }
    entry(&key)?.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    match entry(&key)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
