# 视频解说：本地编译与调试指南（无内置产物）

> 本仓库默认 **不提交** `resources/gist-video/`（包含后端代码/可执行文件、FFmpeg、模型等）。  
> 因此要在开发环境完整使用「视频解说」，需要按本文档准备这些资源。

## 0. 你将得到什么

- `yarn dev` 可正常启动并编译整个 Electron 应用
- 「视频解说」页面可启动本地后端（Python 模式），并完成素材库建库/一键成片等流程
- 模型文件不在仓库中：需要**联系作者**获取（否则部分能力会降级或不可用）

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

如需明确指定视频后端路径（推荐，避免误用系统 Python）：

```dotenv
# .env（示例）
GIST_VIDEO_BACKEND_ROOT="F:/gist/resources/gist-video/backend"
GIST_VIDEO_PYTHON="F:/gist/resources/gist-video/backend/.venv/Scripts/python.exe"
#GIST_VIDEO_PORT=37123
```

## 3. 准备 `resources/gist-video/backend`（必做）

你需要获取作者提供的 **gist-video 后端源码包**，并解压到：

```
resources/gist-video/backend/
```

最低要求：该目录内必须存在以下“标记文件/目录”，否则主进程无法识别后端根目录：

```
resources/gist-video/backend/app/server/__main__.py
resources/gist-video/backend/requirements-dev.txt
```

## 4. 准备 FFmpeg（必做）

下载 FFmpeg 精简版 exe 后，把文件放到：

```
resources/gist-video/backend/bin/ffmpeg.exe
resources/gist-video/backend/bin/ffprobe.exe
```

（可选）验证：

```powershell
.\resources\gist-video\backend\bin\ffmpeg.exe -version
```

## 5. 准备模型（可选，但影响功能）

模型与部分资源 **不在仓库中**，请联系作者获取并放到作者指定的目录。  
如果缺少模型：
- “向量化/检索”可能会降级（例如回退到轻量 local_hash），召回效果会变差
- 某些功能可能直接不可用（取决于后端实现）

## 6. 一键安装后端依赖（必做）

在确认 `resources/gist-video/backend/` 已就绪后，运行：

```powershell
.\scripts\setup-gist-video-backend.ps1
```

该脚本会在 `resources/gist-video/backend/.venv/` 创建虚拟环境并安装 `requirements-dev.txt` 依赖。

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
2) 是否已运行 `.\scripts\setup-gist-video-backend.ps1`（并成功安装依赖）  
3) `bin/ffmpeg.exe` 与 `bin/ffprobe.exe` 是否存在  
4) 端口是否被占用（可通过设置 `GIST_VIDEO_PORT` 固定端口排查）

### 10.2 `pip install` 失败

常见原因：网络、权限、Python 版本不匹配。建议：
- 确保使用 Python 3.11
- 尝试在 PowerShell（管理员/普通用户均可）重新运行脚本
- 必要时删除 `resources/gist-video/backend/.venv/` 后重建（由你手动确认后再做）

### 10.3 向量化/onnxruntime 相关报错

这通常与“模型缺失、VC 运行库、或 DLL 冲突”有关。优先查看 `server.stderr.log` 的 tail，并按作者提供的模型/环境要求配置。
