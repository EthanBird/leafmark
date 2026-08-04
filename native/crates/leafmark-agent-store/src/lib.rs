use atomicwrites::{AllowOverwrite, AtomicFile};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    cmp::Ordering,
    error::Error,
    fmt, fs,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering as AtomicOrdering},
    time::{SystemTime, UNIX_EPOCH},
};

const STORE_VERSION: u32 = 1;
const MAX_SESSIONS: usize = 30;
const MAX_MEMORIES: usize = 400;
const VECTOR_SIZE: usize = 256;
static ID_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub turn_id: Option<String>,
    pub role: AgentRole,
    pub content: String,
    pub created_at: u64,
    #[serde(default)]
    pub reasoning: Option<String>,
    #[serde(default)]
    pub activities: Vec<Value>,
    #[serde(default)]
    pub version: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub id: String,
    pub title: String,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub messages: Vec<AgentMessage>,
    #[serde(default = "missing_cursor")]
    pub cursor: usize,
}

impl AgentSession {
    pub fn new() -> Self {
        let now = now_ms();
        Self {
            id: generate_id("session"),
            title: "新会话".to_owned(),
            created_at: now,
            updated_at: now,
            messages: Vec::new(),
            cursor: 0,
        }
    }

    pub fn active_messages(&self) -> &[AgentMessage] {
        &self.messages[..self.cursor.min(self.messages.len())]
    }

    fn normalize(mut self) -> Self {
        if self.id.trim().is_empty() {
            self.id = generate_id("session");
        }
        if self.title.trim().is_empty() {
            self.title = "新会话".to_owned();
        }
        self.cursor = if self.cursor == usize::MAX {
            self.messages.len()
        } else {
            self.cursor.min(self.messages.len())
        };
        self
    }
}

impl Default for AgentSession {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMemory {
    pub id: String,
    pub content: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub created_at: u64,
    #[serde(default)]
    pub access_count: u32,
}

impl AgentMemory {
    fn normalize(mut self) -> Option<Self> {
        self.content = self.content.trim().chars().take(4_000).collect();
        if self.content.is_empty() {
            return None;
        }
        if self.id.trim().is_empty() {
            self.id = generate_id("memory");
        }
        let mut tags = Vec::new();
        for tag in self.tags {
            let tag = tag.trim().to_owned();
            if !tag.is_empty() && !tags.contains(&tag) {
                tags.push(tag);
            }
            if tags.len() == 12 {
                break;
            }
        }
        self.tags = tags;
        Some(self)
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct SessionFile {
    #[serde(default = "store_version")]
    version: u32,
    #[serde(default)]
    sessions: Vec<AgentSession>,
}

#[derive(Debug, Serialize, Deserialize)]
struct MemoryFile {
    #[serde(default = "store_version")]
    version: u32,
    #[serde(default)]
    memories: Vec<AgentMemory>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentStoreError {
    Io(String),
    Json(String),
    MissingSession,
    InvalidLegacyPayload(String),
}

impl fmt::Display for AgentStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(message) => formatter.write_str(message),
            Self::Json(message) => write!(formatter, "Agent 状态 JSON 损坏：{message}"),
            Self::MissingSession => formatter.write_str("Agent 会话不存在"),
            Self::InvalidLegacyPayload(message) => {
                write!(formatter, "旧版 Agent 数据无法迁移：{message}")
            }
        }
    }
}

impl Error for AgentStoreError {}

impl From<std::io::Error> for AgentStoreError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value.to_string())
    }
}

type Result<T> = std::result::Result<T, AgentStoreError>;

pub struct AgentStore {
    root: PathBuf,
    sessions_path: PathBuf,
    memories_path: PathBuf,
    sessions: Vec<AgentSession>,
    memories: Vec<AgentMemory>,
}

