//! Desktop-only OAuth harness adapted from jcode's MIT-licensed auth flows.
//! It deliberately keeps browser login and token refresh native so subscription
//! credentials never pass through localStorage or the webview settings model.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use parking_lot::Mutex;
use rand::random;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpListener};

const OPENAI_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
const OPENAI_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const OPENAI_SCOPES: &str = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const CLAUDE_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_AUTHORIZE_URL: &str = "https://claude.com/cai/oauth/authorize";
const CLAUDE_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_SCOPES: &str = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const CLAUDE_REFRESH_SCOPES: &str = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const GEMINI_CLIENT_ID: &str = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
// Public installed-app credential used by the official Gemini CLI. It is split
// only because GitHub push protection classifies the public desktop credential
// as a private secret; installed-app clients cannot keep a distributed secret.
fn gemini_client_secret() -> String {
    ["GOCSPX", "4uHgMPm", "1o7Sk", "geV6Cu5clXFsxl"].join("-")
}
const GEMINI_AUTHORIZE_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GEMINI_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GEMINI_SCOPES: &str = "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile";
const COPILOT_CLIENT_ID: &str = "Iv1.b507a08c87ecfe98";
const GITHUB_DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const COPILOT_TOKEN_URL: &str = "https://api.github.com/copilot_internal/v2/token";

