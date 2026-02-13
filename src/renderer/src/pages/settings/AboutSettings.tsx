import { DownOutlined, GithubOutlined } from '@ant-design/icons'
import Sortable from '@renderer/components/dnd/Sortable'
import IndicatorLight from '@renderer/components/IndicatorLight'
import { HStack } from '@renderer/components/Layout'
import { APP_NAME, AppLogo } from '@renderer/config/env'
import { useTheme } from '@renderer/context/ThemeProvider'
import { useMinappPopup } from '@renderer/hooks/useMinappPopup'
import { useRuntime } from '@renderer/hooks/useRuntime'
import { useSettings } from '@renderer/hooks/useSettings'
import { handleSaveData, useAppDispatch } from '@renderer/store'
import { setUpdateState } from '@renderer/store/runtime'
import { ThemeMode } from '@renderer/types'
import { runAsyncFunction } from '@renderer/utils'
import { UpgradeChannel } from '@shared/config/constant'
import { Avatar, Button, Dropdown, Input, Progress, Radio, Row, Switch, Tag, Tooltip } from 'antd'
import { debounce } from 'lodash'
import { BadgeQuestionMark, Bug, FileCheck, Globe, GripVertical, Lock, Mail, Rss, X } from 'lucide-react'
import { FC, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Markdown from 'react-markdown'
import { Link } from 'react-router-dom'
import styled, { createGlobalStyle } from 'styled-components'

import { SettingContainer, SettingDivider, SettingGroup, SettingRow, SettingTitle } from '.'

const UPDATE_ACCELERATOR_PREFIXES_CONFIG_KEY = 'updateAcceleratorPrefixes'
const UPDATE_ACCELERATOR_ORDER_CONFIG_KEY = 'updateAcceleratorOrder'
const UPDATE_ACCELERATOR_NATIVE_SOURCE = 'native'
const DEFAULT_UPDATE_ACCELERATOR_PREFIXES = ['https://gh.felicity.ac.cn/', 'https://ghfast.top/']
const DEFAULT_UPDATE_ACCELERATOR_ORDER = [...DEFAULT_UPDATE_ACCELERATOR_PREFIXES, UPDATE_ACCELERATOR_NATIVE_SOURCE]

const normalizeUpdateAcceleratorPrefix = (prefix: string): string | null => {
  const normalized = String(prefix || '').trim()
  if (!normalized) {
    return null
  }

  if (!/^https?:\/\//i.test(normalized)) {
    return null
  }

  return normalized.endsWith('/') ? normalized : `${normalized}/`
}

const normalizeUpdateAcceleratorPrefixes = (prefixes: string[]): string[] => {
  const normalized = prefixes
    .map((item) => normalizeUpdateAcceleratorPrefix(item))
    .filter((item): item is string => Boolean(item))

  return Array.from(new Set(normalized))
}

const normalizeUpdateAcceleratorOrder = (order: string[]): string[] => {
  const seen = new Set<string>()
  const result: string[] = []

  for (const item of order) {
    const raw = String(item || '').trim()
    if (!raw) continue

    if (raw === UPDATE_ACCELERATOR_NATIVE_SOURCE) {
      if (seen.has(raw)) continue
      seen.add(raw)
      result.push(raw)
      continue
    }

    const normalizedPrefix = normalizeUpdateAcceleratorPrefix(raw)
    if (!normalizedPrefix) continue

    if (seen.has(normalizedPrefix)) continue
    seen.add(normalizedPrefix)
    result.push(normalizedPrefix)
  }

  if (!seen.has(UPDATE_ACCELERATOR_NATIVE_SOURCE)) {
    result.push(UPDATE_ACCELERATOR_NATIVE_SOURCE)
  }

  return result
}

const UpdateAcceleratorDropdownGlobalStyle = createGlobalStyle`
  .update-accelerator-dropdown-overlay {
    padding: 0 !important;
    background: transparent !important;
    box-shadow: none !important;
  }

  .update-accelerator-dropdown-overlay .ant-dropdown-menu {
    padding: 0 !important;
    background: transparent !important;
    box-shadow: none !important;
  }
`

const AboutSettings: FC = () => {
  const [version, setVersion] = useState('')
  const [isPortable, setIsPortable] = useState(false)
  const [updateAcceleratorOrder, setUpdateAcceleratorOrder] = useState<string[]>(DEFAULT_UPDATE_ACCELERATOR_ORDER)
  const [newUpdateAcceleratorPrefix, setNewUpdateAcceleratorPrefix] = useState('')
  const [isUpdateAcceleratorDropdownOpen, setIsUpdateAcceleratorDropdownOpen] = useState(false)
  const [isUpdateAcceleratorDragging, setIsUpdateAcceleratorDragging] = useState(false)
  const { t } = useTranslation()
  const { autoCheckUpdate, setAutoCheckUpdate, testPlan, setTestPlan, testChannel, setTestChannel } = useSettings()
  const { theme } = useTheme()
  const dispatch = useAppDispatch()
  const { update } = useRuntime()
  const { openMinapp } = useMinappPopup()

  const onCheckUpdate = debounce(
    async () => {
      if (update.checking || update.downloading) {
        return
      }

      if (update.downloaded) {
        await handleSaveData()
        window.api.showUpdateDialog()
        return
      }

      dispatch(setUpdateState({ checking: true }))

      try {
        await window.api.checkForUpdate()
      } catch (error) {
        window.toast.error(t('settings.about.updateError'))
      }

      dispatch(setUpdateState({ checking: false }))
    },
    2000,
    { leading: true, trailing: false }
  )

  const onOpenWebsite = (url: string) => {
    window.api.openWebsite(url)
  }

  const mailto = async () => {
    const email = 'support@read-no-more.app'
    const subject = `${APP_NAME} Feedback`
    const version = (await window.api.getAppInfo()).version
    const platform = window.electron.process.platform
    const url = `mailto:${email}?subject=${subject}&body=%0A%0AVersion: ${version} | Platform: ${platform}`
    onOpenWebsite(url)
  }

  const debug = async () => {
    await window.api.devTools.toggle()
  }

  const showLicense = async () => {
    const { appPath } = await window.api.getAppInfo()
    openMinapp({
      id: 'read-no-more-license',
      name: t('settings.about.license.title'),
      url: `file://${appPath}/resources/read-no-more/license.html`,
      logo: AppLogo
    })
  }

  const showReleases = async () => {
    const { appPath } = await window.api.getAppInfo()
    openMinapp({
      id: 'read-no-more-releases',
      name: t('settings.about.releases.title'),
      url: `file://${appPath}/resources/read-no-more/releases.html?theme=${theme === ThemeMode.dark ? 'dark' : 'light'}`,
      logo: AppLogo
    })
  }

  const currentChannelByVersion =
    [
      { pattern: `-${UpgradeChannel.BETA}.`, channel: UpgradeChannel.BETA },
      { pattern: `-${UpgradeChannel.RC}.`, channel: UpgradeChannel.RC }
    ].find(({ pattern }) => version.includes(pattern))?.channel || UpgradeChannel.LATEST

  const handleTestChannelChange = async (value: UpgradeChannel) => {
    if (testPlan && currentChannelByVersion !== UpgradeChannel.LATEST && value !== currentChannelByVersion) {
      window.toast.warning(t('settings.general.test_plan.version_channel_not_match'))
    }
    setTestChannel(value)
    // Clear update info when switching upgrade channel
    dispatch(
      setUpdateState({
        available: false,
        info: null,
        downloaded: false,
        checking: false,
        downloading: false,
        downloadProgress: 0
      })
    )
  }

  // Get available test version options based on current version
  const getAvailableTestChannels = () => {
    return [
      {
        tooltip: t('settings.general.test_plan.rc_version_tooltip'),
        label: t('settings.general.test_plan.rc_version'),
        value: UpgradeChannel.RC
      },
      {
        tooltip: t('settings.general.test_plan.beta_version_tooltip'),
        label: t('settings.general.test_plan.beta_version'),
        value: UpgradeChannel.BETA
      }
    ]
  }

  const handleSetTestPlan = (value: boolean) => {
    setTestPlan(value)
    dispatch(
      setUpdateState({
        available: false,
        info: null,
        downloaded: false,
        checking: false,
        downloading: false,
        downloadProgress: 0
      })
    )

    if (value === true) {
      setTestChannel(getTestChannel())
    }
  }

  const getTestChannel = () => {
    if (testChannel === UpgradeChannel.LATEST) {
      return UpgradeChannel.RC
    }
    return testChannel
  }

  const loadUpdateAcceleratorPrefixes = useCallback(async () => {
    try {
      const rawOrder = await window.api.config.get(UPDATE_ACCELERATOR_ORDER_CONFIG_KEY)
      const orderList = Array.isArray(rawOrder)
        ? rawOrder.map((item) => String(item))
        : typeof rawOrder === 'string'
          ? [rawOrder]
          : []

      if (orderList.length > 0) {
        const normalizedOrder = normalizeUpdateAcceleratorOrder(orderList)
        setUpdateAcceleratorOrder(normalizedOrder)
        setNewUpdateAcceleratorPrefix('')
        return
      }

      const rawPrefixes = await window.api.config.get(UPDATE_ACCELERATOR_PREFIXES_CONFIG_KEY)
      const prefixList = Array.isArray(rawPrefixes)
        ? rawPrefixes.map((item) => String(item))
        : typeof rawPrefixes === 'string'
          ? [rawPrefixes]
          : []

      const normalizedPrefixes = normalizeUpdateAcceleratorPrefixes(prefixList)
      const nextOrder = normalizedPrefixes.length > 0
        ? normalizeUpdateAcceleratorOrder([...normalizedPrefixes, UPDATE_ACCELERATOR_NATIVE_SOURCE])
        : DEFAULT_UPDATE_ACCELERATOR_ORDER

      setUpdateAcceleratorOrder(nextOrder)
      setNewUpdateAcceleratorPrefix('')
    } catch (error) {
      window.toast.error(t('settings.general.update_accelerator.load_error'))
    }
  }, [t])

  const persistUpdateAcceleratorOrder = async (order: string[], showSuccess = false) => {
    const normalizedOrder = normalizeUpdateAcceleratorOrder(order)

    const prefixesOnly = normalizedOrder.filter((item) => item !== UPDATE_ACCELERATOR_NATIVE_SOURCE)

    await window.api.config.set(UPDATE_ACCELERATOR_ORDER_CONFIG_KEY, normalizedOrder)
    await window.api.config.set(UPDATE_ACCELERATOR_PREFIXES_CONFIG_KEY, prefixesOnly)

    setUpdateAcceleratorOrder(normalizedOrder)

    if (showSuccess) {
      window.toast.success(t('settings.general.update_accelerator.saved'))
    }

    return true
  }

  const addUpdateAcceleratorPrefix = async (rawPrefix: string = newUpdateAcceleratorPrefix) => {
    const normalized = normalizeUpdateAcceleratorPrefix(rawPrefix)
    if (!normalized) {
      window.toast.warning(t('settings.general.update_accelerator.invalid'))
      return
    }

    if (updateAcceleratorOrder.includes(normalized)) {
      window.toast.warning(t('settings.general.update_accelerator.duplicate'))
      return
    }

    const nativeIndex = updateAcceleratorOrder.indexOf(UPDATE_ACCELERATOR_NATIVE_SOURCE)
    const next = [...updateAcceleratorOrder]

    if (nativeIndex >= 0) {
      next.splice(nativeIndex, 0, normalized)
    } else {
      next.push(normalized)
      next.push(UPDATE_ACCELERATOR_NATIVE_SOURCE)
    }

    await persistUpdateAcceleratorOrder(next)
    setNewUpdateAcceleratorPrefix('')
  }

  const removeUpdateAcceleratorPrefix = async (prefix: string) => {
    if (prefix === UPDATE_ACCELERATOR_NATIVE_SOURCE) {
      return
    }

    const next = updateAcceleratorOrder.filter((item) => item !== prefix)
    await persistUpdateAcceleratorOrder(next)
  }

  const sortUpdateAcceleratorOrder = async ({ oldIndex, newIndex }: { oldIndex: number; newIndex: number }) => {
    if (oldIndex === newIndex) {
      return
    }

    const next = [...updateAcceleratorOrder]
    const [moved] = next.splice(oldIndex, 1)
    if (!moved) {
      return
    }

    next.splice(newIndex, 0, moved)
    await persistUpdateAcceleratorOrder(next)
  }

  const resetUpdateAcceleratorPrefixes = async () => {
    await persistUpdateAcceleratorOrder(DEFAULT_UPDATE_ACCELERATOR_ORDER, true)
    setNewUpdateAcceleratorPrefix('')
  }

  useEffect(() => {
    runAsyncFunction(async () => {
      const appInfo = await window.api.getAppInfo()
      setVersion(appInfo.version)
      setIsPortable(appInfo.isPortable)
      await loadUpdateAcceleratorPrefixes()
    })
  }, [loadUpdateAcceleratorPrefixes])

  const onOpenDocs = () => {
    window.api.openWebsite('https://github.com/motto1/gist-downloads')
  }

  return (
    <SettingContainer theme={theme}>
      <UpdateAcceleratorDropdownGlobalStyle />
      <SettingGroup theme={theme}>
        <SettingTitle>
          {t('settings.about.title')}
          <HStack alignItems="center">
            <Link to="https://github.com/motto1/gist-downloads">
              <GithubOutlined style={{ marginRight: 4, color: 'var(--color-text)', fontSize: 20 }} />
            </Link>
          </HStack>
        </SettingTitle>
        <SettingDivider />
        <AboutHeader>
          <Row align="middle">
            <AvatarWrapper onClick={() => onOpenWebsite('https://github.com/motto1/gist-downloads')}>
              {update.downloadProgress > 0 && (
                <ProgressCircle
                  type="circle"
                  size={84}
                  percent={update.downloadProgress}
                  showInfo={false}
                  strokeLinecap="butt"
                  strokeColor="#67ad5b"
                />
              )}
              <Avatar src={AppLogo} size={80} style={{ minHeight: 80 }} />
            </AvatarWrapper>
            <VersionWrapper>
              <Title>{APP_NAME}</Title>
              <Description>{t('settings.about.description')}</Description>
              <Tag
                onClick={() => onOpenWebsite('https://github.com/motto1/gist-downloads/releases')}
                color="cyan"
                style={{ marginTop: 8, cursor: 'pointer' }}>
                v{version}
              </Tag>
            </VersionWrapper>
          </Row>
          {!isPortable && (
            <CheckUpdateButton
              onClick={onCheckUpdate}
              loading={update.checking}
              disabled={update.downloading || update.checking}>
              {update.downloading
                ? t('settings.about.downloading')
                : update.available
                  ? t('settings.about.checkUpdate.available')
                  : t('settings.about.checkUpdate.label')}
            </CheckUpdateButton>
          )}
        </AboutHeader>
        {!isPortable && (
          <>
            <SettingDivider />
            <SettingRow>
              <SettingRowTitle>{t('settings.general.auto_check_update.title')}</SettingRowTitle>
              <Switch value={autoCheckUpdate} onChange={(v) => setAutoCheckUpdate(v)} />
            </SettingRow>
            <SettingDivider />
            <SettingRow>
              <SettingRowTitle>{t('settings.general.test_plan.title')}</SettingRowTitle>
              <Tooltip title={t('settings.general.test_plan.tooltip')} trigger={['hover', 'focus']}>
                <Switch value={testPlan} onChange={(v) => handleSetTestPlan(v)} />
              </Tooltip>
            </SettingRow>
            {testPlan && (
              <>
                <SettingDivider />
                <SettingRow>
                  <SettingRowTitle>{t('settings.general.test_plan.version_options')}</SettingRowTitle>
                  <Radio.Group
                    size="small"
                    buttonStyle="solid"
                    value={getTestChannel()}
                    onChange={(e) => handleTestChannelChange(e.target.value)}>
                    {getAvailableTestChannels().map((option) => (
                      <Tooltip key={option.value} title={option.tooltip}>
                        <Radio.Button value={option.value}>{option.label}</Radio.Button>
                      </Tooltip>
                    ))}
                  </Radio.Group>
                </SettingRow>
              </>
            )}
            <SettingDivider />
            <UpdateAcceleratorSection>
              <SettingRowTitle>{t('settings.general.update_accelerator.title')}</SettingRowTitle>
              <UpdateAcceleratorDescription>{t('settings.general.update_accelerator.description')}</UpdateAcceleratorDescription>
              <Dropdown
                trigger={['click']}
                open={isUpdateAcceleratorDropdownOpen}
                overlayClassName="update-accelerator-dropdown-overlay"
                overlayStyle={{
                  padding: 0,
                  background: 'transparent',
                  boxShadow: 'none',
                  width: 560,
                  maxWidth: 'calc(100vw - 40px)'
                }}
                onOpenChange={(nextOpen, info) => {
                  if (!nextOpen) {
                    if (isUpdateAcceleratorDragging) {
                      return
                    }

                    // dropdown 内部交互不应自动关闭
                    if (info.source === 'menu') {
                      return
                    }
                  }

                  setIsUpdateAcceleratorDropdownOpen(nextOpen)
                }}
                overlay={
                  <UpdateAcceleratorDropdown data-allow-dnd>
                    {updateAcceleratorOrder.length > 0 ? (
                      <Sortable<string>
                        items={updateAcceleratorOrder}
                        itemKey={(item) => item}
                        onSortEnd={sortUpdateAcceleratorOrder}
                        onDragStart={() => setIsUpdateAcceleratorDragging(true)}
                        onDragEnd={() => setIsUpdateAcceleratorDragging(false)}
                        onDragCancel={() => setIsUpdateAcceleratorDragging(false)}
                        layout="list"
                        gap="8px"
                        listStyle={{ width: '100%', alignItems: 'stretch' }}
                        useDragOverlay
                        showGhost
                        renderItem={(prefix) => (
                          <UpdateAcceleratorItem>
                            <UpdateAcceleratorDrag>
                              <GripVertical size={14} />
                            </UpdateAcceleratorDrag>
                            <UpdateAcceleratorValue>
                              {prefix === UPDATE_ACCELERATOR_NATIVE_SOURCE ? 'https://github.com/' : prefix}
                            </UpdateAcceleratorValue>
                            {prefix === UPDATE_ACCELERATOR_NATIVE_SOURCE ? (
                              <UpdateAcceleratorLocked data-no-dnd>
                                <Lock size={14} />
                              </UpdateAcceleratorLocked>
                            ) : (
                              <UpdateAcceleratorRemoveButton
                                data-no-dnd
                                size="small"
                                type="text"
                                danger
                                icon={<X size={14} />}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  runAsyncFunction(async () => {
                                    await removeUpdateAcceleratorPrefix(prefix)
                                  })
                                }}
                              />
                            )}
                          </UpdateAcceleratorItem>
                        )}
                      />
                    ) : (
                      <UpdateAcceleratorEmpty>{t('settings.general.update_accelerator.list_empty')}</UpdateAcceleratorEmpty>
                    )}

                    <UpdateAcceleratorAddRow>
                      <Input
                        data-no-dnd
                        value={newUpdateAcceleratorPrefix}
                        onChange={(event) => setNewUpdateAcceleratorPrefix(event.target.value)}
                        placeholder={t('settings.general.update_accelerator.add_placeholder')}
                        onPressEnter={() => {
                          runAsyncFunction(async () => {
                            await addUpdateAcceleratorPrefix()
                          })
                        }}
                      />
                      <Button
                        data-no-dnd
                        size="small"
                        type="primary"
                        onClick={() => {
                          runAsyncFunction(async () => {
                            await addUpdateAcceleratorPrefix()
                          })
                        }}>
                        {t('settings.general.update_accelerator.add')}
                      </Button>
                    </UpdateAcceleratorAddRow>
                  </UpdateAcceleratorDropdown>
                }>
                <UpdateAcceleratorTrigger>
                  <UpdateAcceleratorTriggerText>
                    {updateAcceleratorOrder.length > 0
                      ? updateAcceleratorOrder
                          .map((item) => (item === UPDATE_ACCELERATOR_NATIVE_SOURCE ? 'github.com' : item))
                          .join('  ·  ')
                      : t('settings.general.update_accelerator.list_empty')}
                  </UpdateAcceleratorTriggerText>
                  <DownOutlined />
                </UpdateAcceleratorTrigger>
              </Dropdown>
              <UpdateAcceleratorActions>
                <Button size="small" onClick={resetUpdateAcceleratorPrefixes}>
                  {t('settings.general.update_accelerator.reset')}
                </Button>
              </UpdateAcceleratorActions>
            </UpdateAcceleratorSection>
          </>
        )}
      </SettingGroup>
      {update.info && update.available && (
        <SettingGroup theme={theme}>
          <SettingRow>
            <SettingRowTitle>
              {t('settings.about.updateAvailable', { version: update.info.version })}
              <IndicatorLight color="green" />
            </SettingRowTitle>
          </SettingRow>
          <UpdateNotesWrapper>
            <Markdown>
              {typeof update.info.releaseNotes === 'string'
                ? update.info.releaseNotes.replace(/\n/g, '\n\n')
                : update.info.releaseNotes?.map((note) => note.note).join('\n')}
            </Markdown>
          </UpdateNotesWrapper>
        </SettingGroup>
      )}
      <SettingGroup theme={theme}>
        <SettingRow>
          <SettingRowTitle>
            <BadgeQuestionMark size={18} />
            {t('docs.title')}
          </SettingRowTitle>
          <Button onClick={onOpenDocs}>{t('settings.about.website.button')}</Button>
        </SettingRow>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>
            <Rss size={18} />
            {t('settings.about.releases.title')}
          </SettingRowTitle>
          <Button onClick={showReleases}>{t('settings.about.releases.button')}</Button>
        </SettingRow>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>
            <Globe size={18} />
            {t('settings.about.website.title')}
          </SettingRowTitle>
          <Button onClick={() => onOpenWebsite('https://github.com/motto1/gist-downloads')}>
            {t('settings.about.website.button')}
          </Button>
        </SettingRow>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>
            <FileCheck size={18} />
            {t('settings.about.license.title')}
          </SettingRowTitle>
          <Button onClick={showLicense}>{t('settings.about.license.button')}</Button>
        </SettingRow>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>
            <Mail size={18} />
            {t('settings.about.contact.title')}
          </SettingRowTitle>
          <Button onClick={mailto}>{t('settings.about.contact.button')}</Button>
        </SettingRow>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>
            <FileCheck size={18} />
            {t('settings.about.logger.title')}
          </SettingRowTitle>
          <Button onClick={async () => {
            const currentLevel = await window.api.getLogLevel()
            const newLevel = currentLevel === 'silly' ? 'info' : 'silly'
            await window.api.setLogLevel(newLevel)
            window.toast.success(
              newLevel === 'silly' 
                ? t('settings.about.logger.enabled') 
                : t('settings.about.logger.disabled')
            )
          }}>
            {t('settings.about.logger.button')}
          </Button>
        </SettingRow>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>
            <Bug size={18} />
            {t('settings.about.debug.title')}
          </SettingRowTitle>
          <Button onClick={debug}>{t('settings.about.debug.open')}</Button>
        </SettingRow>
      </SettingGroup>
    </SettingContainer>
  )
}

