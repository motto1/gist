import fs from 'node:fs'
import path from 'node:path'

import { loggerService } from '@logger'
import { isLinux, isMac, isWin } from '@main/constant'
import { locales } from '@main/utils/locales'
import { app, Menu, MenuItemConstructorOptions, nativeImage, nativeTheme, Tray } from 'electron'

import icon from '../../../build/tray_icon.png?asset'
import iconDark from '../../../build/tray_icon_dark.png?asset'
import iconLight from '../../../build/tray_icon_light.png?asset'
import { ConfigKeys, configManager } from './ConfigManager'
import selectionService from './SelectionService'
import { windowService } from './WindowService'

const logger = loggerService.withContext('TrayService')

const toFilePath = (maybePathOrUrl: string): string => {
  try {
    if (maybePathOrUrl.startsWith('file://')) {
      return decodeURIComponent(new URL(maybePathOrUrl).pathname.replace(/^\//, ''))
    }
  } catch {
    // ignore
  }
  return maybePathOrUrl
}

const resolveIconPath = (candidate: string): string | null => {
  const raw = (candidate || '').trim()
  if (!raw) return null

  const asPath = toFilePath(raw)
  if (fs.existsSync(asPath)) return asPath

  const base = path.basename(asPath)
  const fallbacks = [
    path.join(process.cwd(), 'out', 'main', base),
    path.join(process.cwd(), 'build', base),
    path.join(app.getAppPath(), base)
  ]
  for (const p of fallbacks) {
    try {
      if (fs.existsSync(p)) return p
    } catch {
      // ignore
    }
  }

  return null
}

export class TrayService {
  private static instance: TrayService
  private tray: Tray | null = null
  private contextMenu: Menu | null = null

  constructor() {
    this.watchConfigChanges()
    this.updateTray()
    TrayService.instance = this
  }

  public static getInstance() {
    return TrayService.instance
  }

  private createTray() {
    this.destroyTray()

    const iconCandidate = isMac ? (nativeTheme.shouldUseDarkColors ? iconLight : iconDark) : icon
    const iconPath = resolveIconPath(iconCandidate)
    if (!iconPath) {
      logger.warn('Tray icon file missing, skip creating tray', {
        candidate: iconCandidate,
        cwd: process.cwd(),
        appPath: app.getAppPath()
      })
      return
    }

    let tray: Tray
    try {
      tray = new Tray(iconPath)
    } catch (error) {
      logger.warn('Failed to create Tray, skip', error as Error)
      return
    }

    if (isWin) {
      tray.setImage(iconPath)
    } else if (isMac) {
      const image = nativeImage.createFromPath(iconPath)
      const resizedImage = image.resize({ width: 16, height: 16 })
      resizedImage.setTemplateImage(true)
      tray.setImage(resizedImage)
    } else if (isLinux) {
      const image = nativeImage.createFromPath(iconPath)
      const resizedImage = image.resize({ width: 16, height: 16 })
      tray.setImage(resizedImage)
    }

    this.tray = tray

    this.updateContextMenu()

    if (isLinux) {
      this.tray.setContextMenu(this.contextMenu)
    }

    this.tray.setToolTip('封笔')

    this.tray.on('right-click', () => {
      if (this.contextMenu) {
        this.tray?.popUpContextMenu(this.contextMenu)
      }
    })

    this.tray.on('click', () => {
      if (configManager.getEnableQuickAssistant() && configManager.getClickTrayToShowQuickAssistant()) {
        windowService.showMiniWindow()
      } else {
        windowService.showMainWindow()
      }
    })
  }

  private updateContextMenu() {
    const locale = locales[configManager.getLanguage()]
    const { tray: trayLocale, selection: selectionLocale } = locale.translation

    const quickAssistantEnabled = configManager.getEnableQuickAssistant()
    const selectionAssistantEnabled = configManager.getSelectionAssistantEnabled()

    const template = [
      {
        label: trayLocale.show_window,
        click: () => windowService.showMainWindow()
      },
      quickAssistantEnabled && {
        label: trayLocale.show_mini_window,
        click: () => windowService.showMiniWindow()
      },
      (isWin || isMac) && {
        label: selectionLocale.name + (selectionAssistantEnabled ? ' - On' : ' - Off'),
        click: () => {
          if (selectionService) {
            selectionService.toggleEnabled()
            this.updateContextMenu()
          }
        }
      },
      { type: 'separator' },
      {
        label: trayLocale.quit,
        click: () => this.quit()
      }
    ].filter(Boolean) as MenuItemConstructorOptions[]

    this.contextMenu = Menu.buildFromTemplate(template)
  }

  private updateTray() {
    const showTray = configManager.getTray()
    if (showTray) {
      this.createTray()
    } else {
      this.destroyTray()
    }
  }

  private destroyTray() {
    if (this.tray) {
      this.tray.destroy()
      this.tray = null
    }
  }

  private watchConfigChanges() {
    configManager.subscribe(ConfigKeys.Tray, () => this.updateTray())

    configManager.subscribe(ConfigKeys.Language, () => {
      this.updateContextMenu()
    })

    configManager.subscribe(ConfigKeys.EnableQuickAssistant, () => {
      this.updateContextMenu()
    })

    configManager.subscribe(ConfigKeys.SelectionAssistantEnabled, () => {
      this.updateContextMenu()
    })
  }

  private quit() {
    app.quit()
  }
}