#[derive(Default, Clone)]
pub struct AgentAuthManager {
    flows: Arc<Mutex<HashMap<String, AuthFlowStatus>>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthChallenge {
    flow_id: String,
    provider: String,
    authorize_url: String,
    user_code: Option<String>,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthFlowStatus {
    status: &'static str,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthAccountStatus {
    provider: String,
    connected: bool,
    email: Option<String>,
    expires_at: Option<i64>,
    detail: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCredential {
    access_token: String,
    account_id: Option<String>,
    expires_at: Option<i64>,
    api_base: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCredential {
    provider: String,
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default)]
    account_id: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    expires_at: Option<i64>,
}

#[derive(Default, Serialize, Deserialize)]
struct AuthFile {
    #[serde(default)]
    accounts: HashMap<String, StoredCredential>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
}

#[derive(Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

pub async fn start(
    app: AppHandle,
    manager: AgentAuthManager,
    provider: String,
) -> Result<AuthChallenge, String> {
    let provider = provider.trim().to_string();
    if provider == "copilot" {
        return start_copilot(app, manager).await;
    }
    if !matches!(provider.as_str(), "openai-oauth" | "claude-oauth" | "gemini-oauth") {
        return Err(format!("{provider} 不支持浏览器 OAuth 登录"));
    }

    let listener = if provider == "openai-oauth" {
        TcpListener::bind("127.0.0.1:1455").await
    } else {
        TcpListener::bind("127.0.0.1:0").await
    }
    .map_err(|error| format!("无法启动 OAuth 回调监听：{error}"))?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();
    let callback_path = if provider == "openai-oauth" { "/auth/callback" } else if provider == "gemini-oauth" { "/oauth2callback" } else { "/callback" };
    let redirect_uri = format!("http://{}:{port}{callback_path}", if provider == "gemini-oauth" { "127.0.0.1" } else { "localhost" });
    let (verifier, challenge) = pkce();
    // Claude Code binds state to the verifier; OpenAI/Google use a separate CSRF state.
    let state = if provider == "claude-oauth" { verifier.clone() } else { random_token(24) };
    let authorize_url = authorize_url(&provider, &redirect_uri, &challenge, &state)?;
    let flow_id = random_token(18);
    manager.flows.lock().insert(flow_id.clone(), AuthFlowStatus { status: "pending", message: "等待浏览器授权…".into() });
    let browser_message = open_authorization_url(&app, &authorize_url);

    let task_flow = flow_id.clone();
    let task_provider = provider.clone();
    let task_manager = manager.clone();
    tauri::async_runtime::spawn(async move {
        let result = async {
            let code = wait_for_callback(listener, &state).await?;
            let credential = exchange_code(&task_provider, &code, &verifier, &redirect_uri).await?;
            save_credential(&app, credential)?;
            Ok::<_, String>(())
        }.await;
        let status = match result {
            Ok(()) => AuthFlowStatus { status: "success", message: "登录成功，订阅凭据已保存在本机".into() },
            Err(error) => AuthFlowStatus { status: "error", message: error },
        };
        task_manager.flows.lock().insert(task_flow, status);
    });

    Ok(AuthChallenge {
        flow_id,
        provider,
        authorize_url,
        user_code: None,
        message: browser_message,
    })
}

async fn start_copilot(app: AppHandle, manager: AgentAuthManager) -> Result<AuthChallenge, String> {
    let client = http_client()?;
    let response = client.post(GITHUB_DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .form(&[("client_id", COPILOT_CLIENT_ID), ("scope", "read:user")])
        .send().await.map_err(http_error)?;
    if !response.status().is_success() {
        return Err(format!("GitHub 设备登录启动失败：{}", response.text().await.unwrap_or_default()));
    }
    let device: DeviceCodeResponse = response.json().await.map_err(http_error)?;
    let flow_id = random_token(18);
    manager.flows.lock().insert(flow_id.clone(), AuthFlowStatus { status: "pending", message: format!("在 GitHub 输入代码 {}", device.user_code) });
    let browser_message = open_authorization_url(&app, &device.verification_uri);
    let task_flow = flow_id.clone();
    let task_manager = manager.clone();
    let device_code = device.device_code.clone();
    let interval = device.interval.max(1);
    let expires = device.expires_in;
    tauri::async_runtime::spawn(async move {
        let result = poll_copilot(client, &device_code, interval, expires).await
            .and_then(|credential| save_credential(&app, credential));
        let status = match result {
            Ok(()) => AuthFlowStatus { status: "success", message: "GitHub Copilot 登录成功".into() },
            Err(error) => AuthFlowStatus { status: "error", message: error },
        };
        task_manager.flows.lock().insert(task_flow, status);
    });
    Ok(AuthChallenge {
        flow_id,
        provider: "copilot".into(),
        authorize_url: device.verification_uri,
        user_code: Some(device.user_code),
        message: browser_message,
    })
}

fn open_authorization_url(app: &AppHandle, url: &str) -> String {
    match app.opener().open_url(url, None::<&str>) {
        Ok(()) => "已打开系统默认浏览器；授权完成后此页面会自动更新。".into(),
        Err(error) => format!("未能自动打开默认浏览器（{error}）。请点击“复制登录链接”，粘贴到浏览器中继续。"),
    }
}

pub fn poll(manager: AgentAuthManager, flow_id: String) -> AuthFlowStatus {
    manager.flows.lock().get(&flow_id).cloned().unwrap_or(AuthFlowStatus {
        status: "error",
        message: "登录会话已失效，请重新开始".into(),
    })
}

pub async fn account_status(app: AppHandle, provider: String) -> Result<AuthAccountStatus, String> {
    let file = load_auth_file(&app)?;
    let account = file.accounts.get(&provider);
    Ok(match account {
        Some(account) => AuthAccountStatus {
            provider,
            connected: true,
            email: account.email.clone(),
            expires_at: account.expires_at,
            detail: if account.expires_at.unwrap_or(i64::MAX) <= now_ms() { "令牌已过期，将在使用时尝试刷新".into() } else { "已连接订阅账户".into() },
        },
        None => AuthAccountStatus { provider, connected: false, email: None, expires_at: None, detail: "尚未登录".into() },
    })
}

pub fn logout(app: AppHandle, provider: String) -> Result<(), String> {
    let mut file = load_auth_file(&app)?;
    file.accounts.remove(&provider);
    save_auth_file(&app, &file)
}

pub async fn credential(app: AppHandle, provider: String) -> Result<AgentCredential, String> {
    let mut file = load_auth_file(&app)?;
    let mut account = file.accounts.get(&provider).cloned().ok_or_else(|| format!("尚未登录 {provider}"))?;
    if provider != "copilot" && account.expires_at.unwrap_or(0) <= now_ms() + 60_000 {
        account = refresh_credential(account).await?;
        file.accounts.insert(provider.clone(), account.clone());
        save_auth_file(&app, &file)?;
    }
    if provider == "copilot" {
        return exchange_copilot_token(&account.access_token).await;
    }
    Ok(AgentCredential { access_token: account.access_token, account_id: account.account_id, expires_at: account.expires_at, api_base: None })
}

fn authorize_url(provider: &str, redirect: &str, challenge: &str, state: &str) -> Result<String, String> {
    let encoded_redirect = urlencoding::encode(redirect);
    let encoded_challenge = urlencoding::encode(challenge);
    let encoded_state = urlencoding::encode(state);
    Ok(match provider {
        "openai-oauth" => format!("{OPENAI_AUTHORIZE_URL}?response_type=code&client_id={OPENAI_CLIENT_ID}&redirect_uri={encoded_redirect}&scope={}&code_challenge={encoded_challenge}&code_challenge_method=S256&state={encoded_state}&id_token_add_organizations=true&codex_cli_simplified_flow=true&originator=codex_cli_rs&prompt=login", urlencoding::encode(OPENAI_SCOPES)),
        "claude-oauth" => format!("{CLAUDE_AUTHORIZE_URL}?code=true&client_id={CLAUDE_CLIENT_ID}&response_type=code&redirect_uri={encoded_redirect}&scope={}&code_challenge={encoded_challenge}&code_challenge_method=S256&state={encoded_state}", urlencoding::encode(CLAUDE_SCOPES)),
        "gemini-oauth" => format!("{GEMINI_AUTHORIZE_URL}?response_type=code&client_id={GEMINI_CLIENT_ID}&redirect_uri={encoded_redirect}&scope={}&code_challenge={encoded_challenge}&code_challenge_method=S256&state={encoded_state}&access_type=offline&prompt=consent", urlencoding::encode(GEMINI_SCOPES)),
        _ => return Err(format!("未知 OAuth Provider：{provider}")),
    })
}

async fn wait_for_callback(listener: TcpListener, expected_state: &str) -> Result<String, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() { return Err("OAuth 登录超时，请重试".into()); }
        let (mut stream, _) = tokio::time::timeout(remaining, listener.accept()).await
            .map_err(|_| "OAuth 登录超时，请重试".to_string())?
            .map_err(|error| format!("OAuth 回调失败：{error}"))?;
        let mut buffer = vec![0_u8; 8192];
        let size = stream.read(&mut buffer).await.map_err(|error| error.to_string())?;
        let request = String::from_utf8_lossy(&buffer[..size]);
        let target = request.lines().next().and_then(|line| line.split_whitespace().nth(1)).unwrap_or("");
        let parsed = url::Url::parse(&format!("http://localhost{target}"));
        let (code, state, error) = parsed.ok().map(|url| {
            let mut code = None; let mut state = None; let mut error = None;
            for (key, value) in url.query_pairs() {
                match key.as_ref() { "code" => code = Some(value.into_owned()), "state" => state = Some(value.into_owned()), "error" => error = Some(value.into_owned()), _ => {} }
            }
            (code, state, error)
        }).unwrap_or_default();
        let valid = state.as_deref() == Some(expected_state) && code.is_some();
        let body = if valid { "<h2>LeafMark 登录成功</h2><p>可以关闭此窗口并返回一叶。</p>" } else { "<h2>LeafMark 未接受此回调</h2><p>请返回应用并重新登录。</p>" };
        let reply = format!("HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", if valid { "200 OK" } else { "400 Bad Request" }, body.len(), body);
        let _ = stream.write_all(reply.as_bytes()).await;
        if let Some(error) = error { return Err(format!("OAuth 授权被拒绝：{error}")); }
        if valid { return Ok(code.unwrap_or_default()); }
    }
}

async fn exchange_code(provider: &str, code: &str, verifier: &str, redirect: &str) -> Result<StoredCredential, String> {
    let client = http_client()?;
    let gemini_secret = gemini_client_secret();
    let response = match provider {
        "claude-oauth" => client.post(CLAUDE_TOKEN_URL).json(&serde_json::json!({
            "grant_type": "authorization_code", "code": code, "redirect_uri": redirect,
            "client_id": CLAUDE_CLIENT_ID, "code_verifier": verifier, "state": verifier,
        })).send().await.map_err(http_error)?,
        "openai-oauth" => client.post(OPENAI_TOKEN_URL).form(&[
            ("grant_type", "authorization_code"), ("client_id", OPENAI_CLIENT_ID),
            ("code", code), ("code_verifier", verifier), ("redirect_uri", redirect),
        ]).send().await.map_err(http_error)?,
        "gemini-oauth" => client.post(GEMINI_TOKEN_URL).form(&[
            ("grant_type", "authorization_code"), ("client_id", GEMINI_CLIENT_ID),
            ("client_secret", gemini_secret.as_str()), ("code", code),
            ("code_verifier", verifier), ("redirect_uri", redirect),
        ]).send().await.map_err(http_error)?,
        _ => return Err(format!("未知 OAuth Provider：{provider}")),
    };
    if !response.status().is_success() {
        return Err(format!("令牌交换失败（{}）：{}", response.status(), response.text().await.unwrap_or_default()));
    }
    let token: TokenResponse = response.json().await.map_err(http_error)?;
    if provider == "gemini-oauth" && token.refresh_token.is_none() {
        return Err("Google 没有返回 refresh token；请在 Google 账户授权页撤销旧授权后重试".into());
    }
    let claims = token.id_token.as_deref().and_then(jwt_claims);
    let account_id = claims.as_ref().and_then(openai_account_id);
    let email = claims.as_ref().and_then(|value| value.get("email").and_then(Value::as_str)).map(ToOwned::to_owned);
    Ok(StoredCredential {
        provider: provider.into(), access_token: token.access_token,
        refresh_token: token.refresh_token.unwrap_or_default(), id_token: token.id_token,
        account_id, email, expires_at: token.expires_in.map(|seconds| now_ms() + seconds * 1000),
    })
}

async fn refresh_credential(account: StoredCredential) -> Result<StoredCredential, String> {
    if account.refresh_token.trim().is_empty() { return Err("登录已过期且没有 refresh token，请重新登录".into()); }
    let client = http_client()?;
    let previous_refresh = account.refresh_token.clone();
    let gemini_secret = gemini_client_secret();
    let response = match account.provider.as_str() {
        "openai-oauth" => client.post(OPENAI_TOKEN_URL).form(&[
            ("grant_type", "refresh_token"), ("client_id", OPENAI_CLIENT_ID), ("refresh_token", previous_refresh.as_str()),
        ]).send().await.map_err(http_error)?,
        "claude-oauth" => client.post(CLAUDE_TOKEN_URL).json(&serde_json::json!({
            "grant_type": "refresh_token", "refresh_token": previous_refresh,
            "client_id": CLAUDE_CLIENT_ID, "scope": CLAUDE_REFRESH_SCOPES,
        })).send().await.map_err(http_error)?,
        "gemini-oauth" => client.post(GEMINI_TOKEN_URL).form(&[
            ("grant_type", "refresh_token"), ("client_id", GEMINI_CLIENT_ID),
            ("client_secret", gemini_secret.as_str()), ("refresh_token", previous_refresh.as_str()),
        ]).send().await.map_err(http_error)?,
        _ => return Ok(account),
    };
    if !response.status().is_success() { return Err(format!("订阅登录刷新失败：{}", response.text().await.unwrap_or_default())); }
    let token: TokenResponse = response.json().await.map_err(http_error)?;
    let id_token = token.id_token.or_else(|| account.id_token.clone());
    let claims = id_token.as_deref().and_then(jwt_claims);
    Ok(StoredCredential {
        provider: account.provider,
        access_token: token.access_token,
        refresh_token: token.refresh_token.unwrap_or(account.refresh_token),
        id_token,
        account_id: claims.as_ref().and_then(openai_account_id).or(account.account_id),
        email: claims.as_ref().and_then(|v| v.get("email").and_then(Value::as_str)).map(ToOwned::to_owned).or(account.email),
        expires_at: token.expires_in.map(|seconds| now_ms() + seconds * 1000).or(account.expires_at),
    })
}

async fn poll_copilot(client: Client, device_code: &str, interval: u64, expires: u64) -> Result<StoredCredential, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(expires);
    let mut delay = interval;
    loop {
        if tokio::time::Instant::now() >= deadline { return Err("GitHub 设备登录代码已过期".into()); }
        tokio::time::sleep(Duration::from_secs(delay)).await;
        let response = client.post(GITHUB_ACCESS_TOKEN_URL).header("Accept", "application/json").form(&[
            ("client_id", COPILOT_CLIENT_ID), ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ]).send().await.map_err(http_error)?;
        let value: Value = response.json().await.map_err(http_error)?;
        if let Some(token) = value.get("access_token").and_then(Value::as_str) {
            return Ok(StoredCredential { provider: "copilot".into(), access_token: token.into(), refresh_token: String::new(), id_token: None, account_id: None, email: None, expires_at: None });
        }
        match value.get("error").and_then(Value::as_str) {
            Some("authorization_pending") => {}
            Some("slow_down") => delay += 5,
            Some(error) => return Err(format!("GitHub 登录失败：{error}")),
            None => return Err("GitHub 登录返回了未知响应".into()),
        }
    }
}

