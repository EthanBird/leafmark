---
name: wps-ppt
description: 在 LeafMark 中编辑已打开的 PPT/WPS 演示（.pptx/.odp）：文本框、备注、版式、隐藏与重排。使用 office_execute 的 slide* 操作。
---

# WPS 演示（LeafMark PowerPoint）

适用于当前打开的演示文稿。`read_office` 使用 `slide`（0 基页码）返回该页形状文本与备注。

## 常用 office_execute

```json
{ "op": "slideText", "index": 0, "shapeId": "shape-1", "text": "新标题" }
{ "op": "slideNotes", "index": 0, "notes": "演讲备注" }
{ "op": "slideLayout", "index": 0, "layout": "titleContent" }
{ "op": "slideAddTextBox", "index": 0 }
{ "op": "slideShape", "index": 0, "shapeId": "shape-1", "patch": { "bold": true, "align": "center", "fill": "1F4E79" } }
{ "op": "slideHide", "index": 1, "hidden": true }
{ "op": "slideDuplicate", "index": 0 }
{ "op": "slideReorder", "from": 2, "to": 0 }
{ "op": "slideAdd" }
```

`layout`：`title` | `titleContent` | `blank` | `twoContent`。改文本只替换对应 `a:t`；未改形状保留原 XML。

## 原则

- `shapeId` 来自 `read_office` / `inspect_office` 返回的形状列表，不要编造。
- 用户只要讲稿或改写建议时，把结果写在对话里；只有明确要求改幻灯片才 `slideText`。
- 不处理动画、切换、SmartArt、嵌入视频的时间轴。
