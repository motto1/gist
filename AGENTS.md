# Repository Guidelines

## 项目结构与模块组织
- `src/main` 与 `src/renderer` 承载 Electron 主进程与前端界面，子目录按领域划分为 `services`、`components`、`store` 等，新增模块时保持相同结构并更新相关 index 文件。
- `packages` 存放 Yarn workspace 模块（如 `@cherry-studio/aiCore`），公共逻辑需抽离到此处并在 `package.json` 中声明导出。
- `tests` 聚合跨进程与集成脚本，`scripts` 保存自动化工具及其 `__tests__`，静态资源位于 `resources`，打包产物输出至 `build`，文档集中在 `docs`。

## 构建、测试与开发命令
- 首次运行执行 `yarn install` 并复制 `.env.example` 到 `.env`，必要时补充 API Key。
- `yarn dev` 启动开发模式，`yarn start` 预览打包后的 Electron 客户端，调试可使用 `yarn debug` 后访问 `chrome://inspect`。
- `yarn build:win`、`yarn build:mac`、`yarn build:linux` 负责各平台产物；发布前先运行 `yarn build:check`。
- 质量检查使用 `yarn lint`、`yarn format:check` 与 `yarn typecheck`；需要更新 agents 元数据时执行 `yarn generate:agents`。

## 编码风格与命名约定
- 项目以 TypeScript 为主，遵循 `.editorconfig` 的 2 空格缩进与 LF 行尾；React 组件使用 `PascalCase`，自定义 Hook 以 `use` 前缀命名。
- 业务服务与工具函数分别归类到 `services`、`utils`，保持单一职责并补充同目录的 `__tests__`。
- 统一通过 Biome、ESLint、Oxlint 检查，提交前利用 `lint-staged` 自动修复；禁止引入未使用的依赖或未类型化的 `any`。
- 文件命名建议使用短横线或驼峰与现有目录保持一致，导出的常量采用 `SCREAMING_SNAKE_CASE`。

## 测试准则
- 单元测试使用 Vitest，文件命名为 `*.test.ts` 并与实现同目录；跨模块场景放入 `tests` 目录的集成用例。
- UI 与端到端流程依赖 Playwright，命令 `yarn test:e2e`；更新快照请运行 `yarn test:update`。
- 覆盖率通过 `yarn test:coverage` 评估，新增功能需覆盖核心分支与异常路径。
- PR 前请确保 `yarn test`、`yarn test:renderer`、`yarn test:main` 全部通过，必要时附上测试说明。

## 提交与合并请求指南
- 所有提交必须包含 `Signed-off-by`，可使用 `git commit --signoff -m "feat: 描述"`；提交信息优先采用 `<type>: <summary>` 并引用相关 Issue，如 `#123`。
- 按 `docs/branching-strategy-en.md` 使用 `feature/`、`fix/`、`docs/`、`hotfix/` 前缀创建分支，并从最新 `main` 切出。
- 在 PR 描述中概述变更、测试结果与风险；涉及 UI 的改动附上前后截图或短视频。
- 合并前确认无未通过的 CI、冲突或临时注释，必要时邀请维护者 `/ok-to-test`。

## 配置与安全提示
- `.env` 仅保存本地开发凭据，请勿提交真实密钥；共享参数可保留在 `.env.example` 并注明用途。
- 使用 `resources` 中的图标或二进制需核对许可证，第三方补丁请同步 `yarn.lock` 与对应 `patch` 文件。