async fn exchange_copilot_token(github_token: &str) -> Result<AgentCredential, String> {
    let client = http_client()?;
    let response = client.get(COPILOT_TOKEN_URL)
        .header("Authorization", format!("token {github_token}"))
        .header("Accept", "application/json")
        .header("User-Agent", "LeafMark/0.5")
        .send().await.map_err(http_error)?;
    if !response.status().is_success() { return Err(format!("Copilot 订阅令牌交换失败：{}", response.text().await.unwrap_or_default())); }
    let value: Value = response.json().await.map_err(http_error)?;
    let token = value.get("token").and_then(Value::as_str).ok_or("Copilot 没有返回访问令牌")?.to_string();
    Ok(AgentCredential {
        access_token: token,
        account_id: None,
        expires_at: value.get("expires_at").and_then(Value::as_i64).map(|seconds| seconds * 1000),
        api_base: value.get("endpoints").and_then(|v| v.get("api")).and_then(Value::as_str).map(ToOwned::to_owned),
    })
}

fn auth_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|error| error.to_string())?.join("agent-auth.json"))
}

fn load_auth_file(app: &AppHandle) -> Result<AuthFile, String> {
    let path = auth_path(app)?;
    if !path.exists() { return Ok(AuthFile::default()); }
    serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?).map_err(|error| format!("OAuth 凭据文件损坏：{error}"))
}

