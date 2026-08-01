//! Git-free, Agent-native version history.
//!
//! Each Agent turn captures the complete workspace before and after execution.
//! File bytes live in an immutable SHA-256 content-addressed store, while the
//! journal only records paths whose states changed. Undo and redo restore those
//! bytes; terminal commands are never executed again during redo.

use crate::{atomic_write, library::DocumentArchive};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const INDEX_VERSION: u32 = 1;
const MAX_SNAPSHOT_FILES: usize = 20_000;
const MAX_SNAPSHOT_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VersionChangeSummary {
    pub target: String,
    pub kind: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VersionSummary {
    pub id: String,
    pub session_id: String,
    pub turn_id: String,
    pub label: String,
    pub created_ms: u64,
    pub outcome: String,
    pub changes: Vec<VersionChangeSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VersionOperation {
    pub version: VersionSummary,
    pub direction: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VersionStatus {
    pub undo: Option<VersionSummary>,
    pub redo: Option<VersionSummary>,
    pub pending: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum EntryKind {
    File,
    Directory,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct BlobRef {
    sha256: String,
    size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct EntryState {
    kind: EntryKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    blob: Option<BlobRef>,
    #[serde(default)]
    readonly: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "scope", rename_all = "snake_case")]
enum ChangeTarget {
    Workspace { path: String },
    Archive { id: String, name: String },
}

impl ChangeTarget {
    fn display(&self) -> String {
        match self {
            Self::Workspace { path } => path.clone(),
            Self::Archive { name, .. } => format!("保留副本/{name}"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FileChange {
    target: ChangeTarget,
    before: Option<EntryState>,
    after: Option<EntryState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Snapshot {
    workspace: BTreeMap<String, EntryState>,
    archive: Option<ArchiveState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ArchiveState {
    id: String,
    name: String,
    state: EntryState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingTurn {
    id: String,
    session_id: String,
    turn_id: String,
    label: String,
    created_ms: u64,
    workspace_key: String,
    before: Snapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct VersionRecord {
    id: String,
    session_id: String,
    turn_id: String,
    label: String,
    created_ms: u64,
    outcome: String,
    workspace_key: String,
    parent: Option<String>,
    changes: Vec<FileChange>,
}

impl VersionRecord {
    fn summary(&self) -> VersionSummary {
        VersionSummary {
            id: self.id.clone(),
            session_id: self.session_id.clone(),
            turn_id: self.turn_id.clone(),
            label: self.label.clone(),
            created_ms: self.created_ms,
            outcome: self.outcome.clone(),
            changes: self.changes.iter().map(change_summary).collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct WorkspaceRef {
    head: Option<String>,
    #[serde(default)]
    redo: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct VcsIndex {
    #[serde(default = "index_version")]
    version: u32,
    #[serde(default)]
    workspaces: HashMap<String, WorkspaceRef>,
    #[serde(default)]
    versions: Vec<VersionRecord>,
    #[serde(default)]
    pending: Vec<PendingTurn>,
}

impl Default for VcsIndex {
    fn default() -> Self {
        Self {
            version: INDEX_VERSION,
            workspaces: HashMap::new(),
            versions: Vec::new(),
            pending: Vec::new(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct RecoveryJournal {
    version_id: String,
    direction: String,
    workspace_root: String,
    created_ms: u64,
}

pub(crate) struct AgentVcs {
    root: PathBuf,
    objects_dir: PathBuf,
    index_path: PathBuf,
    recovery_path: PathBuf,
    index: VcsIndex,
}

impl AgentVcs {
    pub(crate) fn load(root: PathBuf) -> Result<Self, String> {
        let objects_dir = root.join("objects");
        fs::create_dir_all(&objects_dir).map_err(error_string)?;
        let index_path = root.join("index.json");
        let recovery_path = root.join("recovery.json");
        let index = match fs::read(&index_path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|_| VcsIndex::default()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => VcsIndex::default(),
            Err(error) => return Err(error_string(error)),
        };
        let store = Self { root, objects_dir, index_path, recovery_path, index };
        store.persist()?;
        Ok(store)
    }

    pub(crate) fn begin_turn(
        &mut self,
        workspace: &Path,
        library: &DocumentArchive,
        session_id: String,
        turn_id: String,
        label: String,
        archive_id: Option<String>,
    ) -> Result<(), String> {
        if self.index.pending.iter().any(|pending| pending.turn_id == turn_id) {
            return Err("该 Agent 回合已经建立版本检查点".into());
        }
        let workspace = workspace.canonicalize().map_err(error_string)?;
        let workspace_key = workspace_key(&workspace);
        if self.index.pending.iter().any(|pending| pending.workspace_key == workspace_key) {
            return Err("当前文档库已有一个尚未完成的 Agent 回合".into());
        }
        let before = self.capture_snapshot(&workspace, library, archive_id.as_deref())?;
        let id = unique_id("turn", &turn_id);
        let previous_index = self.index.clone();
        self.index.pending.push(PendingTurn {
            id,
            session_id,
            turn_id,
            label: compact_label(&label),
            created_ms: now_ms(),
            workspace_key: workspace_key.clone(),
            before,
        });
        self.index.workspaces.entry(workspace_key).or_default().redo.clear();
        if let Err(error) = self.persist() {
            self.index = previous_index;
            return Err(error);
        }
        Ok(())
    }

    /// A turn is persisted as `pending` before the model or a tool can mutate
    /// files. If LeafMark exits unexpectedly, the next launch captures the
    /// on-disk state as a recovered after-snapshot instead of leaving anonymous
    /// dirty state that can never be undone.
    pub(crate) fn recover_pending(
        &mut self,
        workspace: &Path,
        library: &DocumentArchive,
    ) -> Result<Vec<VersionSummary>, String> {
        let workspace = workspace.canonicalize().map_err(error_string)?;
        let key = workspace_key(&workspace);
        let turns: Vec<String> = self.index.pending.iter()
            .filter(|pending| pending.workspace_key == key)
            .map(|pending| pending.turn_id.clone())
            .collect();
        let mut recovered = Vec::new();
        for turn_id in turns {
            recovered.push(self.finish_turn(&workspace, library, &turn_id, "recovered")?);
        }
        Ok(recovered)
    }

    pub(crate) fn recover_restore(
        &mut self,
        workspace: &Path,
        library: &mut DocumentArchive,
    ) -> Result<bool, String> {
        let bytes = match fs::read(&self.recovery_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error_string(error)),
        };
        let journal: RecoveryJournal = serde_json::from_slice(&bytes).map_err(error_string)?;
        let workspace = workspace.canonicalize().map_err(error_string)?;
        if workspace_key(&workspace) != workspace_key(Path::new(&journal.workspace_root)) {
            return Err("检测到另一个文档库尚未完成的 Agent 文件恢复，请切回原文档库后重启 LeafMark".into());
        }
        let record = self.record(&journal.version_id).cloned()
            .ok_or_else(|| "恢复日志引用的 Agent 版本不存在".to_string())?;
        let redo = journal.direction == "redo";
        let key = record.workspace_key.clone();
        let reference = self.index.workspaces.get(&key).cloned().unwrap_or_default();
        let ref_already_moved = if redo {
            reference.head.as_deref() == Some(record.id.as_str())
        } else {
            reference.head == record.parent && reference.redo.last().is_some_and(|id| id == &record.id)
        };
        if !ref_already_moved {
            let desired: Vec<Option<EntryState>> = record.changes.iter().map(|change| {
                if redo { change.after.clone() } else { change.before.clone() }
            }).collect();
            self.apply_states(&workspace, library, &record.changes, &desired)?;
            let workspace_ref = self.index.workspaces.entry(key).or_default();
            if redo {
                if workspace_ref.redo.last().is_some_and(|id| id == &record.id) {
                    workspace_ref.redo.pop();
                }
                workspace_ref.head = Some(record.id.clone());
            } else {
                workspace_ref.head = record.parent.clone();
                if !workspace_ref.redo.iter().any(|id| id == &record.id) {
                    workspace_ref.redo.push(record.id.clone());
                }
            }
            self.persist()?;
        }
        let _ = fs::remove_file(&self.recovery_path);
        Ok(true)
    }

    pub(crate) fn finish_turn(
        &mut self,
        workspace: &Path,
        library: &DocumentArchive,
        turn_id: &str,
        outcome: &str,
    ) -> Result<VersionSummary, String> {
        let position = self.index.pending.iter().position(|pending| pending.turn_id == turn_id)
            .ok_or_else(|| "找不到该 Agent 回合的版本检查点".to_string())?;
        let pending = self.index.pending[position].clone();
        let workspace = workspace.canonicalize().map_err(error_string)?;
        if workspace_key(&workspace) != pending.workspace_key {
            return Err("Agent 工作期间文档库发生切换，无法安全提交版本".into());
        }
        let archive_id = pending.before.archive.as_ref().map(|archive| archive.id.as_str());
        let after = self.capture_snapshot(&workspace, library, archive_id)?;
        let changes = diff_snapshots(&pending.before, &after);
        let parent = self.index.workspaces.entry(pending.workspace_key.clone()).or_default().head.clone();
        let record = VersionRecord {
            id: pending.id,
            session_id: pending.session_id,
            turn_id: pending.turn_id,
            label: pending.label,
            created_ms: pending.created_ms,
            outcome: normalize_outcome(outcome),
            workspace_key: pending.workspace_key.clone(),
            parent,
            changes,
        };
        let summary = record.summary();
        let previous_index = self.index.clone();
        self.index.pending.remove(position);
        self.index.versions.push(record);
        let workspace_ref = self.index.workspaces.entry(pending.workspace_key).or_default();
        workspace_ref.head = Some(summary.id.clone());
        workspace_ref.redo.clear();
        if let Err(error) = self.persist() {
            self.index = previous_index;
            return Err(error);
        }
        let _ = self.gc_objects();
        Ok(summary)
    }

    pub(crate) fn status(&self, workspace: &Path) -> Result<VersionStatus, String> {
        let workspace = workspace.canonicalize().map_err(error_string)?;
        let key = workspace_key(&workspace);
        let reference = self.index.workspaces.get(&key).cloned().unwrap_or_default();
        Ok(VersionStatus {
            undo: reference.head.as_deref().and_then(|id| self.record(id)).map(VersionRecord::summary),
            redo: reference.redo.last().and_then(|id| self.record(id)).map(VersionRecord::summary),
            pending: self.index.pending.iter().any(|pending| pending.workspace_key == key),
        })
    }

    pub(crate) fn undo(
        &mut self,
        workspace: &Path,
        library: &mut DocumentArchive,
    ) -> Result<VersionOperation, String> {
        self.move_head(workspace, library, false)
    }

    pub(crate) fn redo(
        &mut self,
        workspace: &Path,
        library: &mut DocumentArchive,
    ) -> Result<VersionOperation, String> {
        self.move_head(workspace, library, true)
    }

    fn move_head(
        &mut self,
        workspace: &Path,
        library: &mut DocumentArchive,
        redo: bool,
    ) -> Result<VersionOperation, String> {
        let workspace = workspace.canonicalize().map_err(error_string)?;
        let key = workspace_key(&workspace);
        if self.index.pending.iter().any(|pending| pending.workspace_key == key) {
            return Err("Agent 仍在执行，暂时不能回退文件".into());
        }
        let reference = self.index.workspaces.get(&key).cloned().unwrap_or_default();
        let version_id = if redo {
            reference.redo.last().cloned().ok_or_else(|| "没有可重做的 Agent 版本".to_string())?
        } else {
            reference.head.clone().ok_or_else(|| "没有可回退的 Agent 版本".to_string())?
        };
        let record = self.record(&version_id).cloned().ok_or_else(|| "版本记录已经丢失".to_string())?;
        if record.workspace_key != key {
            return Err("版本不属于当前文档库".into());
        }
        if redo && record.parent != reference.head {
            return Err("重做分支已经被新的 Agent 修改取代".into());
        }
        self.restore_record(&workspace, library, &record, redo)?;

        let previous_reference = reference.clone();
        let workspace_ref = self.index.workspaces.entry(key).or_default();
        if redo {
            workspace_ref.redo.pop();
            workspace_ref.head = Some(record.id.clone());
        } else {
            workspace_ref.head = record.parent.clone();
            workspace_ref.redo.push(record.id.clone());
        }
        if let Err(error) = self.persist() {
            self.index.workspaces.insert(record.workspace_key.clone(), previous_reference);
            let rollback = self.restore_record(&workspace, library, &record, !redo);
            if rollback.is_ok() { let _ = fs::remove_file(&self.recovery_path); }
            return Err(match rollback {
                Ok(()) => format!("版本游标保存失败，文件已恢复原状：{error}"),
                Err(rollback_error) => format!("版本游标保存失败且文件恢复未完成：{error}；{rollback_error}"),
            });
        }
        let _ = fs::remove_file(&self.recovery_path);
        Ok(VersionOperation {
            version: record.summary(),
            direction: if redo { "redo" } else { "undo" }.into(),
        })
    }

    fn restore_record(
        &self,
        workspace: &Path,
        library: &mut DocumentArchive,
        record: &VersionRecord,
        redo: bool,
    ) -> Result<(), String> {
        let expected: Vec<Option<EntryState>> = record.changes.iter().map(|change| {
            if redo { change.before.clone() } else { change.after.clone() }
        }).collect();
        let desired: Vec<Option<EntryState>> = record.changes.iter().map(|change| {
            if redo { change.after.clone() } else { change.before.clone() }
        }).collect();
        let mut conflicts = Vec::new();
        let mut backups = Vec::with_capacity(record.changes.len());
        for (index, change) in record.changes.iter().enumerate() {
            let current = self.current_target_state(workspace, library, &change.target)?;
            if current != expected[index] {
                conflicts.push(change.target.display());
            }
            backups.push(current);
        }
        if !conflicts.is_empty() {
            return Err(format!(
                "这些文件在 Agent 修改后又发生了变化，为避免覆盖已停止回退：{}",
                conflicts.join("、")
            ));
        }

        let journal = RecoveryJournal {
            version_id: record.id.clone(),
            direction: if redo { "redo" } else { "undo" }.into(),
            workspace_root: workspace.to_string_lossy().into_owned(),
            created_ms: now_ms(),
        };
        atomic_write(&self.recovery_path, &serde_json::to_vec_pretty(&journal).map_err(error_string)?)?;

        if let Err(error) = self.apply_states(workspace, library, &record.changes, &desired) {
            let rollback = self.apply_states(workspace, library, &record.changes, &backups);
            if rollback.is_ok() { let _ = fs::remove_file(&self.recovery_path); }
            return Err(match rollback {
                Ok(()) => format!("回退写入失败，文件已恢复原状：{error}"),
                Err(rollback_error) => format!("回退写入失败且自动恢复未完成：{error}；{rollback_error}"),
            });
        }
        Ok(())
    }

    fn apply_states(
        &self,
        workspace: &Path,
        library: &mut DocumentArchive,
        changes: &[FileChange],
        states: &[Option<EntryState>],
    ) -> Result<(), String> {
        // Replace/remove regular files first so file<->directory transitions are safe.
        for (index, change) in changes.iter().enumerate() {
            let ChangeTarget::Workspace { path } = &change.target else { continue };
            let target = secure_workspace_target(workspace, path)?;
            let desired_file = states[index].as_ref().is_some_and(|state| state.kind == EntryKind::File);
            if target.is_file() && !desired_file {
                make_writable(&target);
                fs::remove_file(&target).map_err(|error| format!("无法移除 {path}：{error}"))?;
            }
        }
        let mut directory_removals: Vec<(usize, &str)> = changes.iter().enumerate().filter_map(|(index, change)| {
            let ChangeTarget::Workspace { path } = &change.target else { return None };
            let desired_directory = states[index].as_ref().is_some_and(|state| state.kind == EntryKind::Directory);
            (!desired_directory).then_some((index, path.as_str()))
        }).collect();
        directory_removals.sort_by_key(|(_, path)| std::cmp::Reverse(path.matches('/').count()));
        for (_, path) in directory_removals {
            let target = secure_workspace_target(workspace, path)?;
            if target.is_dir() {
                make_writable(&target);
                fs::remove_dir(&target).map_err(|error| format!("无法移除目录 {path}：{error}"))?;
            }
        }

        let mut directory_creations: Vec<(usize, &str)> = changes.iter().enumerate().filter_map(|(index, change)| {
            let ChangeTarget::Workspace { path } = &change.target else { return None };
            states[index].as_ref().is_some_and(|state| state.kind == EntryKind::Directory).then_some((index, path.as_str()))
        }).collect();
        directory_creations.sort_by_key(|(_, path)| path.matches('/').count());
        for (index, path) in directory_creations {
            let target = secure_workspace_target(workspace, path)?;
            fs::create_dir_all(&target).map_err(|error| format!("无法恢复目录 {path}：{error}"))?;
            set_readonly(&target, states[index].as_ref().is_some_and(|state| state.readonly))?;
        }

        for (index, change) in changes.iter().enumerate() {
            match &change.target {
                ChangeTarget::Workspace { path } => {
                    let Some(state) = &states[index] else { continue };
                    if state.kind != EntryKind::File { continue; }
                    let blob = state.blob.as_ref().ok_or_else(|| format!("版本对象缺少文件内容：{path}"))?;
                    let bytes = self.read_blob(blob)?;
                    let target = secure_workspace_target(workspace, path)?;
                    if let Some(parent) = target.parent() { fs::create_dir_all(parent).map_err(error_string)?; }
                    make_writable(&target);
                    atomic_write(&target, &bytes).map_err(|error| format!("无法恢复 {path}：{error}"))?;
                    set_readonly(&target, state.readonly)?;
                }
                ChangeTarget::Archive { id, .. } => {
                    let state = states[index].as_ref().ok_or_else(|| "保留副本不能被版本操作删除".to_string())?;
                    let blob = state.blob.as_ref().ok_or_else(|| "保留副本版本对象缺失".to_string())?;
                    library.vcs_restore(id, &self.read_blob(blob)?)?;
                }
            }
        }
        Ok(())
    }

    fn capture_snapshot(
        &mut self,
        workspace: &Path,
        library: &DocumentArchive,
        archive_id: Option<&str>,
    ) -> Result<Snapshot, String> {
        let mut files = 0usize;
        let mut bytes = 0u64;
        let mut workspace_entries = BTreeMap::new();
        self.capture_directory(workspace, workspace, &mut workspace_entries, &mut files, &mut bytes)?;
        let archive = match archive_id {
            Some(id) => {
                let (name, content) = library.vcs_snapshot(id)?;
                let blob = self.store_blob(&content)?;
                Some(ArchiveState {
                    id: id.into(),
                    name,
                    state: EntryState { kind: EntryKind::File, blob: Some(blob), readonly: false },
                })
            }
            None => None,
        };
        Ok(Snapshot { workspace: workspace_entries, archive })
    }

    fn capture_directory(
        &mut self,
        root: &Path,
        directory: &Path,
        entries: &mut BTreeMap<String, EntryState>,
        files: &mut usize,
        bytes: &mut u64,
    ) -> Result<(), String> {
        let mut children = fs::read_dir(directory).map_err(|error| format!("无法扫描 {}：{error}", directory.display()))?
            .collect::<Result<Vec<_>, _>>().map_err(error_string)?;
        children.sort_by_key(|entry| entry.file_name());
        for child in children {
            let path = child.path();
            let metadata = fs::symlink_metadata(&path).map_err(error_string)?;
            let relative = path.strip_prefix(root).map_err(error_string)?;
            let key = portable_relative_path(relative)?;
            if metadata.file_type().is_symlink() {
                return Err(format!("文档库包含符号链接或 Windows 重解析点，无法提供完整回退：{key}"));
            }
            if metadata.is_dir() {
                entries.insert(key, EntryState { kind: EntryKind::Directory, blob: None, readonly: metadata.permissions().readonly() });
                self.capture_directory(root, &path, entries, files, bytes)?;
            } else if metadata.is_file() {
                *files += 1;
                *bytes = bytes.saturating_add(metadata.len());
                if *files > MAX_SNAPSHOT_FILES || *bytes > MAX_SNAPSHOT_BYTES {
                    return Err(format!(
                        "文档库超过 Agent 版本控制上限（最多 {MAX_SNAPSHOT_FILES} 个文件、1 GiB），为避免产生不可回退修改，本轮未启动"
                    ));
                }
                let content = fs::read(&path).map_err(|error| format!("无法读取 {key} 以建立版本：{error}"))?;
                let blob = self.store_blob(&content)?;
                entries.insert(key, EntryState { kind: EntryKind::File, blob: Some(blob), readonly: metadata.permissions().readonly() });
            } else {
                return Err(format!("文档库包含无法版本化的特殊文件：{key}"));
            }
        }
        Ok(())
    }

    fn current_target_state(
        &self,
        workspace: &Path,
        library: &DocumentArchive,
        target: &ChangeTarget,
    ) -> Result<Option<EntryState>, String> {
        match target {
            ChangeTarget::Workspace { path } => {
                let target = secure_workspace_target(workspace, path)?;
                match fs::symlink_metadata(&target) {
                    Ok(metadata) if metadata.file_type().is_symlink() => Err(format!("目标已变成符号链接，拒绝覆盖：{path}")),
                    Ok(metadata) if metadata.is_dir() => Ok(Some(EntryState { kind: EntryKind::Directory, blob: None, readonly: metadata.permissions().readonly() })),
                    Ok(metadata) if metadata.is_file() => {
                        let content = fs::read(&target).map_err(error_string)?;
                        Ok(Some(EntryState {
                            kind: EntryKind::File,
                            blob: Some(blob_ref(&content)),
                            readonly: metadata.permissions().readonly(),
                        }))
                    }
                    Ok(_) => Err(format!("目标是无法版本化的特殊文件：{path}")),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
                    Err(error) => Err(error_string(error)),
                }
            }
            ChangeTarget::Archive { id, .. } => {
                let (_, content) = library.vcs_snapshot(id)?;
                Ok(Some(EntryState { kind: EntryKind::File, blob: Some(blob_ref(&content)), readonly: false }))
            }
        }
    }

    fn store_blob(&mut self, bytes: &[u8]) -> Result<BlobRef, String> {
        let blob = blob_ref(bytes);
        let path = self.blob_path(&blob.sha256);
        if !path.is_file() {
            if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(error_string)?; }
            atomic_write(&path, bytes)?;
        }
        Ok(blob)
    }

    fn read_blob(&self, blob: &BlobRef) -> Result<Vec<u8>, String> {
        let bytes = fs::read(self.blob_path(&blob.sha256))
            .map_err(|error| format!("版本内容对象 {} 无法读取：{error}", blob.sha256))?;
        if blob_ref(&bytes) != *blob {
            return Err(format!("版本内容对象校验失败：{}", blob.sha256));
        }
        Ok(bytes)
    }

    fn blob_path(&self, hash: &str) -> PathBuf {
        let (prefix, suffix) = hash.split_at(2);
        self.objects_dir.join(prefix).join(suffix)
    }

    fn record(&self, id: &str) -> Option<&VersionRecord> {
        self.index.versions.iter().find(|record| record.id == id)
    }

    fn persist(&self) -> Result<(), String> {
        fs::create_dir_all(&self.root).map_err(error_string)?;
        let bytes = serde_json::to_vec_pretty(&self.index).map_err(error_string)?;
        atomic_write(&self.index_path, &bytes)
    }

    fn gc_objects(&self) -> Result<(), String> {
        let mut referenced = HashSet::new();
        for record in &self.index.versions {
            for change in &record.changes {
                for state in [&change.before, &change.after].into_iter().flatten() {
                    if let Some(blob) = &state.blob { referenced.insert(blob.sha256.clone()); }
                }
            }
        }
        for pending in &self.index.pending {
            for state in pending.before.workspace.values() {
                if let Some(blob) = &state.blob { referenced.insert(blob.sha256.clone()); }
            }
            if let Some(blob) = pending.before.archive.as_ref().and_then(|archive| archive.state.blob.as_ref()) {
                referenced.insert(blob.sha256.clone());
            }
        }
        for prefix in fs::read_dir(&self.objects_dir).map_err(error_string)? {
            let prefix = prefix.map_err(error_string)?;
            if !prefix.file_type().map_err(error_string)?.is_dir() { continue; }
            let prefix_name = prefix.file_name().to_string_lossy().into_owned();
            for object in fs::read_dir(prefix.path()).map_err(error_string)? {
                let object = object.map_err(error_string)?;
                if !object.file_type().map_err(error_string)?.is_file() { continue; }
                let hash = format!("{prefix_name}{}", object.file_name().to_string_lossy());
                if !referenced.contains(&hash) { let _ = fs::remove_file(object.path()); }
            }
            let _ = fs::remove_dir(prefix.path());
        }
        Ok(())
    }
}

fn diff_snapshots(before: &Snapshot, after: &Snapshot) -> Vec<FileChange> {
    let keys: BTreeSet<&String> = before.workspace.keys().chain(after.workspace.keys()).collect();
    let mut changes: Vec<FileChange> = keys.into_iter().filter_map(|path| {
        let left = before.workspace.get(path);
        let right = after.workspace.get(path);
        (left != right).then(|| FileChange {
            target: ChangeTarget::Workspace { path: path.clone() },
            before: left.cloned(),
            after: right.cloned(),
        })
    }).collect();
    match (&before.archive, &after.archive) {
        (Some(left), Some(right)) if left.id == right.id && left.state != right.state => changes.push(FileChange {
            target: ChangeTarget::Archive { id: left.id.clone(), name: left.name.clone() },
            before: Some(left.state.clone()),
            after: Some(right.state.clone()),
        }),
        _ => {}
    }
    changes
}

fn change_summary(change: &FileChange) -> VersionChangeSummary {
    let kind = match (&change.before, &change.after) {
        (None, Some(_)) => "created",
        (Some(_), None) => "deleted",
        _ => "modified",
    };
    let size = change.after.as_ref().or(change.before.as_ref())
        .and_then(|state| state.blob.as_ref()).map_or(0, |blob| blob.size);
    VersionChangeSummary { target: change.target.display(), kind: kind.into(), size }
}

fn blob_ref(bytes: &[u8]) -> BlobRef {
    let digest = Sha256::digest(bytes);
    BlobRef { sha256: hex(&digest), size: bytes.len() as u64 }
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    output
}

fn workspace_key(workspace: &Path) -> String {
    let value = workspace.to_string_lossy().replace('\\', "/");
    let normalized = if cfg!(windows) { value.to_lowercase() } else { value };
    hex(&Sha256::digest(normalized.as_bytes()))
}

fn portable_relative_path(path: &Path) -> Result<String, String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_str()
                .ok_or_else(|| "版本控制不支持无法表示为 Unicode 的文件名".to_string())?
                .to_string()),
            _ => return Err("版本路径包含无效组件".into()),
        }
    }
    if parts.is_empty() { return Err("版本路径不能为空".into()); }
    Ok(parts.join("/"))
}

fn secure_workspace_target(workspace: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if path.is_absolute() { return Err("版本路径不能是绝对路径".into()); }
    for component in path.components() {
        if !matches!(component, Component::Normal(_)) { return Err(format!("版本路径无效：{relative}")); }
    }
    let target = workspace.join(path);
    let mut ancestor = target.parent();
    while let Some(path) = ancestor {
        if path == workspace { break; }
        if let Ok(metadata) = fs::symlink_metadata(path) {
            if metadata.file_type().is_symlink() { return Err(format!("版本路径经过符号链接：{relative}")); }
        }
        ancestor = path.parent();
    }
    Ok(target)
}

fn set_readonly(path: &Path, readonly: bool) -> Result<(), String> {
    let mut permissions = fs::metadata(path).map_err(error_string)?.permissions();
    if permissions.readonly() != readonly {
        permissions.set_readonly(readonly);
        fs::set_permissions(path, permissions).map_err(error_string)?;
    }
    Ok(())
}

fn make_writable(path: &Path) {
    if !path.exists() { return; }
    if let Ok(metadata) = fs::metadata(path) {
        let mut permissions = metadata.permissions();
        if permissions.readonly() {
            permissions.set_readonly(false);
            let _ = fs::set_permissions(path, permissions);
        }
    }
}

fn compact_label(value: &str) -> String {
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if value.chars().count() <= 80 { value } else { format!("{}…", value.chars().take(80).collect::<String>()) }
}

fn normalize_outcome(value: &str) -> String {
    match value { "completed" | "failed" | "interrupted" | "recovered" => value.into(), _ => "completed".into() }
}

fn unique_id(prefix: &str, seed: &str) -> String {
    let input = format!("{prefix}:{seed}:{}:{}", now_ms(), std::process::id());
    format!("{prefix}-{}", &hex(&Sha256::digest(input.as_bytes()))[..24])
}

fn index_version() -> u32 { INDEX_VERSION }
fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
fn error_string(error: impl ToString) -> String { error.to_string() }

#[cfg(test)]
mod tests {
    use super::*;

    fn root(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("leafmark-agent-vcs-{name}-{}", unique_id("test", name)));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn workspace_files_and_binary_bytes_undo_and_redo_exactly() {
        let base = root("roundtrip");
        let workspace = base.join("workspace");
        let archive_root = base.join("archive");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join("中文.md"), b"before\r\n").unwrap();
        fs::write(workspace.join("bytes.bin"), [0_u8, 159, 255, 1]).unwrap();
        let mut library = DocumentArchive::load(archive_root).unwrap();
        let mut vcs = AgentVcs::load(base.join("vcs")).unwrap();

        vcs.begin_turn(&workspace, &library, "session".into(), "turn".into(), "修改文件".into(), None).unwrap();
        fs::write(workspace.join("中文.md"), b"after\n").unwrap();
        fs::remove_file(workspace.join("bytes.bin")).unwrap();
        fs::create_dir(workspace.join("nested")).unwrap();
        fs::write(workspace.join("nested/new.bin"), [9_u8, 0, 8]).unwrap();
        let version = vcs.finish_turn(&workspace, &library, "turn", "completed").unwrap();
        assert_eq!(version.changes.len(), 4);

        vcs.undo(&workspace, &mut library).unwrap();
        assert_eq!(fs::read(workspace.join("中文.md")).unwrap(), b"before\r\n");
        assert_eq!(fs::read(workspace.join("bytes.bin")).unwrap(), [0, 159, 255, 1]);
        assert!(!workspace.join("nested").exists());

        vcs.redo(&workspace, &mut library).unwrap();
        assert_eq!(fs::read(workspace.join("中文.md")).unwrap(), b"after\n");
        assert!(!workspace.join("bytes.bin").exists());
        assert_eq!(fs::read(workspace.join("nested/new.bin")).unwrap(), [9, 0, 8]);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn refuses_to_overwrite_manual_changes() {
        let base = root("conflict");
        let workspace = base.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join("note.md"), "one").unwrap();
        let mut library = DocumentArchive::load(base.join("archive")).unwrap();
        let mut vcs = AgentVcs::load(base.join("vcs")).unwrap();
        vcs.begin_turn(&workspace, &library, "session".into(), "turn".into(), "修改".into(), None).unwrap();
        fs::write(workspace.join("note.md"), "two").unwrap();
        vcs.finish_turn(&workspace, &library, "turn", "completed").unwrap();
        fs::write(workspace.join("note.md"), "manual").unwrap();
        let error = vcs.undo(&workspace, &mut library).unwrap_err();
        assert!(error.contains("又发生了变化"));
        assert_eq!(fs::read_to_string(workspace.join("note.md")).unwrap(), "manual");
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn startup_finishes_a_restore_left_between_files_and_ref_update() {
        let base = root("recovery");
        let workspace = base.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join("note.md"), "before").unwrap();
        let mut library = DocumentArchive::load(base.join("archive")).unwrap();
        let vcs_root = base.join("vcs");
        let mut vcs = AgentVcs::load(vcs_root.clone()).unwrap();
        vcs.begin_turn(&workspace, &library, "session".into(), "turn".into(), "恢复测试".into(), None).unwrap();
        fs::write(workspace.join("note.md"), "after").unwrap();
        let version = vcs.finish_turn(&workspace, &library, "turn", "completed").unwrap();
        let record = vcs.record(&version.id).unwrap().clone();
        let desired: Vec<Option<EntryState>> = record.changes.iter().map(|change| change.before.clone()).collect();
        let journal = RecoveryJournal {
            version_id: version.id.clone(), direction: "undo".into(),
            workspace_root: workspace.canonicalize().unwrap().to_string_lossy().into_owned(), created_ms: now_ms(),
        };
        atomic_write(&vcs.recovery_path, &serde_json::to_vec(&journal).unwrap()).unwrap();
        vcs.apply_states(&workspace, &mut library, &record.changes, &desired).unwrap();
        drop(vcs);

        let mut recovered = AgentVcs::load(vcs_root).unwrap();
        assert!(recovered.recover_restore(&workspace, &mut library).unwrap());
        assert_eq!(fs::read_to_string(workspace.join("note.md")).unwrap(), "before");
        let status = recovered.status(&workspace).unwrap();
        assert!(status.undo.is_none());
        assert_eq!(status.redo.unwrap().id, version.id);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn retained_document_versions_never_write_the_external_source() {
        let base = root("archive-copy");
        let workspace = base.join("workspace");
        let source_dir = base.join("source");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&source_dir).unwrap();
        let source = source_dir.join("wechat.md");
        fs::write(&source, "微信原文").unwrap();
        let mut library = DocumentArchive::load(base.join("archive")).unwrap();
        let archived = library.open_source(&source).unwrap();
        let id = archived.entry.id;
        let mut vcs = AgentVcs::load(base.join("vcs")).unwrap();
        vcs.begin_turn(&workspace, &library, "session".into(), "turn".into(), "修改保留副本".into(), Some(id.clone())).unwrap();
        library.write(&id, "LeafMark 编辑").unwrap();
        vcs.finish_turn(&workspace, &library, "turn", "completed").unwrap();
        vcs.undo(&workspace, &mut library).unwrap();
        assert_eq!(String::from_utf8(library.vcs_snapshot(&id).unwrap().1).unwrap(), "微信原文");
        assert_eq!(fs::read_to_string(&source).unwrap(), "微信原文");
        vcs.redo(&workspace, &mut library).unwrap();
        assert_eq!(String::from_utf8(library.vcs_snapshot(&id).unwrap().1).unwrap(), "LeafMark 编辑");
        assert_eq!(fs::read_to_string(&source).unwrap(), "微信原文");
        let _ = fs::remove_dir_all(base);
    }
}
