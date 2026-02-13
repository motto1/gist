const cp = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

function run(cmd, args, opts) {
  const r = cp.spawnSync(cmd, args, {
    stdio: 'inherit',
    windowsHide: true,
    ...opts
  })
  if (r.error) throw r.error
  if (r.status !== 0) {
    throw new Error(`Command failed (${r.status}): ${cmd} ${args.join(' ')}`)
  }
}

function runCapture(cmd, args, opts) {
  const r = cp.spawnSync(cmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    ...opts
  })
  if (r.error) throw r.error
  if (r.status !== 0) {
    throw new Error(`Command failed (${r.status}): ${cmd} ${args.join(' ')}`)
  }
  return String(r.stdout || '').trim()
}

function resolveBackendRoot() {
  return path.join(__dirname, '..', 'resources', 'gist-video', 'backend')
}

function resolveVenvPython(venvDir) {
  if (process.platform === 'win32') return path.join(venvDir, 'Scripts', 'python.exe')
  return path.join(venvDir, 'bin', 'python')
}

function isSignatureTrackedFile(relPath) {
  if (relPath === '_backend_entry.py') return true
  if (/^requirements.*\.txt$/i.test(relPath)) return true
  if (/^app\/.+\.(py|json|ya?ml|toml|ini|cfg|txt)$/i.test(relPath)) return true
  return false
}

function listFilesRecursively(rootDir, currentDir = rootDir) {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true })
  const files = []

  const ignoredDirs = new Set([
    '.git',
    '.venv',
    '.pytest_cache',
    '__pycache__',
    'venv',
    'gist-video-backend',
    'build',
    'dist',
    'data',
    'm3e-small',
    'bin'
  ])

  for (const entry of entries) {
    const absPath = path.join(currentDir, entry.name)
    const relPath = path.relative(rootDir, absPath).replace(/\\/g, '/')

    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name)) continue
      files.push(...listFilesRecursively(rootDir, absPath))
      continue
    }

    if (!entry.isFile()) continue
    if (/\.(pyc|pyo|log)$/i.test(entry.name)) continue
    if (!isSignatureTrackedFile(relPath)) continue
    files.push(relPath)
  }

  return files.sort((a, b) => a.localeCompare(b))
}

function computeBackendBuildSignature(backendRoot) {
  const hash = crypto.createHash('sha256')
  const files = listFilesRecursively(backendRoot)

  for (const relPath of files) {
    const absPath = path.join(backendRoot, relPath)
    const content = fs.readFileSync(absPath)
    hash.update(relPath)
    hash.update('\0')
    hash.update(content)
    hash.update('\0')
  }

  const selfScript = fs.readFileSync(__filename)
  hash.update('__build_script__')
  hash.update('\0')
  hash.update(selfScript)

  return hash.digest('hex')
}

function readBuildSignature(signatureFile) {
  try {
    if (!fs.existsSync(signatureFile)) return ''
    return String(fs.readFileSync(signatureFile, 'utf8') || '').trim()
  } catch {
    return ''
  }
}

function writeBuildSignature(signatureFile, signature) {
  fs.mkdirSync(path.dirname(signatureFile), { recursive: true })
  fs.writeFileSync(signatureFile, `${signature}\n`, 'utf8')
}

function ensureWindowsVcRuntime(outDir) {
  if (process.platform !== 'win32') return
  const internalDir = path.join(outDir, '_internal')
  if (!fs.existsSync(internalDir)) return

  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const system32 = path.join(systemRoot, 'System32')
  const dlls = [
    ['vcruntime140.dll', 'vcruntime140.dll'],
    ['vcruntime140_1.dll', 'vcruntime140_1.dll'],
    ['msvcp140.dll', 'msvcp140.dll'],
    // Keep the destination filename stable for existing packages.
    ['msvcp140_1.dll', 'MSVCP140_1.dll'],
    // Some builds (and indirect deps) expect this to be present.
    ['concrt140.dll', 'concrt140.dll']
  ]

  for (const [srcName, dstName] of dlls) {
    const src = path.join(system32, srcName)
    const dst = path.join(internalDir, dstName)
    if (!fs.existsSync(src)) continue
    try {
      fs.copyFileSync(src, dst)
      console.log(`[gist-video] vc runtime: ${dstName} <= ${src}`)
    } catch (e) {
      console.warn(`[gist-video] warning: failed to copy ${srcName}:`, e && e.message ? e.message : e)
    }
  }
}

async function removeDirWithRetries(dir, attempts = 5, delayMs = 300) {
  if (!fs.existsSync(dir)) return
  const retryable = new Set(['EPERM', 'EBUSY', 'EACCES'])
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      if (!fs.existsSync(dir)) return
    } catch (e) {
      const code = e && e.code ? String(e.code) : ''
      if (!retryable.has(code)) throw e
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  throw new Error(
    `[gist-video] failed to clean output dir: ${dir}\n` +
      '请确认已关闭正在运行的 gist-video / gist-video-backend.exe，或将杀软对该目录的占用移除后重试。'
  )
}

/**
 * Build a self-contained gist-video backend executable (PyInstaller onedir).
 *
 * Output:
 * - resources/gist-video/backend/gist-video-backend/gist-video-backend(.exe)
 *
 * Notes:
 * - This is meant for packaging (electron-builder) so end-users don't need Python/pip.
 * - Builds for the host architecture only. Cross-building (x64->arm64) isn't supported here.
 */