impl AgentStore {
    pub fn load(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(&root)?;
        let sessions_path = root.join("sessions.json");
        let memories_path = root.join("memories.json");
        let store = Self {
            sessions: load_sessions(&root, &sessions_path)?,
            memories: load_memories(&root, &memories_path)?,
            root,
            sessions_path,
            memories_path,
        };
        store.persist_sessions()?;
        store.persist_memories()?;
        Ok(store)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn sessions(&self) -> &[AgentSession] {
        &self.sessions
    }

    pub fn memories(&self) -> &[AgentMemory] {
        &self.memories
    }

    pub fn save_session(&mut self, mut session: AgentSession) -> Result<&[AgentSession]> {
        session = session.normalize();
        session.updated_at = session.updated_at.max(now_ms());
        self.sessions.retain(|candidate| candidate.id != session.id);
        self.sessions.push(session);
        sort_sessions(&mut self.sessions);
        self.sessions.truncate(MAX_SESSIONS);
        self.persist_sessions()?;
        Ok(&self.sessions)
    }

    pub fn remove_session(&mut self, id: &str) -> Result<&[AgentSession]> {
        self.sessions.retain(|session| session.id != id);
        self.persist_sessions()?;
        Ok(&self.sessions)
    }

    pub fn search_sessions(&self, query: &str, limit: usize) -> Vec<String> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Vec::new();
        }
        self.sessions
            .iter()
            .flat_map(|session| {
                session
                    .active_messages()
                    .iter()
                    .filter(|message| message.content.to_lowercase().contains(&needle))
                    .map(|message| {
                        let role = match message.role {
                            AgentRole::User => "user",
                            AgentRole::Assistant => "assistant",
                        };
                        format!(
                            "[{}] {role}: {}",
                            session.title,
                            message.content.chars().take(500).collect::<String>()
                        )
                    })
            })
            .take(limit)
            .collect()
    }

    pub fn agent_turn_persisted(
        &self,
        session_id: &str,
        turn_id: &str,
        expected_version_id: Option<&str>,
    ) -> bool {
        self.sessions
            .iter()
            .find(|session| session.id == session_id)
            .is_some_and(|session| {
                session.messages.iter().any(|message| {
                    if message.turn_id.as_deref() != Some(turn_id)
                        || message.role != AgentRole::Assistant
                    {
                        return false;
                    }
                    match expected_version_id {
                        None => true,
                        Some(expected) => {
                            message
                                .version
                                .as_ref()
                                .and_then(|version| version.get("id"))
                                .and_then(Value::as_str)
                                == Some(expected)
                        }
                    }
                })
            })
    }

    pub fn set_turn_applied(
        &mut self,
        session_id: &str,
        turn_id: &str,
        applied: bool,
    ) -> Result<&[AgentSession]> {
        let session = self
            .sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .ok_or(AgentStoreError::MissingSession)?;
        let indexes = session
            .messages
            .iter()
            .enumerate()
            .filter_map(|(index, message)| {
                (message.turn_id.as_deref() == Some(turn_id)).then_some(index)
            })
            .collect::<Vec<_>>();
        if let (Some(first), Some(last)) = (indexes.first(), indexes.last()) {
            session.cursor = if applied {
                session.cursor.max(*last + 1)
            } else {
                session.cursor.min(*first)
            };
            session.updated_at = now_ms();
        }
        self.persist_sessions()?;
        Ok(&self.sessions)
    }

    pub fn discard_redo_branches(&mut self) -> Result<&[AgentSession]> {
        for session in &mut self.sessions {
            let cursor = session.cursor.min(session.messages.len());
            if cursor < session.messages.len() {
                session.messages.truncate(cursor);
                session.updated_at = now_ms();
            }
        }
        self.persist_sessions()?;
        Ok(&self.sessions)
    }

    pub fn store_memory(&mut self, content: &str, tags: &[String]) -> Result<AgentMemory> {
        let normalized = content.trim();
        if let Some(memory) = self
            .memories
            .iter()
            .find(|memory| memory.content == normalized)
        {
            return Ok(memory.clone());
        }
        let memory = AgentMemory {
            id: generate_id("memory"),
            content: normalized.to_owned(),
            tags: tags.to_vec(),
            created_at: now_ms(),
            access_count: 0,
        }
        .normalize()
        .ok_or_else(|| AgentStoreError::InvalidLegacyPayload("记忆内容为空".to_owned()))?;
        self.memories.insert(0, memory.clone());
        self.memories.truncate(MAX_MEMORIES);
        self.persist_memories()?;
        Ok(memory)
    }

    pub fn search_memories(&mut self, query: &str, limit: usize) -> Result<Vec<AgentMemory>> {
        if query.trim().is_empty() {
            return Ok(self.memories.iter().take(limit).cloned().collect());
        }
        let query_vector = feature_vector(query);
        let mut ranked = self
            .memories
            .iter()
            .enumerate()
            .map(|(index, memory)| {
                let text = format!("{} {}", memory.content, memory.tags.join(" "));
                let score = cosine_similarity(&query_vector, &feature_vector(&text))
                    + memory.access_count.min(20) as f32 * 0.002;
                (index, score)
            })
            .filter(|(_, score)| *score > 0.0)
            .collect::<Vec<_>>();
        ranked.sort_by(|left, right| {
            right
                .1
                .partial_cmp(&left.1)
                .unwrap_or(Ordering::Equal)
                .then_with(|| left.0.cmp(&right.0))
        });
        ranked.truncate(limit);
        let selected = ranked.iter().map(|(index, _)| *index).collect::<Vec<_>>();
        for index in &selected {
            self.memories[*index].access_count =
                self.memories[*index].access_count.saturating_add(1);
        }
        let result = selected
            .into_iter()
            .map(|index| self.memories[index].clone())
            .collect();
        self.persist_memories()?;
        Ok(result)
    }

    pub fn remove_memory(&mut self, id: &str) -> Result<&[AgentMemory]> {
        self.memories.retain(|memory| memory.id != id);
        self.persist_memories()?;
        Ok(&self.memories)
    }

    pub fn import_legacy_json(&mut self, sessions_json: &str, memories_json: &str) -> Result<()> {
        let sessions = serde_json::from_str::<Vec<AgentSession>>(sessions_json)
            .map_err(|error| AgentStoreError::InvalidLegacyPayload(error.to_string()))?;
        let memories = serde_json::from_str::<Vec<AgentMemory>>(memories_json)
            .map_err(|error| AgentStoreError::InvalidLegacyPayload(error.to_string()))?;
        self.sessions = sessions.into_iter().map(AgentSession::normalize).collect();
        sort_sessions(&mut self.sessions);
        self.sessions.truncate(MAX_SESSIONS);
        self.memories = memories
            .into_iter()
            .filter_map(AgentMemory::normalize)
            .take(MAX_MEMORIES)
            .collect();
        self.persist_sessions()?;
        self.persist_memories()
    }

    fn persist_sessions(&self) -> Result<()> {
        write_json(
            &self.sessions_path,
            &SessionFile {
                version: STORE_VERSION,
                sessions: self.sessions.clone(),
            },
        )
    }

    fn persist_memories(&self) -> Result<()> {
        write_json(
            &self.memories_path,
            &MemoryFile {
                version: STORE_VERSION,
                memories: self.memories.clone(),
            },
        )
    }
}

