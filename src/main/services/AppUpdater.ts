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

function toAcceleratedUrl(url: string, prefix: string): string {
  if (!url) {
    return url
  }

  if (!prefix) {
    return url
  }

  if (url.startsWith(prefix)) {
    return url
  }

  return `${prefix}${url}`
}

export default class AppUpdater {
  autoUpdater: _AppUpdater = autoUpdater
  private releaseInfo: UpdateInfo | undefined
  private updateCheckResult: UpdateCheckResult | null = null
  private updateSource: UpdateSource = null
  private manualDownloadUrl: string | null = null
  private manualDownloadFallbackUrl: string | null = null

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
      this.manualDownloadFallbackUrl = null
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
    this.manualDownloadUrl = null
    this.manualDownloadFallbackUrl = null

    try {
      const latestRelease = await this.fetchLatestPublicRelease()
      const latestVersion = normalizeVersion(latestRelease.tag_name)

      if (compareVersions(latestVersion, currentVersion) <= 0) {
        logger.info('no update found on public releases', { currentVersion, latestVersion })
        this.releaseInfo = undefined
        this.updateSource = null
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

      const nativeDownloadUrl = installer.browser_download_url
      const { preferredDownloadUrl, fallbackDownloadUrl } = await this.resolvePreferredDownloadUrl(nativeDownloadUrl)

      const releaseInfo = this.buildPublicReleaseInfo(latestRelease, latestVersion, installer, preferredDownloadUrl)
      this.releaseInfo = releaseInfo
      this.updateSource = 'public-release'
      this.manualDownloadUrl = preferredDownloadUrl
      this.manualDownloadFallbackUrl = fallbackDownloadUrl

      logger.info('update available from public releases', {
        currentVersion,
        latestVersion,
        edition,
        installer: installer.name,
        preferredDownloadUrl,
        fallbackDownloadUrl
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
      this.releaseInfo = undefined
      this.updateSource = null
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
          const downloadUrl = await this.resolveDownloadUrl(this.manualDownloadUrl, this.manualDownloadFallbackUrl)
          await shell.openExternal(downloadUrl)
          return
        }

        app.isQuitting = true
        setImmediate(() => autoUpdater.quitAndInstall())
      })
  }

