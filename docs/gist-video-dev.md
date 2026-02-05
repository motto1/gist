# 视频解说：本地编译与调试指南

> 本仓库当前 **已提交** `resources/gist-video/`（包含后端源码/可执行文件、FFmpeg、模型等），因此大多数情况下无需额外下载即可直接开发与调试。  
> 如果你出于合规/体积考虑自行移除了其中的二进制/模型，请按本文档的“缺失资源补齐”章节处理。

## 0. 你将得到什么

- `yarn dev` 可正常启动并编译整个 Electron 应用
- 「视频解说」页面可启动本地后端（Python 模式），并完成素材库建库/一键成片等流程
- 若模型缺失（例如你本地删除/未同步），需要**联系作者**获取（否则部分能力会降级或不可用）

## 1. 基础准备（Windows 优先）

1) Node.js：满足 `package.json` 的 `engines.node`（建议使用 nvm/volta 管理）  
2) Yarn：建议启用 Corepack  
3) Python：推荐 3.11（x64）  
4) FFmpeg：下载“精简版 exe”（你只需要 `ffmpeg.exe` + `ffprobe.exe`）

## 2. 拉取与安装依赖

```powershell
Set-Location "F:/gist"
yarn install
copy .env.example .env
```

如需明确指定视频后端路径（推荐）：

```dotenv
# .env（示例）
GIST_VIDEO_BACKEND_ROOT="F:/gist/resources/gist-video/backend"
# 推荐：优先使用仓库已提交的后端 exe（不依赖本机 Python 环境）
GIST_VIDEO_BACKEND_EXE="F:/gist/resources/gist-video/backend/gist-video-backend/gist-video-backend.exe"
# 可选：仅当你要用 Python 调试时再打开（前提：已运行 setup 脚本创建 .venv）
#GIST_VIDEO_PYTHON="F:/gist/resources/gist-video/backend/.venv/Scripts/python.exe"
#GIST_VIDEO_PORT=37123
```

注意：`.venv/` **不应提交**到仓库（体积大且机器相关）。同事首次开发必须先运行 `setup-gist-video-backend.ps1` 创建虚拟环境，否则如果你在 `.env` 中写死了 `GIST_VIDEO_PYTHON`，他们会遇到 `spawn ...\.venv\\Scripts\\python.exe ENOENT`。
## 3. 后端资源目录确认（必做）

最低要求：`resources/gist-video/backend/` 内必须存在以下“标记文件/目录”，否则主进程无法识别后端根目录：

```
resources/gist-video/backend/app/server/__main__.py
resources/gist-video/backend/requirements-dev.txt
```

## 4. FFmpeg（必做）

仓库已包含 FFmpeg 精简版 exe 时，可跳过本节。  
若缺失，请下载 FFmpeg 精简版 exe，并把文件放到：

```
resources/gist-video/backend/bin/ffmpeg.exe
resources/gist-video/backend/bin/ffprobe.exe
```

（可选）验证：

```powershell
.\resources\gist-video\backend\bin\ffmpeg.exe -version
```

## 5. 模型（可选，但影响功能）

如果模型与相关资源缺失，请联系作者获取并放到作者指定的目录。  
如果缺少模型：
- “向量化/检索”可能会降级（例如回退到轻量 local_hash），召回效果会变差
- 某些功能可能直接不可用（取决于后端实现）

## 6. 后端启动方式（二选一）

### 6.1 推荐：直接使用已提交的后端 exe

仓库已包含 `resources/gist-video/backend/gist-video-backend/gist-video-backend.exe` 时，你可以**不安装** Python 依赖，直接在 `.env` 里设置：

```dotenv
GIST_VIDEO_BACKEND_ROOT="F:/gist/resources/gist-video/backend"
GIST_VIDEO_BACKEND_EXE="F:/gist/resources/gist-video/backend/gist-video-backend/gist-video-backend.exe"
```

### 6.2 需要 Python 调试时：创建 venv 并安装依赖

在确认 `resources/gist-video/backend/` 已就绪后，运行：

```powershell
.\scripts\setup-gist-video-backend.ps1
```

该脚本会在 `resources/gist-video/backend/.venv/` 创建虚拟环境并安装 `requirements-dev.txt` 依赖。随后你才可以启用 `.env` 的 `GIST_VIDEO_PYTHON`。

## 7. 启动开发模式

```powershell
yarn dev
```

进入应用后：
- 打开左侧菜单「视频解说」
- 观察页面顶部状态（已连接/未连接）
- 未连接时点击「重新连接」即可拉起后端

## 8. 后端单独启动（便于调试）

后端在开发模式下默认通过 Python 启动（`-m app.server`）。你可以手动启动以便在终端里直接看输出：

```powershell
Set-Location "F:/gist/resources/gist-video/backend"
.\.venv\Scripts\python.exe -m app.server --host 127.0.0.1 --port 37123 --log-level info
```

## 9. 日志位置（排障必看）

应用会把后端 stdout/stderr 追加写入用户目录（方便 UI 启动失败时回溯）：

```
%APPDATA%/read-no-more/gist-video/server.stdout.log
%APPDATA%/read-no-more/gist-video/server.stderr.log
```

## 10. 常见问题

### 10.1 视频解说页面提示“后端启动失败 / 未连接”

按优先级排查：
1) `resources/gist-video/backend/app/server/__main__.py` 是否存在  
2) 优先确认你走的是哪种启动方式：
   - `GIST_VIDEO_BACKEND_EXE`：确保 exe 文件存在
   - `GIST_VIDEO_PYTHON`：确保 `.venv/Scripts/python.exe` 存在（必须先跑 `setup-gist-video-backend.ps1`）
3) `bin/ffmpeg.exe` 与 `bin/ffprobe.exe` 是否存在  
4) 端口是否被占用（可通过设置 `GIST_VIDEO_PORT` 固定端口排查）

如果看到 `spawn ...\.venv\\Scripts\\python.exe ENOENT`：说明你配置了 `GIST_VIDEO_PYTHON` 但本机还没创建 venv。请先运行 `.\scripts\setup-gist-video-backend.ps1`，或直接改用 `GIST_VIDEO_BACKEND_EXE`。

### 10.2 `pip install` 失败

常见原因：网络、权限、Python 版本不匹配。建议：
- 确保使用 Python 3.11
- 尝试在 PowerShell（管理员/普通用户均可）重新运行脚本
- 必要时删除 `resources/gist-video/backend/.venv/` 后重建（由你手动确认后再做）

### 10.3 向量化/onnxruntime 相关报错

这通常与“模型缺失、VC 运行库、或 DLL 冲突”有关。优先查看 `server.stderr.log` 的 tail，并按作者提供的模型/环境要求配置。
