# 🖥️ Develop

## IDE Setup

- Editor: [Cursor](https://www.cursor.com/), etc. Any VS Code compatible editor.
- Linter: [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint)
- Formatter: [Biome](https://marketplace.visualstudio.com/items?itemName=biomejs.biome)

## Project Setup

### Install

```bash
yarn
```

### Development

### Setup Node.js

Download and install [Node.js v20.x.x](https://nodejs.org/en/download)

### Setup Yarn

```bash
corepack enable
corepack prepare yarn@4.6.0 --activate
```

### Install Dependencies

```bash
yarn install
```

### Environment Variables（可选）

项目不再自动读取本地环境文件；如需配置环境变量，请直接在当前终端/CI 中设置。

PowerShell 示例：

```powershell
$env:API_KEY="sk-xxx"
$env:BASE_URL="https://api.siliconflow.cn/v1/"
$env:MODEL="Qwen/Qwen3-235B-A22B-Instruct-2507"
```

### Start

```bash
yarn dev
```

### gist-video Backend（可选）

开发模式（`yarn dev`）下，应用默认通过 **Python 模块**启动 gist-video 后端（`python -m app.server`），因此需要开发机存在可用的 Python 环境与依赖。

推荐（Windows）执行一次脚本创建本地 `.venv` 并安装依赖（避免污染系统 Python、减少缺依赖/DLL 冲突）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-gist-video-backend.ps1
```

无需配置任何后端路径：应用会自动从固定相对路径 `resources/gist-video/backend` 解析后端资源。

### Debug

```bash
yarn debug
```

Then input chrome://inspect in browser

### Test

```bash
yarn test
```

### Build

```bash
# For windows
$ yarn build:win

# For macOS
$ yarn build:mac

# For Linux
$ yarn build:linux
```
