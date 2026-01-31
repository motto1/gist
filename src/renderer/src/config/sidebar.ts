import { SidebarIcon } from '@renderer/types'

/**
 * 默认显示的侧边栏图标
 * 这些图标会在侧边栏中默认显示
 */
export const DEFAULT_SIDEBAR_ICONS: SidebarIcon[] = ['assistants', 'novel_compress', 'novel_character', 'tts']

/**
 * 必须显示的侧边栏图标（不能被隐藏）
 * 这些图标必须始终在侧边栏中可见
 * 抽取为参数方便未来扩展
 */
export const REQUIRED_SIDEBAR_ICONS: SidebarIcon[] = ['assistants', 'novel_compress', 'novel_character', 'tts']

/**
 * 隐藏的侧边栏图标
 * 这些图标默认不会在侧边栏中显示
 */
export const HIDDEN_SIDEBAR_ICONS: SidebarIcon[] = [
  'agents',
  'paintings',
  'translate',
  'minapp',
  'knowledge',
  'files',
  'code_tools',
  'notes'
]
