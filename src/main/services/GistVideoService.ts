import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

import { loggerService } from '@logger'
import type { GistVideoRuntimeConfig } from '@shared/types'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { app } from 'electron'

type BackendInfo = {
  baseUrl: string
  wsBase: string
  port: number
  pid: number
  dataDir: string
  backendRoot: string
  startedAt: number
}

const logger = loggerService.withContext('GistVideoService')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const isAsarPath = (p: string) => /app\.asar($|[\\/])/.test(p) && !/app\.asar\.unpacked($|[\\/])/.test(p)

function safeReadTail(filePath: string, maxBytes: number): string {
  try {
    if (!fs.existsSync(filePath)) return ''
    const st = fs.statSync(filePath)
    if (!st.isFile() || st.size <= 0) return ''
    const start = Math.max(0, st.size - maxBytes)
    const len = st.size - start
    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, start)
      return buf.toString('utf8').trim()
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a TCP port')))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function isExistingFile(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function hasBackendMarker(candidate: string, exeName: string): boolean {
  try {
    const markerPy = path.join(candidate, 'app', 'server', '__main__.py')
    const markerExe = path.join(candidate, exeName)
    const markerExeOnedir = path.join(candidate, 'gist-video-backend', exeName)

    return isExistingFile(markerPy) || isExistingFile(markerExe) || isExistingFile(markerExeOnedir)
  } catch {
    return false
  }
}

function resolveBackendRoot(): string {
  const appRoot = app.getAppPath()
  const unpackedRoot = path.join(path.dirname(appRoot), 'app.asar.unpacked')
  const exeName = process.platform === 'win32' ? 'gist-video-backend.exe' : 'gist-video-backend'

  const seen = new Set<string>()
  const candidates: string[] = []

  const pushCandidate = (p: string) => {
    if (!p) return
    const resolved = path.resolve(p)
    if (seen.has(resolved)) return
    seen.add(resolved)
    candidates.push(resolved)
  }

  const addCandidatesFromStart = (startDir: string) => {
    if (!startDir) return
    let cur = path.resolve(startDir)

    // Walk up a few levels and try the fixed relative layout from each ancestor.
    for (let i = 0; i < 8; i += 1) {
      pushCandidate(path.join(cur, 'resources', 'gist-video', 'backend'))
      pushCandidate(path.join(cur, 'gist-video', 'backend'))

      const parent = path.dirname(cur)
      if (parent === cur) break
      cur = parent
    }
  }

  // Packaged: prefer the unpacked directory first.
  addCandidatesFromStart(unpackedRoot)

  // Then try common anchors (without relying on process.cwd()).
  addCandidatesFromStart(appRoot)
  addCandidatesFromStart(path.dirname(app.getPath('exe')))

  const resourcesPath = (process as any).resourcesPath as string | undefined
  if (resourcesPath) {
    addCandidatesFromStart(resourcesPath)
  }

  for (const candidate of candidates) {
    if (isAsarPath(candidate)) continue
    if (hasBackendMarker(candidate, exeName)) return candidate
  }

  logger.warn('Failed to resolve gist-video backend root; falling back to best-effort candidate', {
    appRoot,
    candidates
  })

  const fallback = candidates.find((c) => !isAsarPath(c)) || candidates[0] || path.join(path.dirname(appRoot), 'resources', 'gist-video', 'backend')
  return fallback
}

function getVenvPythonPath(backendRoot: string): string {
  return process.platform === 'win32'
    ? path.join(backendRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(backendRoot, '.venv', 'bin', 'python')
}

function resolvePythonCommand(backendRoot: string): string {
  // Prefer a local venv if present (dev-friendly; avoids polluting global Python).
  const venvPython = getVenvPythonPath(backendRoot)
  if (isExistingFile(venvPython)) {
    return venvPython
  }

  // Fallback to system Python.
  return process.platform === 'win32' ? 'python' : 'python3'
}

function resolveBackendExe(backendRoot: string): string | null {
  const exeName = process.platform === 'win32' ? 'gist-video-backend.exe' : 'gist-video-backend'

  // Prefer the bundled onedir layout produced by build-gist-video-backend.js
  const onedir = path.join(backendRoot, 'gist-video-backend', exeName)
  if (isExistingFile(onedir)) return onedir

  // Fallback: allow placing the executable directly under backendRoot.
  const direct = path.join(backendRoot, exeName)
  if (isExistingFile(direct)) return direct

  return null
}

async function waitForHealth(baseUrl: string, child: ChildProcessWithoutNullStreams, timeoutMs: number) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`后端进程已退出（exitCode=${child.exitCode}）`)
    }
    const ok = await checkHealth(baseUrl)
    if (ok) return
    await sleep(250)
  }
  throw new Error(`等待后端启动超时（${timeoutMs}ms）：${baseUrl}`)
}

