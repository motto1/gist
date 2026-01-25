import EmojiAvatar from '@renderer/components/Avatar/EmojiAvatar'
import CustomCollapse from '@renderer/components/CustomCollapse'
import { isMac } from '@renderer/config/constant'
import { UserAvatar } from '@renderer/config/env'
import { useTheme } from '@renderer/context/ThemeProvider'
import useAvatar from '@renderer/hooks/useAvatar'
import { useFullscreen } from '@renderer/hooks/useFullscreen'
import { useMinappPopup } from '@renderer/hooks/useMinappPopup'
import { useMinapps } from '@renderer/hooks/useMinapps'
import useNavBackgroundColor from '@renderer/hooks/useNavBackgroundColor'
import { modelGenerating, useRuntime } from '@renderer/hooks/useRuntime'
import { useSettings } from '@renderer/hooks/useSettings'
import { getSidebarIconLabel, getThemeModeLabel } from '@renderer/i18n/label'
import { ThemeMode } from '@renderer/types'
import { isEmoji } from '@renderer/utils'
import { Avatar, Popover, Tooltip } from 'antd'
import {
  BookOpen,
  Code,
  FileSearch,
  Folder,
  Home,
  Languages,
  LayoutGrid,
  MessageSquare,
  Monitor,
  Moon,
  NotepadText,
  Palette,
  PenTool,
  Scissors,
  Settings,
  Sparkle,
  Sun,
  Users} from 'lucide-react'
import { FC } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import styled from 'styled-components'

import UserPopup from '../Popups/UserPopup'
import { SidebarOpenedMinappTabs, SidebarPinnedApps } from './PinnedMinapps'

const LAST_READER_BOOK_KEY = 'text-reader-last-book-id'
const TEXT_EDITOR_ADVANCED_ROUTES = ['/compress', '/novel-character', '/novel-outline'] as const
const LAST_TEXT_EDITOR_VIEW_KEY = 'text-editor-last-view'
const TEXT_EDITOR_VIEWS = {
  library: 'library',
  reader: 'reader'
} as const

const Sidebar: FC = () => {
  const { hideMinappPopup } = useMinappPopup()
  const { minappShow } = useRuntime()
  const { sidebarIcons } = useSettings()
  const { pinned } = useMinapps()

  const { pathname } = useLocation()
  const navigate = useNavigate()

  const { theme, settedTheme, toggleTheme } = useTheme()
  const avatar = useAvatar()
  const { t } = useTranslation()

  const onEditUser = () => UserPopup.show()

  const backgroundColor = useNavBackgroundColor()

  const showPinnedApps = pinned.length > 0 && sidebarIcons.visible.includes('minapp')

  const to = async (path: string) => {
    await modelGenerating()
    navigate(path)
  }

  const isFullscreen = useFullscreen()

  return (
    <Container
      $isFullscreen={isFullscreen}
      id="app-sidebar"
      style={{ backgroundColor, zIndex: minappShow ? 10000 : 'initial' }}>
      {isEmoji(avatar) ? (
        <EmojiAvatar onClick={onEditUser} className="sidebar-avatar" size={31} fontSize={18}>
          {avatar}
        </EmojiAvatar>
      ) : (
        <AvatarImg src={avatar || UserAvatar} draggable={false} className="nodrag" onClick={onEditUser} />
      )}
      <MainMenusContainer>
        <Menus onClick={hideMinappPopup}>
          <MainMenus />
        </Menus>
        <SidebarOpenedMinappTabs />
        {showPinnedApps && (
          <AppsContainer>
            <Divider />
            <Menus>
              <SidebarPinnedApps />
            </Menus>
          </AppsContainer>
        )}
      </MainMenusContainer>
      <Menus>
        <Tooltip title={getSidebarIconLabel('assistants')} mouseEnterDelay={0.8} placement="right">
          <StyledLink
            onClick={async () => {
              hideMinappPopup()
              await to('/home')
            }}>
            <Icon theme={theme} className={pathname.startsWith('/home') && !minappShow ? 'active' : ''}>
              <MessageSquare size={20} className="icon" />
            </Icon>
          </StyledLink>
        </Tooltip>
        <Tooltip
          title={t('settings.theme.title') + ': ' + getThemeModeLabel(settedTheme)}
          mouseEnterDelay={0.8}
          placement="right">
          <Icon theme={theme} onClick={toggleTheme}>
            {settedTheme === ThemeMode.dark ? (
              <Moon size={20} className="icon" />
            ) : settedTheme === ThemeMode.light ? (
              <Sun size={20} className="icon" />
            ) : (
              <Monitor size={20} className="icon" />
            )}
          </Icon>
        </Tooltip>
        <Tooltip title={t('settings.title')} mouseEnterDelay={0.8} placement="right">
          <StyledLink
            onClick={async () => {
              hideMinappPopup()
              await to('/settings/provider')
            }}>
            <Icon theme={theme} className={pathname.startsWith('/settings') && !minappShow ? 'active' : ''}>
              <Settings size={20} className="icon" />
            </Icon>
          </StyledLink>
        </Tooltip>
      </Menus>
    </Container>
  )
}

