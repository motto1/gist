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

### ENV

```bash
copy .env.example .env
```

### Start

```bash
yarn dev
```

### gist-video Backend（可选）

如果你在开发环境中使用 gist-video（如视频切片/字幕/向量化等），并且发现 `yarn dev` 只有在手动激活某个 venv 后才可用，
本质原因是：后端会回退到系统 `python`，导致缺少依赖（如 `onnxruntime`）或触发 Windows DLL 初始化失败。

Windows 下建议先执行一次：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-gist-video-backend.ps1
```

或者在 `.env` 中显式指定：

```env
GIST_VIDEO_PYTHON="F:/gist/resources/gist-video/backend/.venv/Scripts/python.exe"
```

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
