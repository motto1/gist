# Build UI Tool (Windows)

## Prerequisites

- Python 3.10+ installed

## Run

- `python scripts/build-ui.py`

## Build EXE

- `scripts\build-ui-build.bat`
- output: `dist\build-ui.exe`

## Fields

- Edition: `pro` or `basic`
- Voice:
  - `full`: keep `tts/**` in packaged app
  - `none`: exclude `tts/**` from packaged app
- Arch:
  - `x64`: run `yarn build:win:x64`
  - `arm64`: run `yarn build:win:arm64`
  - `both`: run `yarn build:win`
- Version: writes to `package.json`
- Build suffix: appended to artifact filename (e.g. `gist-1.2.3-basic-setup.exe`)
  - Default: auto-generated from edition + voice (can be overridden)

## Build

- Uses one of:
  - `yarn build:win:x64`
  - `yarn build:win:arm64`
  - `yarn build:win`
- Passes env:
  - `APP_EDITION` (for edition config)
  - `BUILD_SUFFIX` (for artifact suffix)
  - `BUILD_VOICE` (for bundling `tts/**`)

### Cross-arch note (Windows)

目前不支持 cross-arch（例如在 x64 主机上打包 arm64）。请在目标架构机器上执行对应的 `yarn build:win:<arch>`。
