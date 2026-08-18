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

- **Word**：解析段落、Run 级格式、表格、标题与 `w:numPr` 列表。未修改块原样写回；修改块生成 WordprocessingML。使用列表时补齐 `word/numbering.xml` 与 Content_Types，以便 Microsoft Word / WPS 识别项目符号与编号。支持插入/删除/拆分段落、撤销。
- **Excel**：原生 SpreadsheetML。单元格保留 style index；公式用函数注册表重算后再写 `<f>` / `<v>`。支持插入/删除行列（相对引用平移）、复制/粘贴、向下填充、百分比输入、撤销。CSV 直接读写。旧版 `.xls` / `.xlsb` / `.ods` 经 SheetJS 读入同一稀疏模型后按原 bookType 写回。
- **PowerPoint**：改文本时只替换对应 `a:t`；几何、图片、母版仍在原包中。可新增、删除、复制幻灯片，改背景与形状加粗/对齐。写回时更新 `sldIdLst` 与关系部件。
- **外部来源**（微信、邮件、临时 `content://`）：仍然只写 LeafMark 保留副本，绝不回写来源路径。文档库内的文件保存时同步更新工作区文件与快照。

公式引擎对齐 Microsoft Excel / WPS / OnlyOffice 常见语义：四则与比较、`A1` / `$A$1` / `Sheet1!B2`、区域、`IFERROR` 捕获参数错误，以及 `SUM AVERAGE MIN MAX COUNT COUNTA COUNTBLANK COUNTIF COUNTIFS SUMIF SUMIFS AVERAGEIF PRODUCT ABS ROUND ROUNDUP ROUNDDOWN INT TRUNC CEILING FLOOR MOD POWER SQRT LN LOG LOG10 EXP PI SIGN IF IFNA AND OR NOT TRUE FALSE ISBLANK ISNUMBER ISTEXT ISERROR ISNA N LEN LEFT RIGHT MID TRIM UPPER LOWER PROPER CONCAT TEXTJOIN VALUE FIND SEARCH SUBSTITUTE REPLACE REPT EXACT CHAR CODE NOW TODAY DATE YEAR MONTH DAY WEEKDAY TEXT NA CHOOSE COLUMN ROW COLUMNS ROWS LARGE SMALL MEDIAN SUMPRODUCT VLOOKUP HLOOKUP INDEX MATCH`。循环引用返回 `#CYCLE!`。对照用例见 `src/office/office-compat.test.ts`。

## 明确不做的事（本版本）

- 不执行 VBA / 宏 / 外部链接 / 嵌入脚本
- 不保证复杂浮动图文、SmartArt、透视图、动画的像素级还原
- Agent 仍只读写 Markdown，避免大二进制文档被工具误伤
- 二进制 `.doc` / `.ppt` 不在应用内实现不完整的 OLE 排版器

## 安全边界

与 0.7.7 相同：Office 内容视为不可信，在 Worker 中解析；OOXML XML 累计上限 96 MB；单文件 512 MB；不把文档 HTML 注入页面。写回使用与 Markdown 相同的原子替换。

## 验证

- `npm run typecheck`
- `npm test`（含 DOCX/XLSX/PPTX 往返、撤销，以及与 Microsoft Excel 语义对照的公式套件）
- Windows / Linux `cargo test`
- 真实语料：冷启动首屏、编辑后用 Microsoft Office 打开、源文件删除后从保留副本继续编辑
