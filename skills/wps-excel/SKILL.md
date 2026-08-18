---
name: wps-excel
description: 在 LeafMark 中编辑已打开的 Excel/WPS 表格（.xlsx/.csv 等）：单元格、数字格式、合并、排序、筛选、自动求和。使用 office_execute 的 sheet* 操作。
---

# WPS 表格（LeafMark Excel）

适用于当前打开的电子表格。`read_office` 使用 `sheet`、`row`、`col`、`rowCount`、`colCount`（0 基行号）。返回值为显示文本的 TSV。

## 常用 office_execute

```json
{ "op": "sheetEdit", "name": "Sheet1", "row": 0, "col": 0, "input": "=SUM(B2:B10)" }
{ "op": "sheetFormat", "name": "Sheet1", "row": 0, "col": 0, "rowCount": 1, "colCount": 3, "format": { "bold": true, "numFmt": "currency", "align": "center" } }
{ "op": "sheetMerge", "name": "Sheet1", "row": 0, "col": 0, "rowCount": 1, "colCount": 3, "merge": true }
{ "op": "sheetSort", "name": "Sheet1", "row": 0, "col": 0, "rowCount": 20, "colCount": 4, "sortCol": 0, "ascending": false }
{ "op": "sheetFilter", "name": "Sheet1", "row": 0, "col": 0, "rowCount": 20, "colCount": 4 }
{ "op": "sheetAutoSum", "name": "Sheet1", "row": 1, "col": 1, "rowCount": 10, "colCount": 1 }
{ "op": "sheetFillRight", "name": "Sheet1", "row": 0, "col": 0, "rowCount": 1, "colCount": 5 }
{ "op": "sheetFreeze", "name": "Sheet1", "row": 1, "col": 1 }
{ "op": "sheetRename", "name": "Sheet1", "next": "汇总" }
```

`numFmt`：`general` | `number` | `percent` | `currency` | `date` | `text` | `scientific`。公式输入以 `=` 开头；引擎会重算后再写回。

## 原则

- 先读目标区域，再编辑。大表只取视口，不要假设已加载全部行。
- 改公式后核对应显示值；循环引用会得到 `#CYCLE!`。
- 不要声称支持 VBA、数据透视、Power Query 或外部数据刷新。
