# LeafMark Native

这是 LeafMark 从 Tauri/WebView 迁移到 Dioxus Native 的并行开发工作区。当前正式版仍保留在仓库根目录；`native/` 不参与现有 Tauri 发布流程，也不会改变 0.7.x 用户数据。

## 当前里程碑：N0 原生骨架

- 独立 Cargo Workspace，不干扰现有 Node/Tauri 构建；
- `leafmark-domain`：稳定的跨 UI 数据模型；
- `leafmark-core`：多文档标签和 Dock 布局纯 Rust 状态机；
- `leafmark-native`：Dioxus Native/WGPU 原型外壳；
- Native CI：单元测试、Clippy 和 Dioxus Native 编译检查。

当前原型只验证应用壳层与状态边界。Markdown 原生文档画布、IME、公式、Mermaid、导出和 Agent 将在后续里程碑逐步接入，现有 Tauri 版本在功能对等之前不会删除。

## 开发

```bash
cd native
cargo test -p leafmark-domain -p leafmark-core
cargo run -p leafmark-native
```

Dioxus Native 当前使用 WGPU/Blitz，不依赖 WebView2。Linux 构建需要 X11/Wayland、字体和输入相关开发库，CI 工作流包含 Ubuntu 依赖示例。

## 架构约束

1. Markdown 源码始终是唯一真实数据；
2. UI 只派发动作，不直接操作文件系统；
3. Tauri command 中的业务逻辑逐步下沉到 `leafmark-core`；
4. 文档编辑区最终使用自定义原生绘制面，而不是把 Blitz DOM 当作 `contenteditable`；
5. 迁移期间保持现有数据目录、历史快照和 Agent VCS 格式兼容。