const MainMenus: FC = () => {
  const { hideMinappPopup } = useMinappPopup()
  const { pathname } = useLocation()
  const { defaultPaintingProvider } = useSettings()
  const { minappShow } = useRuntime()
  const navigate = useNavigate()
  const { theme } = useTheme()

  const isRoute = (path: string): string => (pathname === path && !minappShow ? 'active' : '')
  const isRoutes = (path: string): string => (pathname.startsWith(path) && !minappShow ? 'active' : '')
  
  const isTextEditorActive = (): string => {
    if (minappShow) return ''
    if (
      pathname.startsWith('/text-editor') ||
      pathname.startsWith('/text-reader') ||
      TEXT_EDITOR_ADVANCED_ROUTES.some((route) => pathname.startsWith(route))
    ) {
      return 'active'
    }
    return ''
  }

  // 保存当前阅读的 bookId
  if (pathname.startsWith('/text-reader/')) {
    const bookId = pathname.replace('/text-reader/', '')
    if (bookId) {
      localStorage.setItem(LAST_READER_BOOK_KEY, bookId)
      localStorage.setItem(LAST_TEXT_EDITOR_VIEW_KEY, TEXT_EDITOR_VIEWS.reader)
    }
  }
  if (pathname.startsWith('/text-editor')) {
    localStorage.setItem(LAST_TEXT_EDITOR_VIEW_KEY, TEXT_EDITOR_VIEWS.library)
  }

  const iconMap = {
    launcher: <Home size={18} className="icon" />,
    assistants: <MessageSquare size={18} className="icon" />,
    agents: <Sparkle size={18} className="icon" />,
    paintings: <Palette size={18} className="icon" />,
    translate: <Languages size={18} className="icon" />,
    minapp: <LayoutGrid size={18} className="icon" />,
    knowledge: <FileSearch size={18} className="icon" />,
    files: <Folder size={18} className="icon" />,
    code_tools: <Code size={18} className="icon" />,
    novel_compress: <Scissors size={18} className="icon" />,
    novel_character: <Users size={18} className="icon" />,
    novel_outline: <BookOpen size={18} className="icon" />,
    notes: <NotepadText size={18} className="icon" />,
    text_editor: <PenTool size={18} className="icon" />
  }

  const pathMap = {
    launcher: '/',
    assistants: '/home',
    agents: '/agents',
    paintings: `/paintings/${defaultPaintingProvider}`,
    translate: '/translate',
    minapp: '/apps',
    knowledge: '/knowledge',
    files: '/files',
    code_tools: '/code',
    novel_compress: '/compress',
    novel_character: '/novel-character',
    novel_outline: '/novel-outline',
    notes: '/notes',
    text_editor: '/text-editor'
  }

  const navigateTo = async (path: string) => {
    hideMinappPopup()
    await modelGenerating()
    navigate(path)
  }

  const textEditorFlyout = <TextEditorFlyout onNavigate={navigateTo} />

  return ['launcher', 'text_editor'].map((icon) => {
    const path = pathMap[icon]
    let isActive: string
    if (icon === 'text_editor') {
      isActive = isTextEditorActive()
    } else {
      isActive = path === '/' ? isRoute(path) : isRoutes(path)
    }

    const link = (
      <StyledLink
        onClick={async () => {
          if (icon === 'text_editor') {
            // 如果当前已在阅读页面，不做任何操作
            if (pathname.startsWith('/text-reader')) {
              return
            }

            const lastView = localStorage.getItem(LAST_TEXT_EDITOR_VIEW_KEY)
            if (lastView === TEXT_EDITOR_VIEWS.library) {
              await navigateTo('/text-editor')
              return
            }

            if (lastView === TEXT_EDITOR_VIEWS.reader) {
              const lastBookId = localStorage.getItem(LAST_READER_BOOK_KEY)
              if (lastBookId) {
                await navigateTo(`/text-reader/${lastBookId}`)
                return
              }
              await navigateTo('/text-editor')
              return
            }

            // 兼容旧逻辑：没有记录时，优先继续阅读
            const lastBookId = localStorage.getItem(LAST_READER_BOOK_KEY)
            if (lastBookId) {
              await navigateTo(`/text-reader/${lastBookId}`)
              return
            }
          }
          await navigateTo(path)
        }}>
        <Icon theme={theme} className={isActive}>
          {iconMap[icon]}
        </Icon>
      </StyledLink>
    )

    if (icon === 'text_editor') {
      return (
        <Popover
          key={icon}
          placement="rightTop"
          trigger="hover"
          mouseEnterDelay={0.8}
          mouseLeaveDelay={0.15}
          content={textEditorFlyout}
          overlayInnerStyle={{ padding: 0, background: 'transparent', boxShadow: 'none' }}>
          {link}
        </Popover>
      )
    }

    return (
      <Tooltip key={icon} title={getSidebarIconLabel(icon)} mouseEnterDelay={0.8} placement="right">
        {link}
      </Tooltip>
    )
  })
}

