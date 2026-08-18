# LeafMark 0.8 Office 编辑器

0.8 仍以 `v0.7.2` 产品基线为 UI、主题、Agent 与发布链的唯一来源，并在 0.7.7 本地文档打开流水线之上，把 Word / Excel / PowerPoint 从只读预览升级为可写回 Microsoft Office 的本地编辑器。

目标不是把文档转换成私有格式，而是把 OOXML 当作原生模型：打开快、编辑真、写回后 Word / Excel / PowerPoint 仍能打开。

## 架构

```text
UI 线程（React）                Worker 线程                 Rust / 磁盘
─────────────────              ──────────────              ────────────
立即建标签                      解压 OOXML 包               路径校验、512MB 上限
视口渲染 / 虚拟表格              稀疏单元格 / 段落模型         原件快照
格式栏 / 公式栏                  公式重算                     原子写回工作区 + 快照
保存 / 自动保存                  按脏节点重写 XML
```

主线程不持有完整文档。Worker 用 LRU 保留最近 4 份 `OfficeSession`；UI 只订阅当前视口。引擎按设计模式拆开：Strategy（OOXML codec）、Command（撤销/重做）、Registry（Excel 函数表）、Facade（`OfficeSession` 统一 mutate/undo/serialize）。这与 OnlyOffice 的 “模型在引擎、屏幕只画可见区域” 同一思路，但全部在本机完成，不上传。

## 秒开策略

| 格式 | 首屏 | 其余内容 |
| --- | --- | --- |
| `.docx` / `.rtf` | 前 160 个段落/表格 | 滚动继续取块；未编辑块保留原始 XML |
| `.xlsx` / `.csv` / `.xls` | 活动表视口（约 80×26） | 稀疏单元格 + 滚动按需取数 |
| `.pptx` / `.odp` | 幻灯片目录 + 第 1 页 | 切页时再解析该页 |
| `.pdf` | 系统 WebView PDF | 仍为只读 |
| `.doc` / `.ppt` | 兼容性回退 | 交给系统 Office |

“窗口可操作”与“整份文件解析完毕”解耦。产品目标：普通本地文档冷启动后 1 秒内出现可编辑首屏；大表格只渲染可见单元格，绝不把十万行塞进 React。

## 兼容与写回

- **Word / WPS 文字**：Run 级字体、字号、颜色、高亮、上标/下标、超链接；段落对齐、缩进、行距、分页符、多级列表。可插入/增删表格行列、查找替换、页眉页脚、字数统计。未修改块原样写回；修改块生成 WordprocessingML。使用列表时补齐 `word/numbering.xml`（9 级）与 Content_Types。
- **Excel / WPS 表格**：原生 SpreadsheetML。数字格式（常规/数值/货币/百分比/日期/科学计数/文本）、字体对齐换行填充、合并单元格、列宽、冻结窗格、排序、自动筛选、向右填充、自动求和、重命名/删除工作表。打开时解析已有合并/冻结/筛选/列宽；写回时更新 `workbook.xml` 工作表列表且保留主题/样式关系。公式用函数注册表重算后再写 `<f>` / `<v>`。
- **PowerPoint / WPS 演示**：改文本时只替换对应 `a:t`；可新增文本框、移动形状、改填充、备注、隐藏幻灯片、版式、重排。写回时更新 `sldIdLst`、关系部件与 notesSlide。
- **外部来源**（微信、邮件、临时 `content://`）：仍然只写 LeafMark 保留副本，绝不回写来源路径。文档库内的文件保存时同步更新工作区文件与快照。

公式引擎对齐 Microsoft Excel / WPS / OnlyOffice 常见语义：四则与比较、`A1` / `$A$1` / `Sheet1!B2`、区域、`IFERROR` 捕获参数错误，以及 `SUM AVERAGE MIN MAX COUNT COUNTA COUNTBLANK COUNTIF COUNTIFS SUMIF SUMIFS AVERAGEIF AVERAGEIFS MAXIFS MINIFS PRODUCT ABS ROUND ROUNDUP ROUNDDOWN INT TRUNC CEILING FLOOR MOD POWER SQRT LN LOG LOG10 EXP PI SIGN RAND RANDBETWEEN IF IFS SWITCH IFNA AND OR XOR NOT TRUE FALSE ISBLANK ISNUMBER ISTEXT ISERROR ISNA ISEVEN ISODD N LEN LEFT RIGHT MID TRIM UPPER LOWER PROPER CONCAT CONCATENATE TEXTJOIN VALUE FIND SEARCH SUBSTITUTE REPLACE REPT EXACT CHAR CODE FIXED DOLLAR T HYPERLINK NOW TODAY DATE YEAR MONTH DAY WEEKDAY HOUR MINUTE SECOND TIME EDATE EOMONTH DAYS DATEDIF NETWORKDAYS TEXT NA CHOOSE COLUMN ROW COLUMNS ROWS LARGE SMALL MEDIAN SUMPRODUCT VLOOKUP HLOOKUP LOOKUP XLOOKUP INDEX MATCH INDIRECT RANK RANK.EQ STDEV STDEV.S STDEVP STDEV.P VAR VAR.S VARP VAR.P PMT FV PV NPV NPER SIN COS TAN ASIN ACOS ATAN DEGREES RADIANS FACT GCD LCM EVEN ODD COMBIN QUOTIENT UNIQUE`。循环引用返回 `#CYCLE!`。对照用例见 `src/office/office-compat.test.ts` 与 `src/office/office-wps.test.ts`。

## 明确不做的事（本版本）

- 不执行 VBA / 宏 / 外部链接 / 嵌入脚本
- 不保证复杂浮动图文、SmartArt、透视图、动画的像素级还原
- PDF、二进制 `.doc` / `.ppt`、VBA / 宏 / 外部链接 / 嵌入脚本
- 不保证复杂浮动图文、SmartArt、透视图、动画的像素级还原
- 二进制 `.doc` / `.ppt` 不在应用内实现不完整的 OLE 排版器

## Agent 与划词问 AI

当前打开的 Word / Excel / PPT 可以由内置 Agent 通过 `inspect_office`、`read_office`、`office_execute` 操作，对应仓库 `skills/wps-*/SKILL.md`（ZCode 风格 YAML `name`/`description`）。这些技能描述的是 LeafMark 本地 `OfficeSession`，不是安装版 WPS 的 COM / `wps_office_search`。

- 划词后出现「解释 / 改写 / 翻译 / 总结 / 问 AI」；表格功能区也有「问 AI」，把当前选区交给 Agent。
- Agent 回答可复制，或保存为文档库中的 Markdown（`agent-replies/`）。
- 写入仍受「允许修改文档」开关保护；PDF 只读。主线程不把整份 OOXML 塞进提示词。

## 安全边界

与 0.7.7 相同：Office 内容视为不可信，在 Worker 中解析；OOXML XML 累计上限 96 MB；单文件 512 MB；不把文档 HTML 注入页面。写回使用与 Markdown 相同的原子替换。

## 验证

- `npm run typecheck`
- `npm test`（含 DOCX/XLSX/PPTX 往返、撤销，以及与 Microsoft Excel 语义对照的公式套件）
- Windows / Linux `cargo test`
- 真实语料：冷启动首屏、编辑后用 Microsoft Office 打开、源文件删除后从保留副本继续编辑
