# 视频解说：本地编译与调试指南

> 目标：让其他人 **不包含内置后端产物** 的情况下，也能本地完成编译与调试。

## 1. 基础准备

1) 安装 Node.js（满足 `package.json` 中 `engines.node` 要求）  
2) 安装 Yarn（或使用 Corepack）  
3) 安装 Python 3.11（推荐与项目中后端一致的版本）  
4) 安装 FFmpeg（用于视频处理）

## 2. 初始化项目

```bash
yarn install
```

复制环境变量示例并按需填写：

```bash
copy .env.example .env
```

## 3. 准备视频解说后端（本地构建）

本项目不提交 `resources/gist-video/` 二进制产物，因此需要本地构建后端。

### 方式 A：使用脚本（推荐）

```powershell
.\scripts\setup-gist-video-backend.ps1
```

脚本会：
- 创建/更新后端虚拟环境
- 安装依赖
- 打包/准备本地后端资源

### 方式 B：手动构建（仅在脚本不可用时）

1) 进入后端目录  
2) 创建并激活 venv  
3) 安装依赖  
4) 按项目脚本构建后端

> 具体路径/命令以 `scripts/setup-gist-video-backend.ps1` 为准。

## 4. 启动开发模式

```bash
yarn dev
```

进入应用后：
- 左侧菜单打开「视频解说」
- 确认后端连接状态
- 如未连接，可点击「重新连接」

## 5. 常见问题

### 5.1 后端未连接
检查：
- Python 是否安装且可用
- 后端依赖是否安装成功
- `scripts/setup-gist-video-backend.ps1` 是否完成
- 端口是否被占用

### 5.2 需要重建后端
再次运行：

```powershell
.\scripts\setup-gist-video-backend.ps1
```

---

如需打包内置后端，请在打包流程中显式包含 `resources/gist-video/` 产物（默认不提交到仓库）。
