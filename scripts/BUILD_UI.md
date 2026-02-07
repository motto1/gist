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

When building `arm64` on an `x64` host, `before-pack` cannot locally compile `gist-video-backend`.
You can provide a prebuilt backend by setting:

- `GIST_VIDEO_BACKEND_EXE=<path-to-arm64-gist-video-backend.exe>`

The script will copy the whole prebuilt backend directory (exe + `_internal`) into `resources/gist-video/backend/gist-video-backend`.
