import { loggerService } from '@logger'
import { isMac } from '@renderer/config/constant'
import { DEFAULT_EDITION, normalizeEdition } from '@renderer/config/edition'
import { isLocalAi } from '@renderer/config/env'
import { useTheme } from '@renderer/context/ThemeProvider'
import db from '@renderer/databases'
import i18n from '@renderer/i18n'
import KnowledgeQueue from '@renderer/queue/KnowledgeQueue'
import MemoryService from '@renderer/services/MemoryService'
import { useAppDispatch } from '@renderer/store'
import { useAppSelector } from '@renderer/store'
import { handleSaveData } from '@renderer/store'
import { selectMemoryConfig } from '@renderer/store/memory'
import { setAvatar, setEdition, setFilesPath, setResourcesPath, setUpdateState } from '@renderer/store/runtime'
import { delay, runAsyncFunction } from '@renderer/utils'
import { checkDataLimit } from '@renderer/utils'
import { defaultLanguage } from '@shared/config/constant'
import { IpcChannel } from '@shared/IpcChannel'
import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState } from 'react'

import { useDefaultModel } from './useAssistant'
import useFullScreenNotice from './useFullScreenNotice'
import { useRuntime } from './useRuntime'
import { useNavbarPosition, useSettings } from './useSettings'
import useUpdateHandler from './useUpdateHandler'

const logger = loggerService.withContext('useAppInit')

export function useAppInit() {
  const dispatch = useAppDispatch()
  const {
    proxyUrl,
    proxyBypassRules,
    language,
    windowStyle,
    proxyMode,
    customCss,
    enableDataCollection,
    autoCheckUpdate
  } = useSettings()
  const { isLeftNavbar } = useNavbarPosition()
  const { minappShow } = useRuntime()
  const { setDefaultModel, setQuickModel, setTranslateModel } = useDefaultModel()
  const avatar = useLiveQuery(() => db.settings.get('image://avatar'))
  const { theme } = useTheme()
  const memoryConfig = useAppSelector(selectMemoryConfig)
  const [isProxyInitialized, setIsProxyInitialized] = useState(false)
  const startupUpdateCheckedRef = useRef(false)

  useEffect(() => {
    document.getElementById('spinner')?.remove()
    // eslint-disable-next-line no-restricted-syntax
    console.timeEnd('init')

    // Initialize MemoryService after app is ready
    MemoryService.getInstance()
  }, [])

  useEffect(() => {
    window.api.getDataPathFromArgs().then((dataPath) => {
      if (dataPath) {
        window.navigate('/settings/data', { replace: true })
      }
    })
  }, [])

  useEffect(() => {
    window.electron.ipcRenderer.on(IpcChannel.App_SaveData, async () => {
      await handleSaveData()
    })
  }, [])

  useUpdateHandler()
  useFullScreenNotice()

  useEffect(() => {
    avatar?.value && dispatch(setAvatar(avatar.value))
  }, [avatar, dispatch])

  useEffect(() => {
    runAsyncFunction(async () => {
      try {
        if (!autoCheckUpdate || !isProxyInitialized || startupUpdateCheckedRef.current) {
          return
        }

        const { isPackaged } = await window.api.getAppInfo()
        if (!isPackaged) {
          return
        }

        startupUpdateCheckedRef.current = true

        // 启动时自动检查更新：发现新版本就主动弹窗提示
        await delay(2)
        const { updateInfo } = await window.api.checkForUpdate()
        dispatch(setUpdateState({ info: updateInfo }))

        if (updateInfo) {
          // 等待状态事件更新后再弹窗，避免竞态
          await delay(0.2)
          await window.api.showUpdateDialog()
        }
      } catch (error) {
        logger.error('Auto update check on launch failed', error as Error)

        const defaultMessage = i18n.t('settings.about.updateError')
        const errorMessage = error instanceof Error ? error.message : defaultMessage

        if (window.modal?.info) {
          window.modal.info({
            title: defaultMessage,
            content: errorMessage,
            icon: null
          })
        } else {
          window.toast?.error(errorMessage)
        }
      }
    })
  }, [autoCheckUpdate, dispatch, isProxyInitialized])

  useEffect(() => {
    let cancelled = false

    runAsyncFunction(async () => {
      try {
        if (proxyMode === 'system') {
          await window.api.setProxy('system', undefined)
        } else if (proxyMode === 'custom') {
          if (proxyUrl) {
            await window.api.setProxy(proxyUrl, proxyBypassRules)
          }
        } else {
          // set proxy to none for direct mode
          await window.api.setProxy('', undefined)
        }
      } catch (error) {
        logger.error('Failed to apply proxy settings', error as Error)
      } finally {
        if (!cancelled) {
          setIsProxyInitialized(true)
        }
      }
    })

    return () => {
      cancelled = true
    }
  }, [proxyUrl, proxyMode, proxyBypassRules])

  useEffect(() => {
    i18n.changeLanguage(language || navigator.language || defaultLanguage)
  }, [language])

  useEffect(() => {
    const isMacTransparentWindow = windowStyle === 'transparent' && isMac

    if (minappShow && isLeftNavbar) {
      window.root.style.background = isMacTransparentWindow ? 'var(--color-background)' : 'var(--navbar-background)'
      return
    }

    window.root.style.background = isMacTransparentWindow ? 'var(--navbar-background-mac)' : 'var(--navbar-background)'
  }, [windowStyle, minappShow, theme, isLeftNavbar])

  useEffect(() => {
    if (isLocalAi) {
      const model = JSON.parse(import.meta.env.VITE_RENDERER_INTEGRATED_MODEL)
      setDefaultModel(model)
      setQuickModel(model)
      setTranslateModel(model)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    // set files path
    runAsyncFunction(async () => {
      const info = await window.api.getAppInfo()
      dispatch(setFilesPath(info.filesPath))
      dispatch(setResourcesPath(info.resourcesPath))
      try {
        const editionPath = await window.api.path.join(info.resourcesPath, 'data', 'edition.json')
        const raw = await window.api.fs.read(editionPath, 'utf-8')
        const parsed = JSON.parse(raw)
        dispatch(setEdition(normalizeEdition(parsed?.edition)))
      } catch (error) {
        logger.warn('Failed to load edition config, fallback to default', error as Error)
        dispatch(setEdition(DEFAULT_EDITION))
      }
    })
  }, [dispatch])

  useEffect(() => {
    KnowledgeQueue.checkAllBases()
  }, [])

  useEffect(() => {
    let customCssElement = document.getElementById('user-defined-custom-css') as HTMLStyleElement
    if (customCssElement) {
      customCssElement.remove()
    }

    if (customCss) {
      customCssElement = document.createElement('style')
      customCssElement.id = 'user-defined-custom-css'
      customCssElement.textContent = customCss
      document.head.appendChild(customCssElement)
    }
  }, [customCss])

  useEffect(() => {
    // TODO: init data collection
  }, [enableDataCollection])

  // Update memory service configuration when it changes
  useEffect(() => {
    const memoryService = MemoryService.getInstance()
    memoryService.updateConfig().catch((error) => {
      logger.error('Failed to update memory config:', error)
    })
  }, [memoryConfig])

  useEffect(() => {
    checkDataLimit()
  }, [])
}