const AboutHeader = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 5px 0;
`

const VersionWrapper = styled.div`
  display: flex;
  flex-direction: column;
  min-height: 80px;
  justify-content: center;
  align-items: flex-start;
`

const Title = styled.div`
  font-size: 20px;
  font-weight: bold;
  color: var(--color-text-1);
  margin-bottom: 5px;
`

const Description = styled.div`
  font-size: 14px;
  color: var(--color-text-2);
  text-align: center;
`

const CheckUpdateButton = styled(Button)``

const AvatarWrapper = styled.div`
  position: relative;
  cursor: pointer;
  margin-right: 15px;
`

const ProgressCircle = styled(Progress)`
  position: absolute;
  top: -2px;
  left: -2px;
`

export const SettingRowTitle = styled.div`
  font-size: 14px;
  line-height: 18px;
  color: var(--color-text-1);
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  .anticon {
    font-size: 16px;
    color: var(--color-text-1);
  }
`

const UpdateAcceleratorSection = styled.div`
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
`

const UpdateAcceleratorDescription = styled.div`
  color: var(--color-text-2);
  font-size: 12px;
`

const UpdateAcceleratorTrigger = styled.div`
  width: 100%;
  min-height: 36px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 8px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--color-text-1);
  background: var(--color-background);
  cursor: pointer;

  &:hover {
    border-color: var(--color-primary);
  }
