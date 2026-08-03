# Blitz / Dioxus Native 兼容性记录

## 已确认的 IME 链路

截至 Dioxus Native 0.7.9 使用的 Blitz 代码：

1. `blitz-shell` 会把 winit IME 事件转换为 `BlitzImeEvent`；
2. `blitz-dom` 已实现 `Enabled`、`Disabled`、`Preedit` 和 `Commit` 的文本输入处理；
3. 问题位于 `dioxus-native-dom` 的事件转换层：`DomEventData::Ime(_) => None`，代码旁仍标记 `TODO: Implement IME handling`；
4. 因而普通 Blitz `<input>` / `<textarea>` 可以处理输入并产生最终 `input` 值，但 Dioxus 组件暂时收不到完整 composition 生命周期。

这说明当前无需重写 Blitz IME，也不应在 LeafMark 内复制输入法实现。优先修复 Dioxus adapter。

## LeafMark 当前策略

`leafmark-native-compat` 同时提供两条路径：

- `apply_full_value`：把 Blitz/Dioxus 最终 `input` 值与 Rope 当前值做 Unicode 最长公共前后缀差分，只生成最小 `EditTransaction`，不会每次替换整篇文档；
- `ImeBridge`：接收明确的 `Enabled / Disabled / Preedit / Commit` 事件，并把 preedit 保留在组合态，只有 Commit 才修改 Markdown。

在 Dioxus adapter 补丁合入之前，源码模式使用第一条路径，保证中文最终输入与撤销粒度可用。补丁接入后切换第二条路径，实现候选阶段显示、组合光标和精确候选框位置。

## 计划补丁

目标修改位于 Dioxus `packages/native-dom`：

1. 新增 `NativeImeData(BlitzImeEvent)` 平台事件包装；
2. 把 `DomEventData::Ime(data)` 映射为可下转的 `PlatformEventData`；
3. 在 `dioxus-html` 暴露 native composition event data 或 LeafMark 专用事件类型；
4. 为 preedit、commit、disabled 添加 adapter 单元测试；
5. 保留 `input` 事件行为，避免破坏普通表单。

如果上游事件 API 在补丁期间仍不稳定，LeafMark 将采用自定义 Native host，在 `DioxusDocument::handle_ui_event` 之前旁路复制 `UiEvent::Ime` 给编辑器，而不分叉 Blitz 排版与窗口代码。
