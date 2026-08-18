# LeafMark Agent Skills

这些 `SKILL.md` 采用与 ZCode / OpenCode 相同的 YAML `name` + `description` 格式，供一叶内置 Agent 在启用对应技能时注入。

它们描述的是 **LeafMark 本地 OOXML 引擎**（`OfficeSession` / `office_inspect` / `office_read` / `office_execute`）上的工作流，而不是安装版 WPS 的 COM 自动化或 `wps_office_search` / `wps_office_execute` MCP。二进制 `.doc` / `.ppt`、VBA、SmartArt、透视图和动画不在范围内；PDF 仍为只读。
