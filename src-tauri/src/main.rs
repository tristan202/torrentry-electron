// Det, som brugerfladen ikke selv kan: HTTP uden browserens begrænsninger
// (cookies, ugyldige certifikater), filer i %APPDATA% og adgangskoder i
// Windows' legitimationsadministrator. Resten af appen ligger i renderer/.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use std::{collections::HashMap, fs, path::PathBuf, sync::OnceLock, time::Duration};
use tauri::{AppHandle, Manager};

#[derive(serde::Serialize)]
struct HttpResp {
    status: u16,
    headers: HashMap<String, Vec<String>>,
    body: String, // base64
}

// To klienter, så forbindelser genbruges: [almindelig, ignorer certifikatfejl]
fn client(insecure: bool) -> &'static reqwest::Client {
    static C: OnceLock<[reqwest::Client; 2]> = OnceLock::new();
    let make = |bad| {
        reqwest::Client::builder()
            .danger_accept_invalid_certs(bad)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .build()
            .expect("HTTP-klient")
    };
    &C.get_or_init(|| [make(false), make(true)])[insecure as usize]
}

// Den inderste årsag er den nyttige, fx "Connection refused"
fn err_text(e: &dyn std::error::Error) -> String {
    let mut e = e;
    while let Some(s) = e.source() {
        e = s;
    }
    e.to_string()
}

#[tauri::command]
async fn http(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    insecure: bool,
) -> Result<HttpResp, String> {
    let m = method.parse::<reqwest::Method>().map_err(|e| e.to_string())?;
    let mut req = client(insecure).request(m, &url);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    if let Some(b) = body {
        req = req.body(B64.decode(b).map_err(|e| e.to_string())?);
    }
    let res = req.send().await.map_err(|e| err_text(&e))?;
    let status = res.status().as_u16();
    let mut h: HashMap<String, Vec<String>> = HashMap::new();
    for (k, v) in res.headers() {
        h.entry(k.as_str().to_owned()).or_default().push(String::from_utf8_lossy(v.as_bytes()).into_owned());
    }
    let bytes = res.bytes().await.map_err(|e| err_text(&e))?;
    Ok(HttpResp { status, headers: h, body: B64.encode(bytes) })
}

// Stier er relative til %APPDATA%, fx "Torrentry/servers.v3.json"
fn data_path(app: &AppHandle, rel: &str) -> Result<PathBuf, String> {
    if rel.split(['/', '\\']).any(|p| p == "..") || std::path::Path::new(rel).is_absolute() {
        return Err(format!("ugyldig sti: {rel}"));
    }
    // TORRENTRY_DATA flytter data et andet sted hen (bruges til test)
    let base = match std::env::var_os("TORRENTRY_DATA") {
        Some(d) => PathBuf::from(d),
        None => app.path().config_dir().map_err(|e| e.to_string())?,
    };
    Ok(base.join(rel))
}

#[tauri::command]
fn read_data(app: AppHandle, rel: String) -> Result<Option<String>, String> {
    Ok(fs::read_to_string(data_path(&app, &rel)?).ok())
}

#[tauri::command]
fn write_data(app: AppHandle, rel: String, text: String) -> Result<(), String> {
    let p = data_path(&app, &rel)?;
    if let Some(d) = p.parent() {
        fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("tmp");
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

fn entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("Torrentry", id).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_get(id: String) -> Option<String> {
    entry(&id).ok()?.get_password().ok()
}

// En tom adgangskode sletter den gemte
#[tauri::command]
fn secret_set(id: String, pass: String) -> Result<(), String> {
    let e = entry(&id)?;
    if pass.is_empty() {
        let _ = e.delete_credential();
        Ok(())
    } else {
        e.set_password(&pass).map_err(|e| e.to_string())
    }
}

// Adgangskoder fra Electron-versionen (2.x): safeStorage krypterer med
// AES-256-GCM ("v10" + nonce + data), og nøglen ligger DPAPI-beskyttet i
// "Local State" i samme mappe. Giver null for dem, der ikke kan læses.
#[tauri::command]
fn electron_decrypt(app: AppHandle, blobs: Vec<String>) -> Result<Vec<Option<String>>, String> {
    let dir = data_path(&app, "Torrentry")?;
    let key = electron_key(&dir);
    Ok(blobs.iter().map(|b| decrypt_blob(key.as_deref(), b)).collect())
}

fn electron_key(dir: &std::path::Path) -> Option<Vec<u8>> {
    let ls: serde_json::Value = serde_json::from_str(&fs::read_to_string(dir.join("Local State")).ok()?).ok()?;
    let enc = B64.decode(ls["os_crypt"]["encrypted_key"].as_str()?).ok()?;
    dpapi_unprotect(enc.strip_prefix(b"DPAPI")?)
}

fn decrypt_blob(key: Option<&[u8]>, b64: &str) -> Option<String> {
    use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
    let raw = B64.decode(b64).ok()?;
    let Some(rest) = raw.strip_prefix(b"v10") else {
        // ældre format: ren DPAPI
        return String::from_utf8(dpapi_unprotect(&raw)?).ok();
    };
    if rest.len() < 12 + 16 {
        return None;
    }
    let (nonce, ct) = rest.split_at(12);
    let c = Aes256Gcm::new_from_slice(key?).ok()?;
    String::from_utf8(c.decrypt(Nonce::from_slice(nonce), ct).ok()?).ok()
}

#[cfg(windows)]
fn dpapi_unprotect(data: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    unsafe {
        let inp = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        if CryptUnprotectData(&inp, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut out) == 0 {
            return None;
        }
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData as _);
        Some(v)
    }
}

#[cfg(not(windows))]
fn dpapi_unprotect(_: &[u8]) -> Option<Vec<u8>> {
    None
}

fn main() {
    tauri::Builder::default()
        // Kun én instans – en ny start henter det kørende vindue frem
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            if let Some(w) = app.get_webview_window("main") {
                w.set_title(&format!("Torrentry {}", app.package_info().version))?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![http, read_data, write_data, secret_get, secret_set, electron_decrypt])
        .run(tauri::generate_context!())
        .expect("Torrentry kunne ikke starte");
}