async function checkHealth(baseUrl: string): Promise<boolean> {
  try {
    // Important: bypass any global proxy/agent hooks by using a raw TCP request.
    const url = new URL(`${baseUrl}/api/health`)
    const host = url.hostname || '127.0.0.1'
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    const pathPart = url.pathname + url.search

    return await new Promise<boolean>((resolve) => {
      let settled = false
      let socket: net.Socket | null = null
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        try {
          socket?.destroy()
        } catch {
          // ignore
        }
        resolve(ok)
      }

      socket = net.createConnection({ host, port })
      socket.setTimeout(3000)

      socket.on('connect', () => {
        socket.write(`GET ${pathPart} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
      })

      let head = ''
      socket.on('data', (chunk) => {
        head += chunk.toString('utf8')
        const eol = head.indexOf('\r\n')
        if (eol === -1) return
        const statusLine = head.slice(0, eol)
        const parts = statusLine.trim().split(/\s+/)
        if (!parts[0] || !parts[0].startsWith('HTTP/')) return finish(false)
        const code = Number(parts[1] || 0)
        finish(code >= 200 && code < 300)
      })

      socket.on('timeout', () => finish(false))
      socket.on('error', () => finish(false))
      socket.on('end', () => finish(false))
    })
  } catch {
    return false
  }
}

export class GistVideoService {
  private static instance: GistVideoService | null = null

  private child: ChildProcessWithoutNullStreams | null = null
  private info: BackendInfo | null = null
  private starting: Promise<BackendInfo> | null = null

  /**
   * Runtime config (in-memory only) injected by Electron.
   * This will be passed to the Python backend via env on (re)start.
   */
  private runtimeConfig: GistVideoRuntimeConfig | null = null
  private appliedRuntimeConfig: GistVideoRuntimeConfig | null = null

  private constructor() {
    app.on('before-quit', () => {
      void this.stopBackend()
    })
  }

  public static getInstance(): GistVideoService {
    if (!GistVideoService.instance) {
      GistVideoService.instance = new GistVideoService()
    }
    return GistVideoService.instance
  }

  private normalizeRuntimeConfig(cfg?: GistVideoRuntimeConfig | null): GistVideoRuntimeConfig | null {
    if (cfg === null) return null
    const base = String(cfg?.visionApiBase || '').trim()
    const key = String(cfg?.visionApiKey || '').trim()
    if (!base || !key) return null
    return { visionApiBase: base, visionApiKey: key }
  }

  private isSameRuntimeConfig(a: GistVideoRuntimeConfig | null, b: GistVideoRuntimeConfig | null): boolean {
    const aBase = String(a?.visionApiBase || '').trim()
    const aKey = String(a?.visionApiKey || '').trim()
    const bBase = String(b?.visionApiBase || '').trim()
    const bKey = String(b?.visionApiKey || '').trim()
    return aBase === bBase && aKey === bKey
  }

  private async applyRuntimeConfigToBackend(baseUrl: string): Promise<void> {
    const cfg = this.runtimeConfig
    if (!cfg?.visionApiBase || !cfg?.visionApiKey) return

    try {
      const r = await fetch(`${baseUrl}/api/runtime/vision`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_base: cfg.visionApiBase, api_key: cfg.visionApiKey })
      })
      if (!r.ok) {
        const text = await r.text().catch(() => '')
        throw new Error(`${r.status} ${r.statusText}${text ? `: ${text.slice(0, 240)}` : ''}`)
      }
      this.appliedRuntimeConfig = cfg
      logger.info('Applied runtime vision credentials to gist-video backend', {
        baseUrl,
        apiBase: cfg.visionApiBase,
        apiKey: cfg.visionApiKey ? `${cfg.visionApiKey.slice(0, 4)}***${cfg.visionApiKey.slice(-4)}` : ''
      })
    } catch (e) {
      logger.warn('Failed to apply runtime config to gist-video backend', e as Error)
    }
  }

  public async ensureBackend(runtimeConfig?: GistVideoRuntimeConfig | null): Promise<BackendInfo> {
    if (runtimeConfig !== undefined) {
      this.runtimeConfig = this.normalizeRuntimeConfig(runtimeConfig)
    }

    // Fast path: already started and still alive.
    if (this.child && this.info && this.child.exitCode === null) {
      // If runtime config changed, push it via HTTP (no restart).
      if (!this.isSameRuntimeConfig(this.appliedRuntimeConfig, this.runtimeConfig)) {
        await this.applyRuntimeConfigToBackend(this.info.baseUrl)
      }
      return this.info
    }

    // Slow path: de-dup concurrent starts (React StrictMode / multiple pages may call ensureBackend).
    if (this.starting) return await this.starting

    this.starting = (async () => {
      const backendRoot = resolveBackendRoot()
      const dataDir = path.join(app.getPath('userData'), 'gist-video')
      ensureDir(dataDir)

      // Dev: assume the developer has a Python environment; always run the Python module
      // so local code changes take effect.
      // Packaged builds: always run the bundled executable.
      const pythonModuleEntry = path.join(backendRoot, 'app', 'server', '__main__.py')
      const hasPythonModule = isExistingFile(pythonModuleEntry)

      const exe = app.isPackaged ? resolveBackendExe(backendRoot) : null
      const python = resolvePythonCommand(backendRoot)

      if (!app.isPackaged && !hasPythonModule) {
        throw new Error(
          [
            'gist-video 后端不可用：缺少 Python 模块入口文件。',
            `backendRoot=${backendRoot}`,
            `expected=${pythonModuleEntry}`,
            '请确认仓库资源完整（resources/gist-video/backend 未被裁剪/删除）。'
          ].join('\n')
        )
      }

      // If python resolves to a venv path, ensure it exists; otherwise we expect "python/python3" in PATH.
      {
        const looksLikePath = /[\\/]/.test(python) || /^[a-zA-Z]:/.test(python)
        if (looksLikePath && !isExistingFile(python)) {
          throw new Error(
            [
              'gist-video 后端不可用：未找到 Python 可执行文件。',
              `backendRoot=${backendRoot}`,
              `python=${python}`,
              '请执行以下任一操作：',
              '1) 运行 .\\scripts\\setup-gist-video-backend.ps1 创建 .venv（推荐）',
              '2) 确保系统 python 已安装并加入 PATH'
            ].join('\n')
          )
        }
      }

      // If a previous run crashed, the randomly chosen port may still be in TIME_WAIT.
      // Prefer the port from existing backend settings if present to reduce flakiness.
      let preferredPort = Number(process.env.GIST_VIDEO_PORT || 0) || 0
      try {
        const settingsPath = path.join(dataDir, 'settings.json')
        if (!preferredPort && fs.existsSync(settingsPath)) {
          const raw = fs.readFileSync(settingsPath, 'utf8')
          const parsed = raw ? JSON.parse(raw) : {}
          const fromFile = Number(parsed?.server?.port || parsed?.port || 0)
          if (fromFile > 0) preferredPort = fromFile
        }
      } catch {
        // ignore
      }

      const port = preferredPort || (await getFreePort())
      const baseUrl = `http://127.0.0.1:${port}`
      const wsBase = `ws://127.0.0.1:${port}`

      // In packaged builds we expect a bundled backend executable.
      // Falling back to system Python is brittle (users may not have deps like onnxruntime).
      if (app.isPackaged && !exe) {
        throw new Error(
          [
            '安装包缺少内置 gist-video 后端可执行文件，无法启动后端。',
            `backendRoot=${backendRoot}`,
            '请重新安装/更新版本，或联系开发者确认打包流程已生成 gist-video-backend。'
          ].join('\n')
        )
      }

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        // backend runtime dirs
        GIST_VIDEO_ROOT: backendRoot,
        GIST_VIDEO_DATA_DIR: dataDir,
        GIST_VIDEO_BIN_DIR: path.join(backendRoot, 'bin'),
        // make python output predictable
        PYTHONUTF8: '1'
      }


      // Windows: avoid onnxruntime.dll conflicts from the parent process PATH.
      // The app bundles another onnxruntime.dll for TTS (sherpa-onnx). If that directory is on PATH,
      // Python's onnxruntime import can accidentally load the wrong DLL and fail with "DLL 初始化例程失败".
      if (process.platform === 'win32') {
        const orig = env.PATH || ''
        const parts = orig.split(path.delimiter).filter(Boolean)

        const preferred: string[] = []
        if (exe) {
          const exeDir = path.dirname(exe)
          const internalDir = path.join(exeDir, '_internal')
          const ortCapi = path.join(exeDir, '_internal', 'onnxruntime', 'capi')
          if (fs.existsSync(ortCapi) && fs.statSync(ortCapi).isDirectory()) {
            preferred.push(ortCapi)
          }
          // Ensure the base PyInstaller _internal dir is also on PATH so dependent DLLs
          // (vcruntime/msvcp/libssl/etc) can be resolved reliably when importing binary modules.
          if (fs.existsSync(internalDir) && fs.statSync(internalDir).isDirectory()) {
            preferred.push(internalDir)
          }
        }

        const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase()
        const preferredSet = new Set(preferred.map((p) => norm(p)))

        const filtered: string[] = []
        for (const p of parts) {
          const n = norm(p)
          if (preferredSet.has(n)) continue
          // Drop PATH entries that look like our bundled TTS folder and contain onnxruntime.dll.
          try {
            const isTtsDir = n.endsWith('\\tts') || n.includes('\\tts\\')
            if (isTtsDir && fs.existsSync(path.join(p, 'onnxruntime.dll'))) continue
          } catch {
            // ignore
          }
          filtered.push(p)
        }

        env.PATH = [...preferred, ...filtered].join(path.delimiter)
      }

      let command: string
      let args: string[]
      if (exe) {
        command = exe
        args = ['--host', '127.0.0.1', '--port', String(port), '--log-level', 'info']
      } else {
        command = python
        args = ['-m', 'app.server', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'info']
      }

      logger.info(`Starting gist-video backend: ${command} ${args.join(' ')}`)
      logger.info(`backendRoot=${backendRoot}`)
      logger.info(`dataDir=${dataDir}`)

      const child = spawn(command, args, {
        cwd: backendRoot,
        env,
        windowsHide: true,
        stdio: 'pipe'
      })

      this.child = child

      const stdoutPath = path.join(dataDir, 'server.stdout.log')
      const stderrPath = path.join(dataDir, 'server.stderr.log')

      // Persist logs for debugging.
      // Note: If the child exits extremely early, the streams may never emit data.
      // We still create log files to make failures diagnosable.
      try {
        fs.mkdirSync(dataDir, { recursive: true })
        if (!fs.existsSync(stdoutPath)) fs.writeFileSync(stdoutPath, '', 'utf8')
        if (!fs.existsSync(stderrPath)) fs.writeFileSync(stderrPath, '', 'utf8')

        const stdoutLog = fs.createWriteStream(stdoutPath, { flags: 'a' })
        const stderrLog = fs.createWriteStream(stderrPath, { flags: 'a' })
        child.stdout.pipe(stdoutLog)
        child.stderr.pipe(stderrLog)

        child.stdout.on('data', (chunk) => logger.debug(`backend stdout: ${String(chunk).slice(0, 500)}`))
        child.stderr.on('data', (chunk) => logger.debug(`backend stderr: ${String(chunk).slice(0, 500)}`))
      } catch (e) {
        logger.warn('Failed to create backend log files', e as Error)
      }

      child.on('error', (error) => {
        logger.warn('gist-video backend spawn error', error as Error)
      })

      child.on('exit', (code) => {
        logger.warn(`gist-video backend exited: code=${code}`)
        if (this.child === child) {
          this.child = null
          this.info = null
        }
      })

      try {
        // First import of onnxruntime/numpy can be slow; give it a bit more room in dev.
        await waitForHealth(baseUrl, child, 30_000)
      } catch (e) {
        const stderrTail = safeReadTail(stderrPath, 16 * 1024)
        const stdoutTail = safeReadTail(stdoutPath, 16 * 1024)
        const detail = [
          '后端日志（tail）:',
          stderrTail ? `--- server.stderr.log ---\n${stderrTail}` : '',
          stdoutTail ? `--- server.stdout.log ---\n${stdoutTail}` : ''
        ]
          .filter(Boolean)
          .join('\n')

        if (this.child === child) {
          this.child = null
          this.info = null
        }
        try {
          child.kill()
        } catch {
          // ignore
        }
        const err = e instanceof Error ? e : new Error(String(e))
        err.message = `${err.message}\n${detail}`
        throw err
      }

      const info: BackendInfo = {
        baseUrl,
        wsBase,
        port,
        pid: child.pid ?? -1,
        dataDir,
        backendRoot,
        startedAt: Date.now()
      }
      this.info = info
      await this.applyRuntimeConfigToBackend(info.baseUrl)
      return info
    })()

    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  public async stopBackend(): Promise<void> {
    const child = this.child
    this.child = null
    this.info = null
    if (!child) return

    try {
      child.kill()
    } catch (e) {
      logger.warn('Failed to kill gist-video backend', e as Error)
    }
  }
}

export const gistVideoService = GistVideoService.getInstance()
