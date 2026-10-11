# 参与场域战争开发

本项目使用中文描述问题、设计取舍和验收结果。提交前先阅读 [README](README.md)，了解运行方式、规则边界和验证环境。欢迎小范围、可复现、可验证的贡献。

## 分支与协作流程

| 分支 | 用途 | PR 方向 |
| --- | --- | --- |
| `main` | 默认稳定分支，记录经过发布验收的代码 | 正常发布由 `dev` 提交到 `main` |
| `dev` | 日常开发与集成 | 功能、修复和文档 PR 的默认目标 |
| 临时主题分支 | 承载一个独立任务，从最新 `dev` 创建 | 完成后提交到 `dev` |

维护者本地日常工作使用 `dev`；需要独立评审时创建短期主题分支。推荐 `feat/<主题>`、`fix/<主题>`、`docs/<主题>`、`chore/<主题>`；Codex 创建的任务分支沿用 `codex/<主题>`。

```sh
git fetch origin
git switch dev
git pull --ff-only
git switch -c feat/key-search
```

有未提交改动时先检查并保存，不使用重置或强制切换覆盖其他工作。不对共享的 `main`、`dev` 强制推送。

普通 PR 指向 `dev`，保持一个主题；未完成的工作使用 Draft PR。发布时建立 `dev → main` 的 PR，核对包含的变更、迁移与验收证据，合并后按 README 的流程部署明确的提交。长期分支间的发布合并保留共同历史，避免反复 squash 整条 `dev` 分支。若紧急修复必须从 `main` 出发，应单独评审，并及时同步回 `dev`。

这些是协作约定；模板本身不会启用 GitHub 分支保护、必需审批、CI 或自动部署。通过 Codex 执行提交时，仍遵守当前适用的 AGENTS.md：每笔提交先展示准确文件、说明和验证结果，再取得明确确认；文档和测试文件也需要确认提交范围。

## Issue 规范

通过 [Issue 入口](https://github.com/hidewnd/field-wars/issues/new/choose) 选择以下表单：

- **问题反馈**：实际与预期行为、最短复现步骤、版本与环境，以及脱敏日志或截图。无法稳定复现时写明发生时间、频率及已知条件。
- **功能建议**：使用场景、待解决的问题、方案边界、验收标准和替代方案。玩法平衡、资产或存储调整先明确契约再实现。
- **使用与开发提问**：目标、已阅读的说明、尝试过程及结果。

先搜索已有 Issue，一个 Issue 聚焦一个问题。标题写出具体动作和现象，例如 `[Bug] 移动中仍能点击远程充能`；避免只写“有问题”或“优化一下”。事实、推测和建议分别说明。公开内容不得包含恢复码、Cookie、会话令牌、密码、完整 `.env`、生产数据或未脱敏的玩家信息。

维护者按证据补充分类、优先级和处理状态；重复报告关联已有 Issue，信息不足时说明需要补充什么，完成时记录验证结果及版本。模板不依赖自定义标签，也不自动分配人员或关闭问题。

## PR 与提交规范

PR 标题和提交说明采用 `type(scope): 具体结果`，`scope` 可省略，正文说明为什么需要这项改变。常用类型：

| 类型 | 适用内容 |
| --- | --- |
| `feat` | 新功能或新规则 |
| `fix` | 缺陷修复 |
| `docs` | 文档、文案及协作说明 |
| `test` | 测试覆盖或验证修复 |
| `refactor` | 保持行为的结构调整 |
| `perf` | 有证据支持的性能优化 |
| `chore` / `ci` | 工具维护 / 自动化检查配置 |

例如 `fix(map): 点击菜单外仅关闭菜单`、`docs: 补充独立数据库验证步骤`。有不兼容变更时在描述中说明影响与迁移方式，不以“优化”“调整”等空泛标题替代实际行为。

PR 按[模板](.github/PULL_REQUEST_TEMPLATE.md)写明问题、结果、验证与风险：

1. 普通开发 PR 使用 `Refs #123` 关联 Issue；没有 Issue 的小修复可直接说明背景，不强制补建。
2. 指向 `dev` 的 PR 不会因 `Closes #123` 自动关闭 Issue。发布 PR 指向默认分支 `main` 时，对确实解决的问题使用 `Closes #123`；上线验收与 Issue 的关闭状态仍需区分。
3. 解释关键行为边界和必须保留的旧行为，避免无关重构、格式化或新增依赖。
4. 缺陷修复优先提供能保护实际行为的验证；低风险文案、链接和格式调整不机械新增测试。
5. 审阅者确认范围、证据和数据兼容性；审阅意见处理完毕后再合并。合并后记录实际发布与验证状态，不把构建成功写成线上验收通过。

## 验证要求

使用项目配置的 Node.js 24 和锁定依赖。验证从受影响范围开始，常用命令如下：

```sh
npm ci
npm test
npm run typecheck
npm run build
git diff --check
```

纯文档、模板或文案调整检查内容、链接、格式和差异即可，不必运行无关应用测试。Issue 表单还应验证 YAML 和 GitHub 表单字段。

涉及规则、数据库、身份、资产、请求重放或共享状态时，按 [README 的验证说明](README.md#备份恢复与验证)运行对应测试，并写明真实环境与结果。`TEST_DATABASE_URL`、`OPERATIONS_TEST_DATABASE_URL`、`MIGRATION_TEST_DATABASE_URL` 必须指向彼此独立、库名包含独立 `test` 段的测试数据库；严禁指向游戏库。未配置而跳过的测试必须明确列出，不能算作通过。

界面变更检查相关交互，并按需提供桌面和手机截图，关注布局、遮挡、焦点、控制台错误和资源加载；模拟接口证据与真实服务验证分开说明。数据库迁移新增顺序编号文件，不修改已应用迁移，并验证旧版本升级、重复执行、资产保留及未知版本拒绝等实际边界。部署前备份、归档校验和回退限制遵循 [README 的部署流程](README.md#远程部署与更新)。

## 模板发布与参考

Issue 表单位于 `.github/ISSUE_TEMPLATE/`，PR 模板位于 `.github/PULL_REQUEST_TEMPLATE.md`。提交到 `dev` 只代表进入开发分支；Issue 表单及选择器需要合入默认分支 `main` 后才会出现在 GitHub 的创建入口。发布规范时检查 GitHub 页面实际加载结果。

本项目参考以下实践，并按游戏规则、资产安全和部署方式进行裁剪：

- [Vite 贡献指南](https://github.com/vitejs/vite/blob/main/CONTRIBUTING.md)：聚焦单个问题、给出验证依据及相关测试。
- [Vite 问题反馈表单](https://github.com/vitejs/vite/blob/main/.github/ISSUE_TEMPLATE/bug_report.yml)：复现步骤、运行环境及重复问题检查。
- [Vite PR 模板](https://github.com/vitejs/vite/blob/main/.github/PULL_REQUEST_TEMPLATE.md)：解决的问题、关联 Issue、替代方案及审阅重点。
- [GitHub Issue Forms 语法](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms)与[配置说明](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/configuring-issue-templates-for-your-repository)。
- [GitHub PR 与 Issue 关联规则](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue)。
