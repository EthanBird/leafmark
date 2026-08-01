//! Desktop terminal harness. Windows always launches PowerShell with
//! CREATE_NO_WINDOW, so Agent tools never flash a console window.

use parking_lot::Mutex;
use serde::Serialize;
use std::{
    collections::HashMap,
    fs::{self, File},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const MAX_CAPTURE_BYTES: usize = 120_000;

#[derive(Default, Clone)]
pub struct TerminalManager {
    jobs: Arc<Mutex<HashMap<String, BackgroundJob>>>,
}

struct BackgroundJob {
    child: Child,
    stdout_path: PathBuf,
    stderr_path: PathBuf,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResult {
    job_id: Option<String>,
    status: String,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    duration_ms: u128,
}

pub async fn execute(
    manager: TerminalManager,
    workspace: PathBuf,
    cache_dir: PathBuf,
    command: String,
    cwd: Option<String>,
    timeout_ms: u64,
    background: bool,
    allow_destructive: bool,
) -> Result<TerminalResult, String> {
    let command = command.trim().to_string();
    if command.is_empty() { return Err("终端命令不能为空".into()); }
    if background || looks_detached(&command) {
        return Err("为保证终端造成的文件修改都能完整回退，Agent 版本事务不允许后台或脱管进程；请改用会正常退出的前台命令".into());
    }
    if looks_destructive(&command) && !allow_destructive {
        return Err("命令包含删除、格式化或强制覆盖操作；请在 Agent 设置中单独允许破坏性终端命令".into());
    }
    let cwd = resolve_cwd(&workspace, cwd.as_deref())?;
    fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;
    let job_id = format!("job-{}-{}", now_ms(), rand::random::<u32>());
    let stdout_path = cache_dir.join(format!("{job_id}.stdout"));
    let stderr_path = cache_dir.join(format!("{job_id}.stderr"));
    let mut child = shell_command(&command);
    child.current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::from(File::create(&stdout_path).map_err(|error| error.to_string())?))
        .stderr(Stdio::from(File::create(&stderr_path).map_err(|error| error.to_string())?));
    let child = child.spawn().map_err(|error| format!("无法启动终端命令：{error}"))?;
    if background {
        manager.jobs.lock().insert(job_id.clone(), BackgroundJob { child, stdout_path, stderr_path });
        return Ok(TerminalResult { job_id: Some(job_id), status: "running".into(), exit_code: None, stdout: String::new(), stderr: String::new(), duration_ms: 0 });
    }
    tauri::async_runtime::spawn_blocking(move || wait_for_child(child, stdout_path, stderr_path, timeout_ms.clamp(100, 600_000)))
        .await.map_err(|error| error.to_string())?
}

pub fn status(manager: TerminalManager, job_id: String) -> Result<TerminalResult, String> {
    let mut jobs = manager.jobs.lock();
    let job = jobs.get_mut(&job_id).ok_or_else(|| format!("未找到后台任务 {job_id}"))?;
    let exit = job.child.try_wait().map_err(|error| error.to_string())?;
    let completed = exit.is_some();
    let result = TerminalResult {
        job_id: Some(job_id.clone()),
        status: if completed { "completed".into() } else { "running".into() },
        exit_code: exit.as_ref().and_then(|status| status.code()),
        stdout: read_capture(&job.stdout_path),
        stderr: read_capture(&job.stderr_path),
        duration_ms: 0,
    };
    if completed {
        if let Some(job) = jobs.remove(&job_id) { cleanup(&job.stdout_path, &job.stderr_path); }
    }
    Ok(result)
}

pub fn kill(manager: TerminalManager, job_id: String) -> Result<TerminalResult, String> {
    let mut job = manager.jobs.lock().remove(&job_id).ok_or_else(|| format!("未找到后台任务 {job_id}"))?;
    job.child.kill().map_err(|error| error.to_string())?;
    let _ = job.child.wait();
    let result = TerminalResult {
        job_id: Some(job_id), status: "killed".into(), exit_code: None,
        stdout: read_capture(&job.stdout_path), stderr: read_capture(&job.stderr_path), duration_ms: 0,
    };
    cleanup(&job.stdout_path, &job.stderr_path);
    Ok(result)
}

fn wait_for_child(mut child: Child, stdout_path: PathBuf, stderr_path: PathBuf, timeout_ms: u64) -> Result<TerminalResult, String> {
    let started = Instant::now();
    let timeout = Duration::from_millis(timeout_ms);
    let (status, exit_code) = loop {
        if let Some(exit) = child.try_wait().map_err(|error| error.to_string())? {
            break ("completed".to_string(), exit.code());
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            break ("timed_out".to_string(), None);
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    let result = TerminalResult {
        job_id: None, status, exit_code,
        stdout: read_capture(&stdout_path), stderr: read_capture(&stderr_path),
        duration_ms: started.elapsed().as_millis(),
    };
    cleanup(&stdout_path, &stderr_path);
    Ok(result)
}

#[cfg(windows)]
fn shell_command(script: &str) -> Command {
    let mut command = Command::new("powershell.exe");
    let script = format!("$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); {script}");
    command.creation_flags(CREATE_NO_WINDOW)
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"])
        .arg(script);
    command
}

#[cfg(not(windows))]
fn shell_command(script: &str) -> Command {
    let mut command = Command::new("/bin/sh");
    command.args(["-lc", script]);
    command
}

fn resolve_cwd(workspace: &Path, relative: Option<&str>) -> Result<PathBuf, String> {
    let workspace = workspace.canonicalize().map_err(|error| error.to_string())?;
    let target = match relative.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => workspace.join(value),
        None => workspace.clone(),
    };
    let target = target.canonicalize().map_err(|error| format!("终端工作目录不存在：{error}"))?;
    if !target.starts_with(&workspace) { return Err("终端工作目录必须位于当前文档库内".into()); }
    if !target.is_dir() { return Err("终端工作目录不是文件夹".into()); }
    Ok(target)
}

fn looks_destructive(command: &str) -> bool {
    let value = command.to_ascii_lowercase();
    let words = format!(" {} ", value.replace(|character: char| matches!(character, '\n' | '\r' | ';' | '|' | '&'), " "));
    ["remove-item", " erase ", "format-volume", "clear-disk", " rmdir ", "git reset --hard", "git clean -", " truncate ", "> /dev/", "drop table", "drop database"]
        .iter().any(|needle| value.contains(needle))
        || [" rm ", " del ", " rd "].iter().any(|needle| words.contains(needle))
}

fn looks_detached(command: &str) -> bool {
    let value = command.to_ascii_lowercase();
    [
        "start-process", "start-job", "start-threadjob", "register-scheduledtask",
        "schtasks ", "cmd /c start", "cmd.exe /c start", " nohup ", " disown",
        " setsid ",
    ].iter().any(|needle| value.contains(needle))
        || value.trim_end().ends_with('&')
}

fn read_capture(path: &Path) -> String {
    let bytes = fs::read(path).unwrap_or_default();
    let start = bytes.len().saturating_sub(MAX_CAPTURE_BYTES);
    String::from_utf8_lossy(&bytes[start..]).into_owned()
}

fn cleanup(stdout: &Path, stderr: &Path) { let _ = fs::remove_file(stdout); let _ = fs::remove_file(stderr); }

fn now_ms() -> u128 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destructive_commands_are_gated() {
        assert!(looks_destructive("Remove-Item -Recurse .\\build"));
        assert!(looks_destructive("git reset --hard HEAD"));
        assert!(looks_destructive("rm notes.md"));
        assert!(looks_destructive("del notes.md"));
        assert!(!looks_destructive("Get-ChildItem | Select-Object Name"));
    }

    #[test]
    fn detached_processes_are_gated_for_complete_version_capture() {
        assert!(looks_detached("Start-Process powershell -ArgumentList test.ps1"));
        assert!(looks_detached("nohup ./writer &"));
        assert!(looks_detached("./writer &"));
        assert!(!looks_detached("cargo test"));
    }
}