fn missing_cursor() -> usize {
    usize::MAX
}

fn store_version() -> u32 {
    STORE_VERSION
}

fn load_sessions(root: &Path, path: &Path) -> Result<Vec<AgentSession>> {
    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<SessionFile>(&bytes) {
            Ok(file) if file.version == STORE_VERSION => {
                let mut sessions = file
                    .sessions
                    .into_iter()
                    .map(AgentSession::normalize)
                    .collect::<Vec<_>>();
                sort_sessions(&mut sessions);
                sessions.truncate(MAX_SESSIONS);
                Ok(sessions)
            }
            _ => {
                backup_corrupt(root, path, "sessions")?;
                Ok(Vec::new())
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.into()),
    }
}

fn load_memories(root: &Path, path: &Path) -> Result<Vec<AgentMemory>> {
    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<MemoryFile>(&bytes) {
            Ok(file) if file.version == STORE_VERSION => Ok(file
                .memories
                .into_iter()
                .filter_map(AgentMemory::normalize)
                .take(MAX_MEMORIES)
                .collect()),
            _ => {
                backup_corrupt(root, path, "memories")?;
                Ok(Vec::new())
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.into()),
    }
}

fn sort_sessions(sessions: &mut [AgentSession]) {
    sessions.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.id.cmp(&right.id))
    });
}

