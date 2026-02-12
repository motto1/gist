# Task: 移除项目对 .env 的依赖 (Phase 5: 交付与收尾)

## Goals
1. 确认所有 `.env` 文件相关的改动已正确实施且无遗漏。
2. 确保 `gist-video` 路径环境变量已完全移除，由代码自动解析。
3. 检查文档、CI 配置和代码中不再存在对 `.env` 文件的硬编码引用。
4. 提供详细的变更清单和迁移说明给用户。

## Checklist
- [x] 验证 `package.json` 不含 `dotenv` / `dotenv-cli` 依赖和脚本。
- [x] 验证 `scripts/notarize.js` 已移除 `dotenv.config()`。
- [x] 验证 `src/main/services/GistVideoService.ts` 不再依赖 `GIST_VIDEO_BACKEND_ROOT/GIST_VIDEO_PYTHON/GIST_VIDEO_BACKEND_EXE`。
- [x] 验证文档 (`docs/dev.md`, `docs/gist-video-dev.md` 等) 已更新。
- [x] 验证 CI 工作流 (`.github/workflows/build-win.yml`) 已清理。
- [x] 验证 `.env.example` 已删除。
- [x] 汇总最终变更清单并输出。

## Summary of Changes
- **Dependency Removal**: `dotenv` and `dotenv-cli` removed from `package.json`.
- **Code Hardening**: Removed automatic `.env` loading in `notarize.js`.
- **Path Resolution**: `GistVideoService.ts` now uses stable relative paths instead of absolute path env overrides.
- **Documentation**: All developer guides updated to use terminal/CI environment variables instead of `.env` files.
- **CI/CD**: Workflows cleaned up to remove `.env` file creation/handling.
