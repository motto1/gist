import fs from 'node:fs'
import path from 'node:path'

import { loggerService } from '@logger'
import { isWin } from '@main/constant'
import { locales } from '@main/utils/locales'
import { generateUserAgent } from '@main/utils/systemInfo'
import { IpcChannel } from '@shared/IpcChannel'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { AppUpdater as _AppUpdater, autoUpdater, Logger, NsisUpdater, UpdateCheckResult, UpdateInfo } from 'electron-updater'

import icon from '../../../build/icon.ico?asset'
import { configManager } from './ConfigManager'
import { windowService } from './WindowService'

const logger = loggerService.withContext('AppUpdater')

const PUBLIC_DOWNLOADS_REPO = 'motto1/gist-downloads'
const PUBLIC_RELEASE_API = `https://api.github.com/repos/${PUBLIC_DOWNLOADS_REPO}/releases/latest`

type AppEdition = 'basic' | 'pro'
type UpdateSource = 'electron-updater' | 'public-release' | null

interface GithubReleaseAsset {
  name: string
  browser_download_url: string
  size?: number
}

interface GithubRelease {
  tag_name: string
  name?: string | null
  body?: string | null
  published_at?: string | null
  assets: GithubReleaseAsset[]
}

function normalizeVersion(version: string): string {
  return String(version || '').trim().replace(/^v/i, '')
}

function compareVersions(left: string, right: string): number {
  const parse = (input: string) => {
    const normalized = normalizeVersion(input)
    const [core, prerelease = ''] = normalized.split('-', 2)
    const nums = core
      .split('.')
      .slice(0, 3)
      .map((value) => Number.parseInt(value, 10) || 0)

    while (nums.length < 3) {
      nums.push(0)
    }

    return { nums, prerelease }
  }

  const a = parse(left)
  const b = parse(right)

  for (let i = 0; i < 3; i += 1) {
    if (a.nums[i] > b.nums[i]) return 1
    if (a.nums[i] < b.nums[i]) return -1
  }

  if (a.prerelease === b.prerelease) return 0
  if (!a.prerelease && b.prerelease) return 1
  if (a.prerelease && !b.prerelease) return -1
  return a.prerelease.localeCompare(b.prerelease)
}

export default class AppUpdater {
  autoUpdater: _AppUpdater = autoUpdater
  private releaseInfo: UpdateInfo | undefined
  private updateCheckResult: UpdateCheckResult | null = null
  private updateSource: UpdateSource = null
  private manualDownloadUrl: string | null = null

  constructor() {
    autoUpdater.logger = logger as Logger
    autoUpdater.forceDevUpdateConfig = !app.isPackaged
    autoUpdater.autoDownload = configManager.getAutoUpdate()
    autoUpdater.autoInstallOnAppQuit = configManager.getAutoUpdate()
    autoUpdater.requestHeaders = {
      ...autoUpdater.requestHeaders,
      'User-Agent': generateUserAgent(),
      'X-Client-Id': configManager.getClientId()
    }

    autoUpdater.on('error', (error) => {
      logger.error('update error', error as Error)
      windowService.getMainWindow()?.webContents.send(IpcChannel.UpdateError, error)
    })

    autoUpdater.on('update-available', (releaseInfo: UpdateInfo) => {
      logger.info('update available', releaseInfo)
      windowService.getMainWindow()?.webContents.send(IpcChannel.UpdateAvailable, releaseInfo)
    })

    // 检测到不需要更新时
    autoUpdater.on('update-not-available', () => {
      windowService.getMainWindow()?.webContents.send(IpcChannel.UpdateNotAvailable)
    })

    // 更新下载进度
    autoUpdater.on('download-progress', (progress) => {
      windowService.getMainWindow()?.webContents.send(IpcChannel.DownloadProgress, progress)
    })

    // 当需要更新的内容下载完成后
    autoUpdater.on('update-downloaded', (releaseInfo: UpdateInfo) => {
      windowService.getMainWindow()?.webContents.send(IpcChannel.UpdateDownloaded, releaseInfo)
      this.releaseInfo = releaseInfo
      this.updateSource = 'electron-updater'
      this.manualDownloadUrl = null
      logger.info('update downloaded', releaseInfo)
    })

    if (isWin) {
      ;(autoUpdater as NsisUpdater).installDirectory = path.dirname(app.getPath('exe'))
    }

    this.autoUpdater = autoUpdater
  }

  public setAutoUpdate(isActive: boolean) {
    autoUpdater.autoDownload = isActive
    autoUpdater.autoInstallOnAppQuit = isActive
  }

  public cancelDownload() {
    if (this.autoUpdater.autoDownload) {
      this.updateCheckResult?.cancellationToken?.cancel()
    }
  }