fn feature_vector(text: &str) -> [f32; VECTOR_SIZE] {
    let mut vector = [0.0; VECTOR_SIZE];
    for token in tokenize(text) {
        let mut features = vec![token.clone()];
        if token.chars().count() > 3 {
            features.extend(character_ngrams(&token, 3));
        }
        for feature in features {
            vector[hash_feature(&feature) as usize % VECTOR_SIZE] += 1.0;
        }
    }
    vector
}

fn tokenize(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut word = String::new();
    for character in text.to_lowercase().chars() {
        if is_cjk(character) {
            if !word.is_empty() {
                tokens.push(std::mem::take(&mut word));
            }
            tokens.push(character.to_string());
        } else if character.is_alphanumeric() || matches!(character, '_' | '-') {
            word.push(character);
        } else if !word.is_empty() {
            tokens.push(std::mem::take(&mut word));
        }
    }
    if !word.is_empty() {
        tokens.push(word);
    }
    tokens
}

fn is_cjk(character: char) -> bool {
    matches!(
        character as u32,
        0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xF900..=0xFAFF
            | 0x3040..=0x30FF
            | 0xAC00..=0xD7AF
    )
}

fn character_ngrams(value: &str, width: usize) -> Vec<String> {
    let characters = value.chars().collect::<Vec<_>>();
    if characters.len() <= width {
        return vec![value.to_owned()];
    }
    characters
        .windows(width)
        .map(|window| window.iter().collect())
        .collect()
}

fn hash_feature(value: &str) -> u32 {
    let mut hash = 2_166_136_261_u32;
    for byte in value.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(16_777_619);
    }
    hash
}

fn cosine_similarity(left: &[f32; VECTOR_SIZE], right: &[f32; VECTOR_SIZE]) -> f32 {
    let mut dot = 0.0;
    let mut left_norm = 0.0;
    let mut right_norm = 0.0;
    for index in 0..VECTOR_SIZE {
        dot += left[index] * right[index];
        left_norm += left[index] * left[index];
        right_norm += right[index] * right[index];
    }
    if left_norm == 0.0 || right_norm == 0.0 {
        0.0
    } else {
        dot / (left_norm.sqrt() * right_norm.sqrt())
    }
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| AgentStoreError::Json(error.to_string()))?;
    AtomicFile::new(path, AllowOverwrite)
        .write(|file| file.write_all(&bytes))
        .map_err(|error| AgentStoreError::Io(error.to_string()))
}

fn backup_corrupt(root: &Path, path: &Path, label: &str) -> Result<()> {
    if path.exists() {
        fs::copy(
            path,
            root.join(format!("{label}.corrupt-{}.json", now_ms())),
        )?;
    }
    Ok(())
}

