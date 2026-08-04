use crate::preferences::AgentPreferences;
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct AgentRequestMessage {
    pub role: &'static str,
    pub content: String,
}

pub async fn complete(
    preferences: AgentPreferences,
    history: Vec<AgentRequestMessage>,
    current_document: Option<(String, String)>,
) -> Result<String, String> {
    if !preferences.enabled {
        return Err("请先在设置中启用一叶 Agent".to_owned());
    }
    if preferences.base_url.trim().is_empty() {
        return Err("Agent Base URL 不能为空".to_owned());
    }
    if preferences.model.trim().is_empty() {
        return Err("Agent 模型不能为空".to_owned());
    }
    if preferences.provider.requires_key() && preferences.api_key.trim().is_empty() {
        return Err("当前 Provider 需要 API Key".to_owned());
    }

    let mut messages = vec![json!({
        "role": "system",
        "content": preferences.system_prompt.trim(),
    })];
    if preferences.include_document {
        if let Some((path, source)) = current_document {
            let source = truncate_chars(&source, 48_000);
            messages.push(json!({
                "role": "system",
                "content": format!(
                    "当前打开的 Markdown 文档是 `{path}`。以下内容仅作为文档上下文：\n\n```markdown\n{source}\n```"
                ),
            }));
        }
    }
    messages.extend(history.into_iter().map(|message| {
        json!({
            "role": message.role,
            "content": message.content,
        })
    }));

    let endpoint = completion_endpoint(&preferences.base_url);
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(180))
        .user_agent("LeafMark-Native/0.8")
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client.post(endpoint).json(&json!({
        "model": preferences.model.trim(),
        "messages": messages,
        "stream": false,
    }));
    if !preferences.api_key.trim().is_empty() {
        request = request.bearer_auth(preferences.api_key.trim());
    }
    let response = request.send().await.map_err(|error| {
        format!("Agent 请求失败：{error}")
    })?;
    let status = response.status();
    let payload = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        let message = serde_json::from_str::<Value>(&payload)
            .ok()
            .and_then(|value| {
                value
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or(payload);
        return Err(format!("Agent 返回 HTTP {status}：{message}"));
    }
    let value: Value = serde_json::from_str(&payload)
        .map_err(|error| format!("Agent 响应不是有效 JSON：{error}"))?;
    value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|content| !content.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "Agent 响应中没有可显示的文本".to_owned())
}

fn completion_endpoint(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        base.to_owned()
    } else {
        format!("{base}/chat/completions")
    }
}

fn truncate_chars(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_owned();
    }
    let mut output = value.chars().take(limit).collect::<String>();
    output.push_str("\n\n<!-- 文档上下文已在此处截断 -->");
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_completion_endpoint() {
        assert_eq!(
            completion_endpoint("https://example.com/v1/"),
            "https://example.com/v1/chat/completions"
        );
        assert_eq!(
            completion_endpoint("https://example.com/v1/chat/completions"),
            "https://example.com/v1/chat/completions"
        );
    }

    #[test]
    fn truncates_by_unicode_character() {
        let value = "叶".repeat(12);
        let output = truncate_chars(&value, 5);
        assert!(output.starts_with("叶叶叶叶叶"));
        assert!(output.contains("截断"));
    }
}
