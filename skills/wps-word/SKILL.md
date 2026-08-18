---
name: wps-word
description: 在 LeafMark 中编辑已打开的 Word/WPS 文字（.docx/.rtf）：样式、查找替换、表格、页眉页脚。使用 office_execute 的 word* 操作，不要调用 WPS COM。
---

# WPS 文字（LeafMark Word）

适用于当前打开的 Word 文档。先 `inspect_office`，再用 `read_office` 读取 `offset`/`count` 段落。

## 常用 office_execute

```json
{ "op": "wordFindReplace", "query": "旧词", "replacement": "新词", "all": true }
{ "op": "wordStyle", "index": 0, "patch": { "kind": "heading", "level": 1, "align": "center", "indent": 0, "lineSpacing": 1.5 } }
{ "op": "wordRunStyle", "index": 0, "style": { "bold": true, "font": "微软雅黑", "fontSize": 16, "color": "1F4E79" } }
{ "op": "wordTable", "action": "insert", "index": 1, "rows": 3, "cols": 3 }
{ "op": "wordTable", "action": "setCell", "index": 1, "row": 0, "col": 0, "text": "A1" }
{ "op": "wordHeaderFooter", "header": "页眉", "footer": "页脚" }
{ "op": "wordInsert", "index": 0, "block": { "kind": "paragraph", "runs": [{ "text": "新段落" }], "dirty": true } }
{ "op": "wordDelete", "index": 3 }
```

`wordStyle.patch.list` 可为 `{ "type": "bullet"|"number", "level": 0, "numId": 1 }` 或 `null` 取消列表。`wordTable.action` 还有 `insertRow` / `insertCol` / `deleteRow` / `deleteCol`。

## 原则

- `index` 是当前模型中的块序号（段落或表格），先读摘录再改。
- 查找替换默认 `all: true`；只改一处时设 `all: false`。
- 保留超链接、标题层级和表格结构；不要为了“美化”清空 original 未编辑块。
- 用户只要解释/润色建议时，不要擅自 `wordFindReplace` 全文。