type TextEditorFlyoutProps = {
  onNavigate: (path: string) => Promise<void>
}

const TextEditorFlyout: FC<TextEditorFlyoutProps> = ({ onNavigate }) => {
  const { t } = useTranslation()
  return (
    <FlyoutContainer onClick={(e) => e.stopPropagation()}>
      <FlyoutSection>
        <FlyoutSectionTitle>{t('textEditor.library', '书库')}</FlyoutSectionTitle>
        <FlyoutItem onClick={() => void onNavigate('/text-editor')}>
          <PenTool size={16} />
          <span>{t('textEditor.library', '书库')}</span>
        </FlyoutItem>
      </FlyoutSection>

      <CustomCollapse
        label={<span>{t('textEditor.advanced', '高级入口')}</span>}
        extra={<span />}
        defaultActiveKey={[]}
        style={{ borderRadius: 10, border: '0.5px solid var(--color-border)', overflow: 'hidden' }}
        styles={{
          header: { padding: '6px 12px', background: 'var(--color-background-soft)' },
          body: { padding: 8, background: 'var(--color-background)' }
        }}>
        <FlyoutList>
          <FlyoutItem onClick={() => void onNavigate('/compress')}>
            <Scissors size={16} />
            <span>{getSidebarIconLabel('novel_compress')}</span>
          </FlyoutItem>
          <FlyoutItem onClick={() => void onNavigate('/novel-character')}>
            <Users size={16} />
            <span>{getSidebarIconLabel('novel_character')}</span>
          </FlyoutItem>
          <FlyoutItem onClick={() => void onNavigate('/novel-outline')}>
            <BookOpen size={16} />
            <span>{getSidebarIconLabel('novel_outline')}</span>
          </FlyoutItem>
        </FlyoutList>
      </CustomCollapse>
    </FlyoutContainer>
  )
}