  private async fetchLatestPublicRelease(): Promise<GithubRelease> {
    const acceleratorPrefixes = configManager.getUpdateAcceleratorPrefixes()
    const fetchers = [
      ...acceleratorPrefixes.map((prefix, index) => ({
        source: `accelerated-${index + 1}`,
        run: () => this.fetchLatestPublicReleaseFromAcceleratedLatestPage(prefix)
      })),
      {
        source: 'github',
        run: () => this.fetchLatestPublicReleaseFromApi(PUBLIC_RELEASE_API, 'github')
      }
    ]

    let lastError: unknown = null

    for (const fetcher of fetchers) {
      try {
        return await fetcher.run()
      } catch (error) {
        lastError = error
        logger.warn('fetch latest release from candidate failed', {
          source: fetcher.source,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Failed to fetch latest release')
  }

  private async fetchLatestPublicReleaseFromAcceleratedLatestPage(prefix: string): Promise<GithubRelease> {
    const acceleratedLatestUrl = toAcceleratedUrl(`https://github.com/${PUBLIC_DOWNLOADS_REPO}/releases/latest`, prefix)
    const abortController = new AbortController()
    const timeout = setTimeout(() => abortController.abort(), 20_000)

    try {
      const response = await fetch(acceleratedLatestUrl, {
        method: 'GET',
        redirect: 'follow',
        signal: abortController.signal,
        headers: {
          'User-Agent': generateUserAgent()
        }
      })

      if (!response.ok) {
        throw new Error(`[accelerated:${prefix}] latest release page request failed: ${response.status} ${response.statusText}`)
      }

      const finalUrl = response.url || acceleratedLatestUrl
      const tagMatch = finalUrl.match(/\/releases\/tag\/([^/?#]+)/)
      if (!tagMatch || !tagMatch[1]) {
        throw new Error(`[accelerated:${prefix}] failed to parse release tag from redirect url`)
      }

      const tagName = decodeURIComponent(tagMatch[1])
      const version = normalizeVersion(tagName)
      if (!version) {
        throw new Error(`[accelerated:${prefix}] invalid release tag`)
      }

      logger.info('fetched latest release from accelerated latest page', { prefix, finalUrl, tagName })

      return {
        tag_name: tagName,
        name: `Release v${version}`,
        body: null,
        published_at: null,
        assets: this.buildAssetsFromReleaseTag(tagName)
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  private buildAssetsFromReleaseTag(tagName: string): GithubReleaseAsset[] {
    const normalizedVersion = normalizeVersion(tagName)
    const normalizedTag = String(tagName || '').trim()
    const releaseTag = normalizedTag.length > 0 ? normalizedTag : `v${normalizedVersion}`

    return ['basic', 'pro'].map((edition) => {
      const name = `gist-${normalizedVersion}-x64-setup-${edition}.exe`
      const nativeUrl = `https://github.com/${PUBLIC_DOWNLOADS_REPO}/releases/download/${releaseTag}/${name}`
      return {
        name,
        browser_download_url: nativeUrl
      }
    })
  }

  private async fetchLatestPublicReleaseFromApi(apiUrl: string, source: string): Promise<GithubRelease> {
    const maxAttempts = 2
    let lastError: unknown = null

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const abortController = new AbortController()
      const timeout = setTimeout(() => abortController.abort(), 20_000)

      try {
        const response = await fetch(apiUrl, {
          method: 'GET',
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': generateUserAgent()
          },
          signal: abortController.signal
        })

        if (!response.ok) {
          throw new Error(`[${source}] releases request failed: ${response.status} ${response.statusText}`)
        }

        const data = (await response.json()) as GithubRelease
        if (!data || !data.tag_name) {
          throw new Error(`[${source}] invalid release payload`)
        }

        logger.info('fetched latest release from source', { source, apiUrl })
        return data
      } catch (error) {
        lastError = error

        if (attempt < maxAttempts) {
          logger.warn('fetch latest release failed, retrying', {
            source,
            apiUrl,
            attempt,
            error: error instanceof Error ? error.message : String(error)
          })
          await new Promise((resolve) => setTimeout(resolve, 1_000))
        }
      } finally {
        clearTimeout(timeout)
      }
    }

    throw lastError instanceof Error ? lastError : new Error(`[${source}] failed to fetch latest release`)
  }

  private async resolvePreferredDownloadUrl(
    nativeDownloadUrl: string
  ): Promise<{ preferredDownloadUrl: string; fallbackDownloadUrl: string | null }> {
    const acceleratorPrefixes = configManager.getUpdateAcceleratorPrefixes()

    for (const prefix of acceleratorPrefixes) {
      const acceleratedUrl = toAcceleratedUrl(nativeDownloadUrl, prefix)
      const isAvailable = await this.canAccessUrl(acceleratedUrl)

      if (isAvailable) {
        return {
          preferredDownloadUrl: acceleratedUrl,
          fallbackDownloadUrl: nativeDownloadUrl
        }
      }

      logger.warn('accelerated download url unavailable during update check', {
        prefix,
        acceleratedUrl,
        nativeDownloadUrl
      })
    }

    return {
      preferredDownloadUrl: nativeDownloadUrl,
      fallbackDownloadUrl: null
    }
  }

  private async resolveDownloadUrl(primaryUrl: string, fallbackUrl: string | null): Promise<string> {
    if (!fallbackUrl || primaryUrl === fallbackUrl) {
      return primaryUrl
    }

    const isPrimaryAvailable = await this.canAccessUrl(primaryUrl)
    if (isPrimaryAvailable) {
      return primaryUrl
    }

    logger.warn('accelerated download url unavailable, fallback to native github url', {
      primaryUrl,
      fallbackUrl
    })
    return fallbackUrl
  }

  private async canAccessUrl(url: string): Promise<boolean> {
    const abortController = new AbortController()
    const timeout = setTimeout(() => abortController.abort(), 8_000)

    try {
      const response = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: abortController.signal,
        headers: {
          'User-Agent': generateUserAgent()
        }
      })

      if (response.ok) {
        return true
      }

      // 某些代理不支持 HEAD（405）或需要浏览器处理鉴权（403），视为可用
      if (response.status === 405 || response.status === 403) {
        return true
      }

      return false
    } catch (error) {
      logger.warn('probe download url failed', {
        url,
        error: error instanceof Error ? error.message : String(error)
      })
      return false
    } finally {
      clearTimeout(timeout)
    }
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

  private buildPublicReleaseInfo(
    release: GithubRelease,
    version: string,
    asset: GithubReleaseAsset,
    downloadUrl: string = asset.browser_download_url
  ): UpdateInfo {
    const releaseDate = release.published_at || new Date().toISOString()
    const releaseNotes = release.body && release.body.trim().length > 0 ? release.body : null

    return {
      version,
      files: [
        {
          url: downloadUrl,
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
