---
name: wps-office
description: LeafMark 办公文档总控。先 inspect 再按类型选用 Word/Excel/PPT 工具；禁止假装调用了 WPS COM 或改写了未打开的二进制文件。
---

# WPS / Office 总控（LeafMark 原生）

你在一叶里操作的是当前标签页已打开的 `.docx` / `.xlsx` / `.pptx`（及部分 `.rtf` `.csv` `.odp`），引擎是本地 `OfficeSession`，不是本机安装的 WPS 或 Microsoft Office COM。

## 工作顺序

1. 调用 `inspect_office` 确认类型、规模和当前活动表/页。
2. 用 `read_office` 按需取摘录，不要请求整份二进制，也不要把 OOXML 贴进对话。
3. 修改前确认设置已允许文档编辑。小范围改动用 `office_execute`；Markdown 仍用 `replace_text` / `begin_document_output`。
4. 用户划词问 AI 时，优先针对提示词里的摘录作答；只有明确要求改原文时才调用写入工具。
5. 写回后用 `inspect_office` 或再读摘录核对。需要撤销时用 `office_undo` / `office_redo`（与编辑器撤销栈相同）。

## 工具

- `inspect_office`：类型、字数/工作表/幻灯片目录、页眉页脚摘要。
- `read_office`：Word 按段落偏移；Excel 按表名与行列；PPT 按页索引。
- `office_execute`：传入与编辑器相同的 `op` 对象（见 wps-word / wps-excel / wps-ppt）。
- `office_undo` / `office_redo`：回退或重做最近一次办公变异。

## 硬限制

- PDF、`.doc`、`.ppt`、宏、OLE、外部链接不可编辑。
- 不要使用 `wps_office_search`、`wps_office_execute` 或任何“启动 WPS 进程”的说法。
- 不要把整份 xlsx/pptx 序列化结果塞进模型上下文。
- 版本控制会把本轮工作区/保留副本的字节变化记入可回退回合；不要修改文档库以外的路径。