const FlyoutContainer = styled.div`
  width: 240px;
  padding: 10px;
  border-radius: 12px;
  border: 0.5px solid var(--color-border);
  background: var(--color-background);
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.18);
  -webkit-app-region: no-drag;
`

const FlyoutSection = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
`

const FlyoutSectionTitle = styled.div`
  font-size: 12px;
  color: var(--color-text-3);
  padding: 0 4px;
`

const FlyoutList = styled.div`
  display: flex;
  flex-direction: column;
`

const FlyoutItem = styled.button`
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--color-text-1);
  cursor: pointer;
  text-align: left;
  -webkit-app-region: no-drag;

  &:hover {
    background: var(--color-background-soft);
  }

  span {
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
`

const Container = styled.div<{ $isFullscreen: boolean }>`
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0;
  padding-bottom: 12px;
  width: var(--sidebar-width);
  min-width: var(--sidebar-width);
  height: ${({ $isFullscreen }) => (isMac && !$isFullscreen ? 'calc(100vh - var(--navbar-height))' : '100vh')};
  -webkit-app-region: drag !important;
  margin-top: ${({ $isFullscreen }) => (isMac && !$isFullscreen ? 'env(titlebar-area-height)' : 0)};

  .sidebar-avatar {
    margin-bottom: ${isMac ? '12px' : '12px'};
    margin-top: ${isMac ? '0px' : '2px'};
    -webkit-app-region: none;
  }
`

const AvatarImg = styled(Avatar)`
  width: 31px;
  height: 31px;
  background-color: var(--color-background-soft);
  margin-bottom: ${isMac ? '12px' : '12px'};
  margin-top: ${isMac ? '0px' : '2px'};
  border: none;
  cursor: pointer;
`

const MainMenusContainer = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
`

const Menus = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
`

const Icon = styled.div<{ theme: string }>`
  width: 35px;
  height: 35px;
  display: flex;
  justify-content: center;
  align-items: center;
  border-radius: 50%;
  box-sizing: border-box;
  -webkit-app-region: none;
  border: 0.5px solid transparent;
  &:hover {
    background-color: ${({ theme }) => (theme === 'dark' ? 'var(--color-black)' : 'var(--color-white)')};
    opacity: 0.8;
    cursor: pointer;
    .icon {
      color: var(--color-icon-white);
    }
  }
  &.active {
    background-color: ${({ theme }) => (theme === 'dark' ? 'var(--color-black)' : 'var(--color-white)')};
    border: 0.5px solid var(--color-border);
    .icon {
      color: var(--color-primary);
    }
  }

  @keyframes borderBreath {
    0% {
      opacity: 0.1;
    }
    50% {
      opacity: 1;
    }
    100% {
      opacity: 0.1;
    }
  }

  &.opened-minapp {
    position: relative;
  }
  &.opened-minapp::after {
    content: '';
    position: absolute;
    width: 100%;
    height: 100%;
    top: 0;
    left: 0;
    border-radius: inherit;
    opacity: 0.3;
    border: 0.5px solid var(--color-primary);
  }
`

const StyledLink = styled.div`
  text-decoration: none;
  -webkit-app-region: none;
  &* {
    user-select: none;
  }
`

const AppsContainer = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  overflow-y: auto;
  overflow-x: hidden;
  margin-bottom: 10px;
  -webkit-app-region: none;
  &::-webkit-scrollbar {
    display: none;
  }
`

const Divider = styled.div`
  width: 50%;
  margin: 8px 0;
  border-bottom: 0.5px solid var(--color-border);
`

export default Sidebar
