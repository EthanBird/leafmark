use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashSet, error::Error, fmt};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeRole { System, User, Assistant, Tool }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMessage {
    pub role: RuntimeRole,
    #[serde(default)] pub content: Option<String>,
    #[serde(default)] pub tool_call_id: Option<String>,
    #[serde(default)] pub tool_calls: Vec<ToolCall>,
    #[serde(default)] pub provider_items: Vec<Value>,
}
impl RuntimeMessage {
    pub fn text(role: RuntimeRole, content: impl Into<String>) -> Self {
        Self { role, content: Some(content.into()), tool_call_id: None, tool_calls: Vec::new(), provider_items: Vec::new() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    #[serde(default)] pub arguments: Value,
    #[serde(default)] pub exclusive_text_sink: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    #[serde(default)] pub exclusive_text_sink: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelResponse {
    #[serde(default)] pub content: String,
    #[serde(default)] pub reasoning: String,
    #[serde(default)] pub tool_calls: Vec<ToolCall>,
    #[serde(default)] pub provider_items: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecutionResult {
    pub call_id: String,
    pub output: String,
    #[serde(default)] pub text_sink_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum AgentAction {
    RequestCompletion { messages: Vec<RuntimeMessage>, tools_enabled: bool, sink_label: Option<String>, round: usize },
    ExecuteTools { calls: Vec<ToolCall> },
    CommitExclusiveText { label: String, content: String },
    Completed { content: String, rounds: usize },
    Failed { message: String, rounds: usize },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MachineState { Ready, WaitingModel, WaitingTools, WaitingSinkCommit, Finished }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentCoreError {
    InvalidState(&'static str), ToolResultMismatch, MixedExclusiveToolCalls, InvalidTextSink,
    ToolCallDuringTextSink, MaximumRounds(usize), InvalidSseUtf8,
}
impl fmt::Display for AgentCoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidState(expected) => write!(f, "Agent 状态错误，当前操作要求：{expected}"),
            Self::ToolResultMismatch => f.write_str("工具结果与待执行调用不匹配"),
            Self::MixedExclusiveToolCalls => f.write_str("文档流式写入工具必须单独调用"),
            Self::InvalidTextSink => f.write_str("文本写入通道只能由唯一的 exclusive 工具打开"),
            Self::ToolCallDuringTextSink => f.write_str("文档流式输出阶段不能继续调用工具"),
            Self::MaximumRounds(rounds) => write!(f, "Agent 连续执行 {rounds} 轮工具仍未结束"),
            Self::InvalidSseUtf8 => f.write_str("SSE 事件不是有效 UTF-8"),
        }
    }
}
impl Error for AgentCoreError {}
type Result<T> = std::result::Result<T, AgentCoreError>;

pub struct AgentTurnMachine {
    messages: Vec<RuntimeMessage>, final_content: String, max_rounds: usize, rounds: usize,
    state: MachineState, pending_calls: Vec<ToolCall>, pending_sink: Option<String>,
}
impl AgentTurnMachine {
    pub fn new(system_prompt: impl Into<String>, history: impl IntoIterator<Item = RuntimeMessage>, max_rounds: usize) -> Self {
        let mut messages = vec![RuntimeMessage::text(RuntimeRole::System, system_prompt)];
        messages.extend(history);
        Self { messages, final_content: String::new(), max_rounds: max_rounds.clamp(1, 16), rounds: 0,
            state: MachineState::Ready, pending_calls: Vec::new(), pending_sink: None }
    }
    pub fn rounds(&self) -> usize { self.rounds }
    pub fn messages(&self) -> &[RuntimeMessage] { &self.messages }
    pub fn start(&mut self) -> Result<AgentAction> {
        if self.state != MachineState::Ready { return Err(AgentCoreError::InvalidState("尚未开始")); }
        self.request_completion(true, None)
    }
    pub fn accept_model(&mut self, response: ModelResponse) -> Result<AgentAction> {
        if self.state != MachineState::WaitingModel { return Err(AgentCoreError::InvalidState("等待模型响应")); }
        self.rounds = self.rounds.saturating_add(1);
        if let Some(label) = self.pending_sink.take() {
            if !response.tool_calls.is_empty() { return Err(AgentCoreError::ToolCallDuringTextSink); }
            self.state = MachineState::WaitingSinkCommit;
            return Ok(AgentAction::CommitExclusiveText { label, content: response.content });
        }
        let exclusive_count = response.tool_calls.iter().filter(|call| call.exclusive_text_sink).count();
        if exclusive_count != 0 && (exclusive_count != 1 || response.tool_calls.len() != 1) {
            return Err(AgentCoreError::MixedExclusiveToolCalls);
        }
        self.final_content.push_str(&response.content);
        let content = if response.content.is_empty() { None } else { Some(response.content) };
        self.messages.push(RuntimeMessage { role: RuntimeRole::Assistant, content, tool_call_id: None,
            tool_calls: response.tool_calls.clone(), provider_items: response.provider_items });
        if response.tool_calls.is_empty() {
            self.state = MachineState::Finished;
            return Ok(AgentAction::Completed { content: self.final_content.clone(), rounds: self.rounds });
        }
        self.pending_calls = response.tool_calls.clone();
        self.state = MachineState::WaitingTools;
        Ok(AgentAction::ExecuteTools { calls: response.tool_calls })
    }
    pub fn accept_tools(&mut self, results: Vec<ToolExecutionResult>) -> Result<AgentAction> {
        if self.state != MachineState::WaitingTools { return Err(AgentCoreError::InvalidState("等待工具结果")); }
        validate_tool_results(&self.pending_calls, &results)?;
        let mut sink_label = None;
        let mut sink_count = 0usize;
        for result in &results {
            if let Some(label) = &result.text_sink_label {
                sink_count = sink_count.saturating_add(1);
                if sink_label.is_none() { sink_label = Some(label.clone()); }
            }
        }
        if sink_count != 0 && (sink_count != 1 || self.pending_calls.len() != 1 || !self.pending_calls[0].exclusive_text_sink) {
            return Err(AgentCoreError::InvalidTextSink);
        }
        for result in results {
            self.messages.push(RuntimeMessage { role: RuntimeRole::Tool, content: Some(result.output),
                tool_call_id: Some(result.call_id), tool_calls: Vec::new(), provider_items: Vec::new() });
        }
        self.pending_calls.clear();
        if let Some(label) = sink_label {
            self.pending_sink = Some(label.clone());
            return self.request_completion(false, Some(label));
        }
        if self.rounds >= self.max_rounds {
            self.state = MachineState::Finished;
            return Err(AgentCoreError::MaximumRounds(self.max_rounds));
        }
        self.request_completion(true, None)
    }
    pub fn accept_sink_commit(&mut self, summary: impl Into<String>) -> Result<AgentAction> {
        if self.state != MachineState::WaitingSinkCommit { return Err(AgentCoreError::InvalidState("等待文本写入提交")); }
        self.state = MachineState::Finished;
        Ok(AgentAction::Completed { content: summary.into(), rounds: self.rounds })
    }
    pub fn cancel(&mut self, reason: impl Into<String>) -> AgentAction {
        self.state = MachineState::Finished;
        AgentAction::Failed { message: format!("Agent 已取消：{}", reason.into()), rounds: self.rounds }
    }
    fn request_completion(&mut self, tools_enabled: bool, sink_label: Option<String>) -> Result<AgentAction> {
        if tools_enabled && self.rounds >= self.max_rounds {
            self.state = MachineState::Finished;
            return Err(AgentCoreError::MaximumRounds(self.max_rounds));
        }
        self.state = MachineState::WaitingModel;
        Ok(AgentAction::RequestCompletion { messages: self.messages.clone(), tools_enabled, sink_label, round: self.rounds + 1 })
    }
}

fn validate_tool_results(calls: &[ToolCall], results: &[ToolExecutionResult]) -> Result<()> {
    if calls.len() != results.len() { return Err(AgentCoreError::ToolResultMismatch); }
    let expected = calls.iter().map(|call| call.id.as_str()).collect::<HashSet<_>>();
    let actual = results.iter().map(|result| result.call_id.as_str()).collect::<HashSet<_>>();
    if expected.len() != calls.len() || actual.len() != results.len() || expected != actual {
        return Err(AgentCoreError::ToolResultMismatch);
    }
    Ok(())
}

#[derive(Debug, Default)]
pub struct SseDecoder { buffer: Vec<u8> }
impl SseDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>> {
        self.buffer.extend_from_slice(bytes);
        let mut events = Vec::new();
        while let Some((position, delimiter_len)) = find_event_boundary(&self.buffer) {
            let event = self.buffer.drain(..position).collect::<Vec<_>>();
            self.buffer.drain(..delimiter_len);
            if let Some(data) = parse_sse_event(&event)? { events.push(data); }
        }
        Ok(events)
    }
    pub fn finish(&mut self) -> Result<Vec<String>> {
        if self.buffer.is_empty() { return Ok(Vec::new()); }
        let event = std::mem::take(&mut self.buffer);
        Ok(parse_sse_event(&event)?.into_iter().collect())
    }
}
fn find_event_boundary(buffer: &[u8]) -> Option<(usize, usize)> {
    let crlf = buffer.windows(4).position(|window| window == b"\r\n\r\n").map(|position| (position, 4));
    let lf = buffer.windows(2).position(|window| window == b"\n\n").map(|position| (position, 2));
    match (crlf, lf) {
        (Some(left), Some(right)) => Some(if left.0 <= right.0 { left } else { right }),
        (Some(boundary), None) | (None, Some(boundary)) => Some(boundary),
        (None, None) => None,
    }
}
fn parse_sse_event(event: &[u8]) -> Result<Option<String>> {
    let value = std::str::from_utf8(event).map_err(|_| AgentCoreError::InvalidSseUtf8)?;
    let data = value.lines().filter_map(|line| line.strip_prefix("data:")).map(str::trim_start).collect::<Vec<_>>();
    if data.is_empty() { Ok(None) } else { Ok(Some(data.join("\n"))) }
}
pub fn safe_tool_arguments(value: &str) -> Value {
    match serde_json::from_str::<Value>(value) {
        Ok(parsed) if parsed.is_object() => parsed,
        _ => Value::Object(serde_json::Map::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn call(id: &str, exclusive: bool) -> ToolCall {
        ToolCall { id: id.to_owned(), name: if exclusive { "replace_document" } else { "read_document" }.to_owned(),
            arguments: serde_json::json!({"path":"note.md"}), exclusive_text_sink: exclusive }
    }
    fn response(content: &str, tool_calls: Vec<ToolCall>) -> ModelResponse {
        ModelResponse { content: content.to_owned(), reasoning: String::new(), tool_calls, provider_items: Vec::new() }
    }
    #[test]
    fn completes_direct_model_response() {
        let mut machine = AgentTurnMachine::new("system", Vec::new(), 4);
        assert!(matches!(machine.start().unwrap(), AgentAction::RequestCompletion { round: 1, .. }));
        assert_eq!(machine.accept_model(response("完成", Vec::new())).unwrap(),
            AgentAction::Completed { content: "完成".to_owned(), rounds: 1 });
    }
    #[test]
    fn executes_tools_and_requests_next_round() {
        let mut machine = AgentTurnMachine::new("system", Vec::new(), 4);
        machine.start().unwrap();
        assert!(matches!(machine.accept_model(response("", vec![call("c1", false)])).unwrap(), AgentAction::ExecuteTools { .. }));
        assert!(matches!(machine.accept_tools(vec![ToolExecutionResult { call_id: "c1".to_owned(), output: "文档内容".to_owned(), text_sink_label: None }]).unwrap(),
            AgentAction::RequestCompletion { tools_enabled: true, round: 2, .. }));
    }
    #[test]
    fn exclusive_sink_gets_extra_tools_disabled_response() {
        let mut machine = AgentTurnMachine::new("system", Vec::new(), 1);
        machine.start().unwrap();
        machine.accept_model(response("", vec![call("writer", true)])).unwrap();
        assert!(matches!(machine.accept_tools(vec![ToolExecutionResult { call_id: "writer".to_owned(), output: "准备写入".to_owned(), text_sink_label: Some("note.md".to_owned()) }]).unwrap(),
            AgentAction::RequestCompletion { tools_enabled: false, round: 2, .. }));
        assert_eq!(machine.accept_model(response("# 新文档", Vec::new())).unwrap(),
            AgentAction::CommitExclusiveText { label: "note.md".to_owned(), content: "# 新文档".to_owned() });
    }
    #[test]
    fn rejects_mixed_exclusive_calls_and_fake_sinks() {
        let mut mixed = AgentTurnMachine::new("system", Vec::new(), 4);
        mixed.start().unwrap();
        assert_eq!(mixed.accept_model(response("", vec![call("writer", true), call("read", false)])), Err(AgentCoreError::MixedExclusiveToolCalls));
        let mut fake = AgentTurnMachine::new("system", Vec::new(), 4);
        fake.start().unwrap();
        fake.accept_model(response("", vec![call("read", false)])).unwrap();
        assert_eq!(fake.accept_tools(vec![ToolExecutionResult { call_id: "read".to_owned(), output: "fake".to_owned(), text_sink_label: Some("note.md".to_owned()) }]), Err(AgentCoreError::InvalidTextSink));
    }
    #[test]
    fn rejects_mismatched_results_and_enforces_round_limit() {
        let mut mismatch = AgentTurnMachine::new("system", Vec::new(), 4);
        mismatch.start().unwrap();
        mismatch.accept_model(response("", vec![call("read", false)])).unwrap();
        assert_eq!(mismatch.accept_tools(vec![ToolExecutionResult { call_id: "wrong".to_owned(), output: String::new(), text_sink_label: None }]), Err(AgentCoreError::ToolResultMismatch));
        let mut limited = AgentTurnMachine::new("system", Vec::new(), 1);
        limited.start().unwrap();
        limited.accept_model(response("", vec![call("read", false)])).unwrap();
        assert_eq!(limited.accept_tools(vec![ToolExecutionResult { call_id: "read".to_owned(), output: "result".to_owned(), text_sink_label: None }]), Err(AgentCoreError::MaximumRounds(1)));
    }
    #[test]
    fn sse_decoder_handles_fragmented_utf8_and_mixed_boundaries() {
        let stream = concat!("data: 第一行\r\n", "data: 第二行🌿\r\n\r\n", "data: third\n\n").as_bytes();
        let emoji = "🌿".as_bytes();
        let split = stream.windows(emoji.len()).position(|window| window == emoji).unwrap() + 2;
        let mut decoder = SseDecoder::default();
        assert!(decoder.push(&stream[..split]).unwrap().is_empty());
        assert_eq!(decoder.push(&stream[split..]).unwrap(), vec!["第一行\n第二行🌿", "third"]);
    }
    #[test]
    fn invalid_tool_arguments_become_empty_objects() {
        assert_eq!(safe_tool_arguments("bad"), serde_json::json!({}));
        assert_eq!(safe_tool_arguments("[1]"), serde_json::json!({}));
        assert_eq!(safe_tool_arguments("{\"x\":1}"), serde_json::json!({"x":1}));
    }
}