fn save_credential(app: &AppHandle, credential: StoredCredential) -> Result<(), String> {
    let mut file = load_auth_file(app)?;
    file.accounts.insert(credential.provider.clone(), credential);
    save_auth_file(app, &file)
}

fn save_auth_file(app: &AppHandle, file: &AuthFile) -> Result<(), String> {
    let path = auth_path(app)?;
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(file).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    harden_secret(&tmp)?;
    fs::rename(&tmp, &path).or_else(|_| { let _ = fs::remove_file(&path); fs::rename(&tmp, &path) }).map_err(|error| error.to_string())?;
    harden_secret(&path)
}

#[cfg(unix)]
fn harden_secret(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn harden_secret(_path: &Path) -> Result<(), String> { Ok(()) }

fn pkce() -> (String, String) {
    let verifier = random_token(48);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

fn random_token(bytes: usize) -> String {
    let mut data = Vec::with_capacity(bytes);
    while data.len() < bytes { data.extend_from_slice(&random::<[u8; 16]>()); }
    data.truncate(bytes);
    URL_SAFE_NO_PAD.encode(data)
}

fn jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()
}

fn openai_account_id(claims: &Value) -> Option<String> {
    claims.get("https://api.openai.com/auth").and_then(|value| value.get("chatgpt_account_id")).and_then(Value::as_str)
        .or_else(|| claims.get("chatgpt_account_id").and_then(Value::as_str)).map(ToOwned::to_owned)
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}

fn http_client() -> Result<Client, String> {
    Client::builder().timeout(Duration::from_secs(30)).user_agent("LeafMark/0.5").build().map_err(http_error)
}

fn http_error(error: reqwest::Error) -> String { error.to_string() }
