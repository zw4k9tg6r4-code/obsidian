# 安装包运行说明

本仓库既是源码，也是可交给 Codex 的自说明安装包。只有当用户明确要求“安装这个”“帮我装好”或同等含义时，才进入下面的安装流程；如果用户要求开发、审查或解释代码，不得安装或改动本机环境。

## Windows 安装流程

1. 先读取 `START-HERE.md`、`README.md`、`SECURITY.md`、`PRIVACY.md` 和 `docs/windows-install.md`。
2. 如果根目录存在 `release-manifest.json`，先运行 `scripts/scan-release.ps1 -Path . -AllowSyntheticFixtures`；扫描不通过就停止，不能安装。
3. 不要搜索整块磁盘来猜测知识库位置。优先使用用户本次明确给出的 Vault 路径；没有路径时只问一个最小问题，让用户选择包含根 `AGENTS.md` 的 Obsidian Vault。
4. 在写入前先运行只读预检：

   ```powershell
   powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-wizard.ps1 `
     -VaultPath '<VAULT_PATH>' -Target codex -IndexMode lexical -NonInteractive -PlanOnly
   ```

5. 预检通过后，安装 Codex Skill 并建立本地关键词索引：

   ```powershell
   powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-wizard.ps1 `
     -VaultPath '<VAULT_PATH>' -Target codex -IndexMode lexical -NonInteractive -AcceptNetwork
   ```

6. 必须检查命令退出码和最后的 JSON。只有 `ok: true`、`indexMode: lexical` 且 `health.indexed: true` 时，才告诉用户安装可用；同时保留 JSON 中的 `manifest`，它是回滚入口。提示用户新建一个 Codex 任务或重启 Codex，以刷新 Skill 列表。

## 强制边界

- 不因打开目录而自动安装；用户明确要求安装才是授权。
- 不把压缩包解压到 Vault 内，也不把 Vault 放进本项目、安装目录或其子目录。
- 不复制、上传、提交或修改 Vault 中的知识内容。关键词建索引只读 Vault，派生数据位于 Vault 外。
- 不执行全盘扫描，不猜测多个 Vault 中的一个，不绕过 reparse point、junction、路径包含或版本检查。
- `-AcceptNetwork` 只授权按锁文件安装依赖。不得安装全局 Node、改变机器级执行策略、创建后台服务或计划任务。
- 默认只建立关键词索引。语义检索可能下载 Python 依赖和约 90 MB 模型，除非用户明确要求并同意下载，否则不得使用 `-IndexMode semantic` 或 `-AcceptModelDownload`。
- 若安装、索引或健康检查失败，必须返回失败并报告原因及已生成的回滚 manifest；不得声称已完成。
- 非 Windows 环境不要运行 `INSTALL.cmd` 或 PowerShell 安装器；只说明当前一键安装入口不支持该系统。

## 人工双击入口

用户希望自己操作时，让其先完整解压 ZIP，再双击根目录 `INSTALL.cmd`。该入口会打开 Vault 选择器、显示写入与联网摘要、在用户确认后安装 Codex 版并建立关键词索引。