fn generate_id(prefix: &str) -> String {
    let sequence = ID_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed);
    format!("{prefix}-{:x}-{sequence:x}", now_ms())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "leafmark-agent-store-{label}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn message(turn_id: &str, role: AgentRole, content: &str) -> AgentMessage {
        AgentMessage {
            id: None,
            turn_id: Some(turn_id.to_owned()),
            role,
            content: content.to_owned(),
            created_at: now_ms(),
            reasoning: None,
            activities: Vec::new(),
            version: None,
        }
    }

    #[test]
    fn imports_legacy_local_storage_and_reopens_it() {
        let root = temp_root("legacy");
        let sessions = r#"[{"id":"s1","title":"旧会话","createdAt":1,"updatedAt":2,"messages":[{"role":"user","content":"你好","createdAt":1}],"cursor":0}]"#;
        let memories = r#"[{"id":"m1","content":"记住 LeafMark 使用 Markdown","tags":["leafmark"],"createdAt":1,"accessCount":0}]"#;
        let mut store = AgentStore::load(&root).unwrap();
        store.import_legacy_json(sessions, memories).unwrap();
        assert_eq!(store.sessions()[0].cursor, 0);
        drop(store);
        let reopened = AgentStore::load(&root).unwrap();
        assert_eq!(reopened.sessions()[0].title, "旧会话");
        assert_eq!(reopened.sessions()[0].cursor, 0);
        assert_eq!(reopened.memories()[0].id, "m1");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_legacy_cursor_defaults_to_all_messages_applied() {
        let root = temp_root("missing-cursor");
        let sessions = r#"[{"id":"s1","title":"旧会话","createdAt":1,"updatedAt":2,"messages":[{"role":"user","content":"你好","createdAt":1}]}]"#;
        let mut store = AgentStore::load(&root).unwrap();
        store.import_legacy_json(sessions, "[]").unwrap();
        assert_eq!(store.sessions()[0].cursor, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn conversation_cursor_tracks_native_file_undo_and_redo() {
        let root = temp_root("cursor");
        let mut store = AgentStore::load(&root).unwrap();
        let mut session = AgentSession::new();
        session.id = "session".to_owned();
        session.messages = vec![
            message("turn-1", AgentRole::User, "修改文档"),
            message("turn-1", AgentRole::Assistant, "完成"),
            message("turn-2", AgentRole::User, "继续"),
            message("turn-2", AgentRole::Assistant, "完成二"),
        ];
        session.cursor = session.messages.len();
        store.save_session(session).unwrap();
        store.set_turn_applied("session", "turn-2", false).unwrap();
        assert_eq!(store.sessions()[0].cursor, 2);
        store.discard_redo_branches().unwrap();
        assert_eq!(store.sessions()[0].messages.len(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn memory_search_ranks_relevant_chinese_content_and_updates_access() {
        let root = temp_root("memory");
        let mut store = AgentStore::load(&root).unwrap();
        store
            .store_memory("LeafMark 使用 Rust 原生编辑器", &["编辑器".to_owned()])
            .unwrap();
        store
            .store_memory("今天需要购买水果", &["生活".to_owned()])
            .unwrap();
        let result = store.search_memories("Rust 编辑器", 1).unwrap();
        assert!(result[0].content.contains("LeafMark"));
        let access_count = store
            .memories()
            .iter()
            .find(|memory| memory.content.contains("LeafMark"))
            .unwrap()
            .access_count;
        assert_eq!(access_count, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn detects_persisted_terminal_assistant_message_and_version() {
        let root = temp_root("persisted");
        let mut store = AgentStore::load(&root).unwrap();
        let mut session = AgentSession::new();
        session.id = "s".to_owned();
        let mut assistant = message("t", AgentRole::Assistant, "done");
        assistant.version = Some(serde_json::json!({"id":"v1"}));
        session.messages.push(assistant);
        session.cursor = 1;
        store.save_session(session).unwrap();
        assert!(store.agent_turn_persisted("s", "t", Some("v1")));
        assert!(!store.agent_turn_persisted("s", "t", Some("v2")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_files_are_backed_up_without_blocking_startup() {
        let root = temp_root("corrupt");
        fs::write(root.join("sessions.json"), "not-json").unwrap();
        let store = AgentStore::load(&root).unwrap();
        assert!(store.sessions().is_empty());
        assert!(fs::read_dir(&root).unwrap().flatten().any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("sessions.corrupt-")
        }));
        fs::remove_dir_all(root).unwrap();
    }
}