`

const UpdateAcceleratorTriggerText = styled.div`
  flex: 1;
  min-width: 0;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-2);
  font-size: 13px;
`

const UpdateAcceleratorDropdown = styled.div`
  width: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px;
  background: var(--color-background);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  box-shadow: var(--shadow-2, 0 8px 24px rgba(0, 0, 0, 0.12));
`

const UpdateAcceleratorEmpty = styled.div`
  color: var(--color-text-3);
  font-size: 12px;
  padding: 6px 2px;
`


const UpdateAcceleratorAddRow = styled.div`
  display: flex;
  gap: 8px;
  align-items: center;
`

const UpdateAcceleratorItem = styled.div`
  width: 100%;
  min-height: 40px;
  display: flex;
  align-items: center;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background-soft);
  overflow: hidden;
`

const UpdateAcceleratorDrag = styled.div`
  width: 34px;
  align-self: stretch;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-3);
  border-right: 1px dashed var(--color-border);
  cursor: grab;

  &:active {
    cursor: grabbing;
  }
`

const UpdateAcceleratorValue = styled.div`
  flex: 1;
  min-width: 0;
  padding: 0 10px;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-1);
  font-size: 13px;
`

const UpdateAcceleratorLocked = styled.div`
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-3);
`

const UpdateAcceleratorRemoveButton = styled(Button)`
  flex: none;
  margin-right: 4px;
`

const UpdateAcceleratorActions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
`

const UpdateNotesWrapper = styled.div`
  padding: 12px 0;
  margin: 8px 0;
  background-color: var(--color-bg-2);
  border-radius: 6px;

  p {
    margin: 0;
    color: var(--color-text-2);
    font-size: 14px;
  }
`

export default AboutSettings
