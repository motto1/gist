import { loggerService } from '@logger'
import { isWin } from '@main/constant'
import { locales } from '@main/utils/locales'
import { generateUserAgent } from '@main/utils/systemInfo'
import { IpcChannel } from '@shared/IpcChannel'
import { app, BrowserWindow, dialog } from 'electron'
import { AppUpdater as _AppUpdater, autoUpdater, Logger, NsisUpdater, UpdateCheckResult, UpdateInfo } from 'electron-updater'
import path from 'path'

import icon from '../../../build/icon.png?asset'
import { configManager } from './ConfigManager'
import { windowService } from './WindowService'

const logger = loggerService.withContext('AppUpdater')

export default class AppUpdater {
  autoUpdater: _AppUpdater = autoUpdater
  private releaseInfo: UpdateInfo | undefined
  private updateCheckResult: UpdateCheckResult | null = null

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
    // 🔴 禁用更新检查，防止被官方版本覆盖
    logger.info('Update check disabled for custom build.')
    return {
      currentVersion: app.getVersion(),
      updateInfo: null
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
      .then(({ response }) => {
        if (response === 1) {
          app.isQuitting = true
          setImmediate(() => autoUpdater.quitAndInstall())
        } else {
          mainWindow.webContents.send(IpcChannel.UpdateDownloadedCancelled)
        }
      })
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
