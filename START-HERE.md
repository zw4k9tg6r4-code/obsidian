# 从这里开始

这是一个不包含任何私人笔记的第二大脑安装包。

## 交给全新 Codex

1. 先将 ZIP 全部解压到 Obsidian Vault 之外的普通文件夹。
2. 在 Codex 中打开解压后的根目录。
3. 只要说一句：`安装这个`。

Codex 会自动读取根目录 `AGENTS.md`，完成只读预检、安装 Codex Skill、建立关键词索引并检查健康状态。你不需要再复制长提示词；如果电脑里无法唯一确定 Obsidian Vault，Codex 只会向你确认这个目录。

## 自己双击安装

全部解压后，双击根目录 `INSTALL.cmd`，选择包含根 `AGENTS.md` 的 Obsidian Vault，然后确认安装。不要直接在 ZIP 预览窗口内运行。

默认行为：

- 只安装 Codex 版；
- 安装锁定版本的本地依赖，需要联网；
- 建立关键词索引，让安装后立即可检索；
- 不修改 Vault 中的 Markdown；
- 不下载语义模型；
- 不创建后台服务或计划任务；
- 自动备份旧安装，并显示可回滚的 manifest 路径。

要求：Windows、Node.js 22 或更高版本、一个根目录含 `AGENTS.md` 的 Obsidian Vault。

安装完成后，新建一个 Codex 任务或重启 Codex，让 Skill 列表刷新。

高级选项和回滚方法见 `docs/windows-install.md`。
