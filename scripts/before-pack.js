const fs = require('fs')
const path = require('path')

const { Arch } = require('electron-builder')
const { downloadNpmPackage } = require('./utils')

// if you want to add new prebuild binaries packages with different architectures, you can add them here
// please add to allX64 and allArm64 from yarn.lock
const allArm64 = {
  '@img/sharp-darwin-arm64': '0.34.3',
  '@img/sharp-win32-arm64': '0.34.3',
  '@img/sharp-linux-arm64': '0.34.3',

  '@img/sharp-libvips-darwin-arm64': '1.2.0',
  '@img/sharp-libvips-linux-arm64': '1.2.0',

  '@libsql/darwin-arm64': '0.4.7',
  '@libsql/linux-arm64-gnu': '0.4.7',
  '@strongtz/win32-arm64-msvc': '0.4.7',

  '@napi-rs/system-ocr-darwin-arm64': '1.0.2',
  '@napi-rs/system-ocr-win32-arm64-msvc': '1.0.2'
}

const allX64 = {
  '@img/sharp-darwin-x64': '0.34.3',
  '@img/sharp-linux-x64': '0.34.3',
  '@img/sharp-win32-x64': '0.34.3',

  '@img/sharp-libvips-darwin-x64': '1.2.0',
  '@img/sharp-libvips-linux-x64': '1.2.0',

  '@libsql/darwin-x64': '0.4.7',
  '@libsql/linux-x64-gnu': '0.4.7',
  '@libsql/win32-x64-msvc': '0.4.7',

  '@napi-rs/system-ocr-darwin-x64': '1.0.2',
  '@napi-rs/system-ocr-win32-x64-msvc': '1.0.2'
}

const platformToArch = {
  mac: 'darwin',
  windows: 'win32',
  linux: 'linux'
}

exports.default = async function (context) {
  // electron-builder doesn't always clean the unpacked output directory between runs on Windows.
  // If an older build already renamed electron.exe -> <productName>.exe, the next run can fail with:
  // ENOENT: rename '<out>/electron.exe' -> '<out>/<product>.exe'
  // Clean it defensively (restricted to dist/*-unpacked under this repo).
  try {
    const appOutDir = context && context.appOutDir ? String(context.appOutDir) : ''
    if (appOutDir) {
      const resolved = path.resolve(appOutDir)
      const distRoot = path.resolve(__dirname, '..', 'dist') + path.sep
      if (resolved.startsWith(distRoot) && /-unpacked$/i.test(resolved)) {
        fs.rmSync(resolved, { recursive: true, force: true })
      }
    }
  } catch {
    // ignore
  }

  const rawEdition = process.env.APP_EDITION || 'pro'
  const normalizedEdition = rawEdition.toLowerCase()
  const edition = normalizedEdition === 'basic' ? 'basic' : 'pro'
  const editionFilePath = path.join(__dirname, '..', 'resources', 'data', 'edition.json')

  const rawVoice = process.env.BUILD_VOICE || 'full'
  const voiceMode = rawVoice.toLowerCase() === 'none' ? 'none' : 'full'

  const rawBuildSuffix = process.env.BUILD_SUFFIX || ''
  const normalizedBuildSuffix = rawBuildSuffix
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^0-9A-Za-z._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')

  fs.mkdirSync(path.dirname(editionFilePath), { recursive: true })
  fs.writeFileSync(editionFilePath, JSON.stringify({ edition }, null, 2), 'utf-8')
  console.log(`[before-pack] edition=${edition}`)
  console.log(`[before-pack] voice=${voiceMode}`)
  if (normalizedBuildSuffix) {
    console.log(`[before-pack] suffix=${normalizedBuildSuffix}`)
  }

  if (voiceMode === 'none') {
    const files = context.packager.config.files
    if (Array.isArray(files) && files.length > 0 && files[0] && Array.isArray(files[0].filter)) {
      files[0].filter = files[0].filter.filter((rule) => rule !== 'tts/**' && rule !== 'tts/**/*')
      files[0].filter.push('!tts/**')
    }
  }

  if (normalizedBuildSuffix) {
    const win = context.packager.config.win
    if (win && typeof win.artifactName === 'string' && win.artifactName.length > 0) {
      const token = '.${ext}'
      if (win.artifactName.includes(token)) {
        win.artifactName = win.artifactName.replace(token, `-${normalizedBuildSuffix}${token}`)
      } else {
        win.artifactName = `${win.artifactName}-${normalizedBuildSuffix}`
      }
    }
  }

  const arch = context.arch
  const archType = arch === Arch.arm64 ? 'arm64' : 'x64'
  const platform = context.packager.platform.name

  // Build gist-video backend executable for packaged distributions.
  // NOTE: We intentionally don't support cross-arch packaging here.
  // Reason: the backend is a native Python/PyInstaller build; providing external paths via env makes builds non-reproducible.
  if (platform === 'windows') {
    const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64'

    if (hostArch !== archType) {
      throw new Error(
        `[before-pack] Cross-arch packaging is not supported for gist-video backend (target=${archType}, host=${hostArch}). ` +
          `Please run the ${archType} build on a ${archType} machine.`
      )
    }

    // Always rebuild in packaging to avoid shipping a stale backend executable after backend code changes.
    process.env.GIST_VIDEO_FORCE_REBUILD = '1'
    const buildGistVideoBackend = require('./build-gist-video-backend')
    await buildGistVideoBackend()
  }

  const arm64Filters = Object.keys(allArm64).map((f) => '!node_modules/' + f + '/**')
  const x64Filters = Object.keys(allX64).map((f) => '!node_modules/' + f + '/*')

  const downloadPackages = async (packages) => {
    console.log('downloading packages ......')
    const downloadPromises = []

    for (const name of Object.keys(packages)) {
      if (name.includes(`${platformToArch[platform]}`) && name.includes(`-${archType}`)) {
        downloadPromises.push(
          downloadNpmPackage(
            name,
            `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${packages[name]}.tgz`
          )
        )
      }
    }

    await Promise.all(downloadPromises)
  }

  const changeFilters = async (packages, filtersToExclude, filtersToInclude) => {
    await downloadPackages(packages)
    // remove filters for the target architecture (allow inclusion)

    let filters = context.packager.config.files[0].filter
    filters = filters.filter((filter) => !filtersToInclude.includes(filter))
    // add filters for other architectures (exclude them)
    filters.push(...filtersToExclude)

    context.packager.config.files[0].filter = filters
  }

  if (arch === Arch.arm64) {
    await changeFilters(allArm64, x64Filters, arm64Filters)
    return
  }

  if (arch === Arch.x64) {
    await changeFilters(allX64, arm64Filters, x64Filters)
    return
  }
}