async function buildGistVideoBackend() {
  const backendRoot = resolveBackendRoot()
  const entry = path.join(backendRoot, '_backend_entry.py')
  const requirements = path.join(backendRoot, 'requirements-dev.txt')

  const exeName = process.platform === 'win32' ? 'gist-video-backend.exe' : 'gist-video-backend'
  const outDir = path.join(backendRoot, 'gist-video-backend')
  const outExe = path.join(outDir, exeName)
  const signatureFile = path.join(outDir, '.build-signature')

  const force = String(process.env.GIST_VIDEO_FORCE_REBUILD || '').trim() === '1'
  const currentSignature = computeBackendBuildSignature(backendRoot)
  const previousSignature = readBuildSignature(signatureFile)

  if (fs.existsSync(outExe) && !force && previousSignature && previousSignature === currentSignature) {
    console.log(`[gist-video] backend exe is up-to-date: ${outExe}`)
    // Even if we skip rebuilding, keep the output directory healthy for packaging.
    ensureWindowsVcRuntime(outDir)
    return
  }

  if (force) {
    console.log('[gist-video] force rebuild enabled by GIST_VIDEO_FORCE_REBUILD=1')
  } else if (!fs.existsSync(outExe)) {
    console.log('[gist-video] backend exe missing, triggering rebuild')
  } else if (!previousSignature) {
    console.log('[gist-video] build signature missing, triggering rebuild')
  } else if (previousSignature !== currentSignature) {
    console.log('[gist-video] backend sources changed, triggering rebuild')
  }

  if (!fs.existsSync(entry)) throw new Error(`[gist-video] entry not found: ${entry}`)
  if (!fs.existsSync(requirements)) throw new Error(`[gist-video] requirements not found: ${requirements}`)

  const python = process.platform === 'win32' ? 'python' : 'python3'
  console.log(`[gist-video] building backend exe via PyInstaller, python=${python}`)
  console.log(`[gist-video] backendRoot=${backendRoot}`)

  // Build in a temp venv so we don't pollute the developer's global Python.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gist-video-backend-build-'))
  const venvDir = path.join(tmp, 'venv')
  const workDir = path.join(tmp, 'work')
  const specDir = path.join(tmp, 'spec')

  try {
    run(python, ['-m', 'venv', venvDir], { cwd: backendRoot })
    const vpy = resolveVenvPython(venvDir)
    if (!fs.existsSync(vpy)) throw new Error(`[gist-video] venv python not found: ${vpy}`)

    run(vpy, ['-m', 'pip', 'install', '-U', 'pip', 'setuptools', 'wheel'], { cwd: backendRoot })
    run(vpy, ['-m', 'pip', 'install', '-r', requirements], { cwd: backendRoot })
    run(vpy, ['-m', 'pip', 'install', 'pyinstaller>=6.0'], { cwd: backendRoot })

    // Sanity check: ensure onnxruntime can import in the build venv (otherwise the build would be broken anyway).
    run(vpy, ['-c', 'import onnxruntime as ort; print(ort.__version__)'], { cwd: backendRoot })

    // onnxruntime ships provider DLLs (e.g. onnxruntime_providers_cpu.dll) that are loaded at runtime.
    // PyInstaller doesn't always detect those dynamic loads, so we add them explicitly.
    const addBinarySep = process.platform === 'win32' ? ';' : ':'
    const extraPyinstallerArgs = []
    try {
      const out = runCapture(
        vpy,
        [
          '-c',
          [
            'import glob, importlib.util, os',
            'spec = importlib.util.find_spec("onnxruntime")',
            'pkg = os.path.dirname(spec.origin) if spec and spec.origin else ""',
            'capi = os.path.join(pkg, "capi")',
            'print(capi)',
            'for p in sorted(glob.glob(os.path.join(capi, "onnxruntime_providers_*.dll"))):',
            '    print(p)'
          ].join('\n')
        ],
        { cwd: backendRoot }
      )
      const lines = out.split(/\r?\n/g).map((s) => s.trim()).filter(Boolean)
      const capiDir = lines[0] || ''
      const dlls = lines.slice(1).filter((p) => p.toLowerCase().endsWith('.dll'))
      if (capiDir && dlls.length > 0) {
        console.log(`[gist-video] onnxruntime capi dir: ${capiDir}`)
        for (const dll of dlls) {
          // PyInstaller onedir uses dist/<app>/_internal as the collection dir.
          // Do NOT prefix `_internal` in the destination, otherwise we'll end up with `_internal/_internal/...`.
          extraPyinstallerArgs.push('--add-binary', `${dll}${addBinarySep}onnxruntime/capi`)
        }
      } else {
        console.warn('[gist-video] warning: failed to discover onnxruntime provider DLLs; packaging may break on some machines')
      }
    } catch (e) {
      console.warn('[gist-video] warning: failed to discover onnxruntime provider DLLs:', e && e.message ? e.message : e)
    }

    // Ensure output dir is clean (avoid stale DLLs / hooks).
    await removeDirWithRetries(outDir)

    run(
      vpy,
      [
        '-m',
        'PyInstaller',
        '--noconfirm',
        '--clean',
        '--onedir',
        '--name',
        'gist-video-backend',
        ...extraPyinstallerArgs,
        '--distpath',
        backendRoot,
        '--workpath',
        workDir,
        '--specpath',
        specDir,
        entry
      ],
      { cwd: backendRoot, env: { ...process.env, PYTHONUTF8: '1' } }
    )

    if (!fs.existsSync(outExe)) {
      throw new Error(`[gist-video] build succeeded but output exe missing: ${outExe}`)
    }
    // Some Python distributions (notably Microsoft Store Python) ship app-local VC runtime DLLs
    // that can break onnxruntime.dll initialization under PyInstaller. Overwrite with system32
    // copies to make the bundled backend reliable.
    ensureWindowsVcRuntime(outDir)
    writeBuildSignature(signatureFile, currentSignature)
    console.log(`[gist-video] backend exe built: ${outExe}`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

module.exports = buildGistVideoBackend

if (require.main === module) {
  buildGistVideoBackend().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