  public async checkForUpdates() {
    const currentVersion = app.getVersion()

    try {
      const latestRelease = await this.fetchLatestPublicRelease()
      const latestVersion = normalizeVersion(latestRelease.tag_name)

      if (compareVersions(latestVersion, currentVersion) <= 0) {
        logger.info('no update found on public releases', { currentVersion, latestVersion })
        windowService.getMainWindow()?.webContents.send(IpcChannel.UpdateNotAvailable)
        return {
          currentVersion,
          updateInfo: null
        }
      }

      const edition = this.getCurrentEdition()
      const installer = this.pickInstallerAsset(latestRelease.assets, edition)

      if (!installer) {
        throw new Error(`No installer asset found for edition=${edition} in ${PUBLIC_DOWNLOADS_REPO}`)
      }

      const releaseInfo = this.buildPublicReleaseInfo(latestRelease, latestVersion, installer)
      this.releaseInfo = releaseInfo
      this.updateSource = 'public-release'
      this.manualDownloadUrl = installer.browser_download_url

      logger.info('update available from public releases', {
        currentVersion,
        latestVersion,
        edition,
        installer: installer.name
      })

      // 触发“可用更新”通知
      windowService.getMainWindow()?.webContents.send(IpcChannel.UpdateAvailable, releaseInfo)
      // 为了复用现有 UI（顶部按钮/设置页逻辑），直接标记为可安装状态
      windowService.getMainWindow()?.webContents.send(IpcChannel.UpdateDownloaded, releaseInfo)

      return {
        currentVersion,
        updateInfo: releaseInfo
      }
    } catch (error) {
      logger.error('failed to check updates from public releases', error as Error)
      windowService.getMainWindow()?.webContents.send(IpcChannel.UpdateError, error)
      return {
        currentVersion,
        updateInfo: null
      }
    }
  }

  public async showUpdateDialog(mainWindow: BrowserWindow) {
    if (!this.releaseInfo) {
      return
    }
    const locale = locales[configManager.getLanguage()]
    const { update: updateLocale } = locale.translation

    let detail = this.formatReleaseNotes(this.releaseInfo.releaseNotes)
    if (detail === '') {
      detail = updateLocale.noReleaseNotes
    }

    dialog
      .showMessageBox({
        type: 'info',
        title: updateLocale.title,
        icon,
        message: updateLocale.message.replace('{{version}}', this.releaseInfo.version),
        detail,
        buttons: [updateLocale.later, updateLocale.install],
        defaultId: 1,
        cancelId: 0
      })
      .then(async ({ response }) => {
        if (response !== 1) {
          mainWindow.webContents.send(IpcChannel.UpdateDownloadedCancelled)
          return
        }

        if (this.updateSource === 'public-release' && this.manualDownloadUrl) {
          await shell.openExternal(this.manualDownloadUrl)
          return
        }

        app.isQuitting = true
        setImmediate(() => autoUpdater.quitAndInstall())
      })
  }

  private async fetchLatestPublicRelease(): Promise<GithubRelease> {
    const maxAttempts = 2
    let lastError: unknown = null

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const abortController = new AbortController()
      const timeout = setTimeout(() => abortController.abort(), 20_000)

      try {
        const response = await fetch(PUBLIC_RELEASE_API, {
          method: 'GET',
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': generateUserAgent()
          },
          signal: abortController.signal
        })

        if (!response.ok) {
          throw new Error(`GitHub releases request failed: ${response.status} ${response.statusText}`)
        }

        const data = (await response.json()) as GithubRelease
        if (!data || !data.tag_name) {
          throw new Error('Invalid release payload from GitHub')
        }

        return data
      } catch (error) {
        lastError = error

        if (attempt < maxAttempts) {
          logger.warn('fetch latest release failed, retrying', {
            attempt,
            error: error instanceof Error ? error.message : String(error)
          })
          await new Promise((resolve) => setTimeout(resolve, 1_000))
          continue
        }
      } finally {
        clearTimeout(timeout)
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Failed to fetch latest release')
  }

  private getCurrentEdition(): AppEdition {
    try {
      const editionPath = path.join(process.resourcesPath, 'data', 'edition.json')
      if (!fs.existsSync(editionPath)) {
        return 'pro'
      }
      const raw = fs.readFileSync(editionPath, 'utf-8')
      const parsed = JSON.parse(raw)
      return parsed?.edition === 'basic' ? 'basic' : 'pro'
    } catch {
      return 'pro'
    }
  }

  private pickInstallerAsset(assets: GithubReleaseAsset[], edition: AppEdition): GithubReleaseAsset | null {
    if (!Array.isArray(assets) || assets.length === 0) {
      return null
    }

    const expectedSuffix = edition === 'basic' ? '-setup-basic.exe' : '-setup-pro.exe'
    const expected = assets.find((asset) => asset.name.toLowerCase().endsWith(expectedSuffix))
    if (expected) return expected

    const fallback = assets.find((asset) => asset.name.toLowerCase().endsWith('.exe'))
    return fallback || null
  }

  private buildPublicReleaseInfo(release: GithubRelease, version: string, asset: GithubReleaseAsset): UpdateInfo {
    const releaseDate = release.published_at || new Date().toISOString()
    const releaseNotes = release.body && release.body.trim().length > 0 ? release.body : null

    return {
      version,
      files: [
        {
          url: asset.browser_download_url,
          sha512: '',
          size: asset.size
        }
      ],
      path: asset.name,
      sha512: '',
      releaseDate,
      releaseName: release.name || `Release v${version}`,
      releaseNotes
    }
  }

  private formatReleaseNotes(releaseNotes: string | ReleaseNoteInfo[] | null | undefined): string {
    if (!releaseNotes) {
      return ''
    }

    if (typeof releaseNotes === 'string') {
      return releaseNotes
    }

    return releaseNotes.map((note) => note.note).join('\n')
  }
}
interface ReleaseNoteInfo {
  readonly version: string
  readonly note: string | null
}
