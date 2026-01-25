import crypto from 'node:crypto'

import { loggerService } from '@logger'
import { readTextFileWithAutoEncoding } from '@main/utils/file'
import { clamp, splitTextIntoStringChunks } from '@main/utils/novel-utils'
import { IpcChannel } from '@shared/IpcChannel'
import type {
  CompressionLogEntry,
  NovelOutlineResult,
  OutlineChunkResult,
  OutlineStructure
} from '@shared/types'
import type { Model, Provider } from '@types'
import type { ModelMessage } from 'ai'
import { BrowserWindow, ipcMain } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { z } from 'zod'

import {
  clearAllProviders,
  createAndRegisterProvider,
  type ProviderId
} from '../../../packages/aiCore/src/core/providers'
import { createExecutor } from '../../../packages/aiCore/src/core/runtime'
import { novelOutlineMemoryService } from './NovelOutlineMemoryService'

const logger = loggerService.withContext('NovelOutlineService')
let abortController = new AbortController()

// 最大自动重试次数（失败自动重试）
const MAX_AUTO_RESUME_ATTEMPTS = 10

type StartOptions = { autoRetry?: boolean }

const outlineRunDirByTaskKey = new Map<string, string>()
let currentStartOptions: StartOptions = {}

// ============================================================================
// 任务目录与续传机制说明
// ============================================================================
/**
 * 该工具同时支持两种“续传”能力（语义不同）：
 *
 * 1) **继续最近任务（目录续用）**：复用最近一次任务目录，并跳过已完成分块（continueLatestTask）
 *    - 关闭：每次都创建新的任务目录（时间戳），保证不覆盖历史结果
 *    - 开启：复用该内容 hash 下最新的任务目录；若目录里已有 chunk_*.json，则仅补齐缺失分块
 *
 * 2) **失败自动重试**：任务失败时自动重试（enableAutoResume）
 *
 * 目录命名：
 * - 基于内容 hash：`novel_outline_{hash前12位}`
 * - 单次任务目录：`novel_outline_{hash前12位}_{timestamp}`（timestamp=Date.now()）
 */

// ============================================================================
// 类型定义
// ============================================================================

export interface NovelOutlineOptions {
  chunkSize: number
  overlap: number
  temperature: number
  maxConcurrency?: number
  signal?: AbortSignal
  resumeFromChunk?: number
  maxRetries?: number
  retryDelay?: number
  enableResume?: boolean  // 是否启用“继续最近任务（目录续用）”（跳过已完成分块）
}

type ModelExecutor = {
  model: Model
  provider: Provider
  executor: any
  providerId: ProviderId
  providerOptions: any
  index: number
}

interface GenerateTextResponse {
  text?: string
  [key: string]: any
}

export class NovelOutlineError extends Error {
  constructor(message: string, public detail?: unknown) {
    super(message)
    this.name = 'NovelOutlineError'
  }
}

// ============================================================================
// 工具函数
// ============================================================================

function createLogEntry(
  level: CompressionLogEntry['level'],
  message: string,
  data?: Record<string, unknown>
): CompressionLogEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    level,
    message,
    data
  }
}

// clamp 函数已移至 @main/utils/novel-utils

// splitTextIntoChunks 函数已移至 @main/utils/novel-utils (使用 splitTextIntoStringChunks)

/**
 * 创建或复用输出目录（继续最近任务：目录续用 + 跳过已完成分块）
 * 使用内容Hash确保相同内容使用相同目录
 * @param basePath 输出基础路径
 * @param contentHash 内容Hash值
 * @param enableResume 是否启用“继续最近任务（目录续用）”（来自前端开关）
 */
async function createOutputDirectory(
  basePath: string,
  contentHash: string,
  enableResume: boolean
): Promise<{ outputDir: string; isResuming: boolean }> {
  const hashPrefix = contentHash.slice(0, 12)
  const dirName = `novel_outline_${hashPrefix}`
  const outputDir = path.join(basePath, dirName)
  const taskKey = `${basePath}|${dirName}`

  const listTimestampDirs = async (): Promise<string[]> => {
    try {
      const entries = await fs.readdir(basePath)
      const dirs = await Promise.all(
        entries
          .filter((name) => name.startsWith(`${dirName}_`))
          .map(async (name) => {
            const full = path.join(basePath, name)
            try {
              const stat = await fs.stat(full)
              return stat.isDirectory() ? full : null
            } catch {
              return null
            }
          })
      )
      return dirs.filter((d): d is string => typeof d === 'string')
    } catch {
      return []
    }
  }

  const hasChunkFiles = async (dir: string): Promise<boolean> => {
    try {
      const files = await fs.readdir(dir)
      return files.some((f) => f.startsWith('chunk_') && f.endsWith('.json'))
    } catch {
      return false
    }
  }

  if (currentStartOptions.autoRetry) {
    const forcedDir = outlineRunDirByTaskKey.get(taskKey)
    if (forcedDir) {
      try {
        const stat = await fs.stat(forcedDir)
        if (stat.isDirectory()) {
          const isResuming = await hasChunkFiles(forcedDir)
          logger.info('失败自动重试：复用本次任务目录', { outputDir: forcedDir, isResuming })
          outlineRunDirByTaskKey.set(taskKey, forcedDir)
          return { outputDir: forcedDir, isResuming }
        }
      } catch {
        // ignore
      }
    }
  }

  const createNewTimestampDir = async (): Promise<string> => {
    const baseRunDirName = `${dirName}_${Date.now()}`
    let runDir = path.join(basePath, baseRunDirName)
    let counter = 1

    while (true) {
      try {
        await fs.mkdir(runDir, { recursive: false })
        return runDir
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error
        counter += 1
        runDir = path.join(basePath, `${baseRunDirName}_${counter}`)
      }
    }
  }

  if (!enableResume) {
    // 继续最近任务已关闭：每次任务都创建全新时间戳目录，避免覆盖旧结果
    const runDir = await createNewTimestampDir()
    logger.info('继续最近任务已关闭，创建新的输出目录', { outputDir: runDir, hashPrefix })
    outlineRunDirByTaskKey.set(taskKey, runDir)
    return { outputDir: runDir, isResuming: false }
  }

  // 继续最近任务已开启：选择该 hash 下“最新的时间戳任务目录”继续
  // - 若该目录已有 chunk_*.json，则视为续传
  // - 若该目录为空（第一次启动或上次刚创建未写入），视为非续传启动但复用该目录
  try {
    const candidateDirs = await listTimestampDirs()
    if (candidateDirs.length > 0) {
      const dirsWithStats = await Promise.all(
        candidateDirs.map(async (dir) => ({
          dir,
          stat: await fs.stat(dir)
        }))
      )
      const latestDir = dirsWithStats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0].dir
      const isResuming = await hasChunkFiles(latestDir)
      logger.info('继续最近任务已开启，复用最新任务目录', { outputDir: latestDir, isResuming })
      outlineRunDirByTaskKey.set(taskKey, latestDir)
      return { outputDir: latestDir, isResuming }
    }
  } catch (error) {
    logger.debug('检查最新任务目录失败', { error })
  }

  // 兼容：旧版本可能使用固定 hash 目录作为输出目录
  try {
    await fs.access(outputDir)
    const isResuming = await hasChunkFiles(outputDir)
    logger.info('检测到旧的Hash格式目录，继续最近任务复用', { outputDir, isResuming })
    outlineRunDirByTaskKey.set(taskKey, outputDir)
    return { outputDir, isResuming }
  } catch {
    // ignore
  }

  // 检查是否存在旧格式目录（带时间戳）
  try {
    const parentDir = path.dirname(basePath)
    const baseName = path.basename(basePath)
    const allFiles = await fs.readdir(parentDir)
    
    // 查找所有匹配的旧格式目录
    const oldDirs = allFiles.filter(f => 
      f.startsWith(baseName + '_outline_') && 
      f !== path.basename(outputDir)
    ).map(f => path.join(parentDir, f))

    // 按修改时间排序，选择最新的
    if (oldDirs.length > 0) {
      const dirsWithStats = await Promise.all(
        oldDirs.map(async dir => ({
          dir,
          stat: await fs.stat(dir)
        }))
      )
      
      const latestDir = dirsWithStats
        .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0].dir

      const files = await fs.readdir(latestDir)
      const hasChunks = files.some(f => f.startsWith('chunk_') && f.endsWith('.json'))
      
      if (hasChunks) {
        logger.info('检测到旧格式目录，复用已完成的分块', { oldDir: latestDir })
        outlineRunDirByTaskKey.set(taskKey, latestDir)
        return { outputDir: latestDir, isResuming: true }
      }
    }
  } catch (error) {
    logger.debug('检查旧格式目录失败', { error })
  }

  // 没有可复用的目录，创建新的时间戳目录
  const runDir = await createNewTimestampDir()
  logger.info('没有可复用目录，创建新的任务目录', { outputDir: runDir, hashPrefix })
  outlineRunDirByTaskKey.set(taskKey, runDir)
  return { outputDir: runDir, isResuming: false }
}

// ============================================================================
// Prompt 模板 - 导出默认 prompt 供前端显示
// ============================================================================

/**
 * 默认提取 Prompt
 */
export const DEFAULT_EXTRACTION_PROMPT = `你是一位专业的小说分析专家，擅长提取小说的结构化大纲。

你的任务是分析给定的小说片段，提取其中涉及的大纲要素。

**严格要求**：
1. 必须按照固定的三级结构输出JSON，绝对不可改动字段名称
2. 四级及以下内容可以自由发挥，但要保持“键: 值”形式，值需为字符串或进一步的对象
3. 如果某个分类在本片段无内容，输出空对象 {}（或空数组 []，仅在确实需要数组时使用）
4. 不允许把固定层级写成字符串数组或仅列出值，必须是对象形式

**固定的三级JSON结构示例**：
\`\`\`json
{
  "世界观/背景": {
    "时代": {
      "背景": "时代概述",
      "时间跨度": "时间范围"
    },
    "世界格局": {},
    "核心矛盾": {},
    "力量体系": {
      "能量来源": {},
      "修炼境界": {}
    },
    "特殊设定": {}
  },
  "功法与武技": {
    "功法": {
      "名称": {
        "功法名": "定位/来源"
      },
      "描述": {
        "功法名": "功法效果描述"
      }
    },
    "武技/法术": {
      "名称": {},
      "描述": {}
    }
  },
  "势力分布": {
    "势力全称": {},
    "空间坐标": {
      "位面/宇宙": {},
      "大陆/星域": {},
      "疆域/国度": {},
      "州/郡/省": {},
      "具体地点": {}
    },
    "势力评级": {},
    "势力类型": {},
    "核心简介": {
      "一句话定位": {},
      "实力构成": {},
      "标志性特征": {},
      "与主角关系": {}
    }
  },
  "主角设定": {
    "主角": {},
    "外貌": {},
    "性格和动机": {},
    "金手指/外挂": {},
    "成长弧光": {}
  },
  "配角": {
    "主要配角": {
      "姓名": {},
      "来自哪里": {},
      "与主角关系描述（主要是正面或中性）": {}
    },
    "反派": {
      "姓名": {},
      "来自哪里": {},
      "与主角关系描述（主要是负面）": {}
    }
  },
  "剧情结构": {
    "阶段或事件名": "事件描述，可根据需要新增多个键"
  }
}
\`\`\`

**JSON格式要求**：
- 以上所有固定节点的值必须是对象 {}，不要直接写字符串或数组
- 可以在四级及以下继续新增键来补充细节，但禁止新增新的一级/二级/三级名称
- 文本描述要客观准确，只引用原文明确出现的信息
- 确保 JSON 语法正确，无多余注释或额外文本

**势力分布特别说明**：
- “势力全称”用于罗列势力或阵营的名称及简介
- “空间坐标”需要分别说明势力所在的位面/大陆/国度/具体地点等层级，如没有信息请留空对象
- “核心简介”要求覆盖一句话定位、实力构成、标志性特征、与主角关系四个维度

**剧情结构说明**：
- 以对象形式列出剧情阶段或关键事件，可根据内容自由命名键（如“序章”“第一幕”“冲突升级”等）
- 每个键的值仍需是字符串或嵌套对象，保持结构化描述

**注意**：
- 只提取本片段明确涉及的内容，不要臆测
- 如无法确定信息，请留空对象 {}`

/**
 * 默认世界观/背景总结 Prompt
 */
export const DEFAULT_WORLDVIEW_PROMPT = `你是一位专业的小说分析专家，擅长整合和阐述世界观设定。

下面是小说大纲中【世界观/背景】部分的合并结果（JSON 格式）：

\`\`\`json
{{SECTION_JSON}}
\`\`\`

请基于以上信息，生成一段只包含【世界观/背景】内容的 Markdown 小节，用于放在完整大纲的“世界观/背景”章节下。

要求：
1. 只总结世界观/背景相关的信息（时代、世界格局、核心矛盾、力量体系、特殊设定），不要涉及人物或剧情细节。
2. 不要输出一级标题（#），可以从二级标题（##）或无标题列表开始。
3. 结构清晰，条理分明，适合作为策划案中的一个子章节。

请直接输出该小节的 Markdown 内容。`

/**
 * 默认主角设定总结 Prompt
 */
export const DEFAULT_PROTAGONIST_PROMPT = `你是一位专注于人物设定的小说分析专家。

下面是小说大纲中【主角设定】部分的合并结果（JSON 格式）：

\`\`\`json
{{SECTION_JSON}}
\`\`\`

请基于以上信息，生成一段只包含【主角设定】内容的 Markdown 小节，用于放在完整大纲的“主角设定”章节下。

要求：
1. 聚焦主角的身份、外貌、性格与动机、金手指/外挂、成长弧光等核心要素。
2. 不要展开配角或势力细节，只在与主角强相关时简短提及。
3. 不要输出一级标题（#），可以从二级标题（##）或列表开始。

请直接输出该小节的 Markdown 内容。`

/**
 * 默认功法与武技总结 Prompt
 */
export const DEFAULT_TECHNIQUES_PROMPT = `你是一位擅长设定修炼体系的小说分析专家。

下面是小说大纲中【功法与武技】部分的合并结果（JSON 格式）：

\`\`\`json
{{SECTION_JSON}}
\`\`\`

请基于以上信息，生成一段只包含【功法与武技】内容的 Markdown 小节，用于放在完整大纲的“功法与武技”章节下。

要求：
1. 梳理主要功法、武技/法术的名称和定位，适当说明来源、使用者与作用。
2. 避免重复堆砌细节，强调体系感和代表性。
3. 不要输出一级标题（#），可以从二级标题（##）或列表开始。

请直接输出该小节的 Markdown 内容。`

/**
 * 默认势力分布总结 Prompt
 */
export const DEFAULT_FACTIONS_PROMPT = `你是一位擅长分析势力格局的小说设定专家。

下面是小说大纲中【势力分布】部分的合并结果（JSON 格式）：

\`\`\`json
{{SECTION_JSON}}
\`\`\`

请基于以上信息，生成一段只包含【势力分布】内容的 Markdown 小节，用于放在完整大纲的“势力分布”章节下。

要求：
1. 按势力全称和空间坐标（位面/大陆/国度/具体地点）梳理主要势力。
2. 对每个重要势力，简要说明评级、类型、核心特点以及与主角的关系（如有）。
3. 不要输出一级标题（#），可以从二级标题（##）或列表开始。

请直接输出该小节的 Markdown 内容。`

/**
 * 默认配角总结 Prompt
 */
export const DEFAULT_CHARACTERS_PROMPT = `你是一位专注于配角与反派设计的小说分析专家。

下面是小说大纲中【配角】部分的合并结果（JSON 格式）：

\`\`\`json
{{SECTION_JSON}}
\`\`\`

请基于以上信息，生成一段只包含【配角】内容的 Markdown 小节，用于放在完整大纲的“配角”章节下。

要求：
1. 区分“主要配角”和“反派”，分别概括其姓名、来历、与主角的关系与作用。
2. 重点突出对主线有明显推动作用的角色，适当合并重复信息。
3. 不要输出一级标题（#），可以从二级标题（##）或列表开始。

请直接输出该小节的 Markdown 内容。`

/**
 * 默认写作风格指引 Prompt（可选）
 * 此 prompt 会作为"写作风格指引"附加到所有 section 的总结 prompt 后面
 * 用于统一各 section 的输出风格和语言特点
 */
export const DEFAULT_SYNTHESIS_PROMPT = `以下是从多个片段提取的大纲要素（JSON格式）：

\`\`\`json
{{MERGED_JSON}}
\`\`\`

请将其整合成一个完整的小说大纲，必须严格按照以下结构输出 Markdown：

- 世界观/背景
  - 时代：
  - 世界格局：
  - 核心矛盾：
  - 力量体系
    - 能量来源：
    - 修炼境界：
  - 特殊设定：
- 功法与武技
  - 功法
    - 名称：
    - 描述：
  - 武技/法术
    - 名称：
    - 描述：
- 势力分布
  - 势力全称：
  - 空间坐标
    - 位面/宇宙：
    - 大陆/星域：
    - 疆域/国度：
    - 州/郡/省：
    - 具体地点：
  - 势力评级：
  - 势力类型：
  - 核心简介
    - 一句话定位：
    - 实力构成：
    - 标志性特征：
    - 与主角关系：
- 主角设定
  - 主角：
  - 外貌：
  - 性格和动机：
  - 金手指/外挂：
  - 成长弧光：
- 配角
  - 主要配角：
  - 反派：
- 剧情结构
  - 按时间线/篇章列出关键事件，可自由命名条目，但必须置于该章节下

**重要**：以上标题不可更名，缺失信息使用“暂无”或留空行描述，保持 Markdown 条理。

请直接输出Markdown，不要有其他说明文字。`

/**
 * 构建分块大纲提取 Prompt
 */
function buildOutlineExtractionPrompt(chunk: string): ModelMessage[] {
  const state = novelOutlineMemoryService.getState()

  const systemPrompt =
    state.useCustomPrompts && state.customExtractionPrompt.trim()
      ? state.customExtractionPrompt
      : DEFAULT_EXTRACTION_PROMPT

  const userPrompt = `请分析以下小说片段，提取大纲要素，严格按照上述JSON格式输出：

${chunk}

请直接输出JSON，不要有任何其他文字。`

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ]
}

// ============================================================================
// JSON 解析和验证
// ============================================================================

type OutlineLeafValue = string | number | boolean | null | { [key: string]: OutlineLeafValue }

const OUTLINE_LEAF_VALUE_SCHEMA: z.ZodType<OutlineLeafValue> = z.lazy(() =>
  z.preprocess((value) => {
    if (Array.isArray(value)) {
      return value
        .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
        .filter((item) => item.length > 0)
        .join('；')
    }
    return value
  }, z.union([z.string(), z.number(), z.boolean(), z.null(), z.record(z.string(), OUTLINE_LEAF_VALUE_SCHEMA)]))
)

const OUTLINE_LEAF_OBJECT_SCHEMA = z.preprocess(
  (value) => {
    if (value === null || value === undefined) return {}
    if (Array.isArray(value)) {
      return {
        列表: value
          .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
          .filter((item) => item.length > 0)
          .join('；')
      }
    }
    if (typeof value !== 'object') {
      return { 内容: String(value) }
    }
    return value
  },
  z.record(z.string(), OUTLINE_LEAF_VALUE_SCHEMA)
)

const OUTLINE_POWER_SYSTEM_SCHEMA = z
  .object({
    能量来源: OUTLINE_LEAF_OBJECT_SCHEMA.optional(),
    修炼境界: OUTLINE_LEAF_OBJECT_SCHEMA.optional()
  })
  .passthrough()
  .optional()

const OUTLINE_SCHEMA = z
  .object({
    '世界观/背景': z
      .object({
        时代: OUTLINE_LEAF_OBJECT_SCHEMA.optional(),
        世界格局: OUTLINE_LEAF_OBJECT_SCHEMA.optional(),
        核心矛盾: OUTLINE_LEAF_OBJECT_SCHEMA.optional(),
        力量体系: OUTLINE_POWER_SYSTEM_SCHEMA.optional(),
        特殊设定: OUTLINE_LEAF_OBJECT_SCHEMA.optional()
      })
      .passthrough()
      .optional(),
    '功法与武技': z
      .object({
        功法: z
          .object({
            名称: OUTLINE_LEAF_OBJECT_SCHEMA.optional(),
            描述: OUTLINE_LEAF_OBJECT_SCHEMA.optional()
          })
          .passthrough()
          .optional(),
        '武技/法术': z
          .object({
            名称: OUTLINE_LEAF_OBJECT_SCHEMA.optional(),
            描述: OUTLINE_LEAF_OBJECT_SCHEMA.optional()
          })
          .passthrough()
          .optional()
      })
      .passthrough()
      .optional(),
    '势力分布': z
      .object({
        势力全称: OUTLINE_LEAF_OBJECT_SCHEMA.optional(),
        空间坐标: z
          .object({
            '位面/宇宙': OUTLINE_LEAF_OBJECT_SCHEMA.optional(),
            '大陆/星域': OUTLINE_LEAF_OBJECT_SCHEMA.optional(),
            '疆域/国度': OUTLINE_LEAF_OBJECT_SCHEMA.optional(),
            '州/郡/省': OUTLINE_LEAF_OBJECT_SCHEMA.optional(),
            '具体地点': OUTLINE_LEAF_OBJECT_SCHEMA.optional()
          })
          .passthrough()
          .optional(),
        势力评级: OUTLINE_LEAF_OBJECT_SCHEMA.optional(),
        势力类型: OUTLINE_LEAF_OBJECT_SCHEMA.optional(),
        核心简介: z
          .object({
            一句话定位: OUTLINE_LEAF_OBJECT_SCHEMA.optional(),
            实力构成: OUTLINE_LEAF_OBJECT_SCHEMA.optional(),
            标志性特征: OUTLINE_LEAF_OBJECT_SCHEMA.optional(),
            与主角关系: OUTLINE_LEAF_OBJECT_SCHEMA.optional()
          })
          .passthrough()
          .optional()
      })
      .passthrough()
      .optional(),
    '主角设定': z
      .object({
        主角: OUTLINE_LEAF_OBJECT_SCHEMA.optional(),
        外貌: OUTLINE_LEAF_OBJECT_SCHEMA.optional(),
        '性格和动机': OUTLINE_LEAF_OBJECT_SCHEMA.optional(),
        '金手指/外挂': OUTLINE_LEAF_OBJECT_SCHEMA.optional(),
        成长弧光: OUTLINE_LEAF_OBJECT_SCHEMA.optional()
      })
      .passthrough()
      .optional(),
    '配角': z
      .object({
        主要配角: z
          .object({
            姓名: OUTLINE_LEAF_OBJECT_SCHEMA.optional(),
            来自哪里: OUTLINE_LEAF_OBJECT_SCHEMA.optional(),
            '与主角关系描述（主要是正面或中性）': OUTLINE_LEAF_OBJECT_SCHEMA.optional()
          })
          .passthrough()
          .optional(),
        反派: z
          .object({
            姓名: OUTLINE_LEAF_OBJECT_SCHEMA.optional(),
            来自哪里: OUTLINE_LEAF_OBJECT_SCHEMA.optional(),
            '与主角关系描述（主要是负面）': OUTLINE_LEAF_OBJECT_SCHEMA.optional()
          })
          .passthrough()
          .optional()
      })
      .passthrough()
      .optional(),
    '剧情结构': OUTLINE_LEAF_OBJECT_SCHEMA.optional()
  })
  .passthrough()

/**
 * 解析大纲JSON
 */
function parseOutlineJSON(
  responseText: string,
  context?: { chunkIndex?: number; model?: string }
): OutlineStructure {
  let jsonText = responseText.trim()

  // 移除markdown代码块标记和常见噪音
  jsonText = jsonText.replace(/^```json\s*/i, '').replace(/```$/i, '').trim()

  // 模型偶尔会在JSON前附带自述、提示或括号表达式，尝试截取首个JSON对象
  if (!jsonText.startsWith('{')) {
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      jsonText = jsonMatch[0]
    }
  }

  try {
    const data = JSON.parse(jsonText)
    return validateOutlineStructure(data)
  } catch (error) {
    const responsePreview = responseText.substring(0, 4000)
    const jsonPreview = jsonText.substring(0, 4000)
    logger.error('JSON解析失败', { error, context, responsePreview, jsonPreview })
    throw new NovelOutlineError('AI返回的JSON格式无效', {
      context,
      errorMessage: error instanceof Error ? error.message : String(error),
      responseText: responseText.substring(0, 200000),
      jsonText: jsonText.substring(0, 200000)
    })
  }
}

/**
 * 验证并补全大纲结构（固定三级结构）
 */
function validateOutlineStructure(data: any): OutlineStructure {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    data = {}
  }

  const ensureObject = (target: any, key: string) => {
    if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
      target[key] = {}
    }
    return target[key]
  }

  const worldBackground = ensureObject(data, '世界观/背景')
  ensureObject(worldBackground, '时代')
  ensureObject(worldBackground, '世界格局')
  ensureObject(worldBackground, '核心矛盾')
  const powerSystem = ensureObject(worldBackground, '力量体系')
  ensureObject(powerSystem, '能量来源')
  ensureObject(powerSystem, '修炼境界')
  ensureObject(worldBackground, '特殊设定')

  const martialArts = ensureObject(data, '功法与武技')
  const gongfa = ensureObject(martialArts, '功法')
  ensureObject(gongfa, '名称')
  ensureObject(gongfa, '描述')
  const skills = ensureObject(martialArts, '武技/法术')
  ensureObject(skills, '名称')
  ensureObject(skills, '描述')

  const factions = ensureObject(data, '势力分布')
  ensureObject(factions, '势力全称')
  const coordinates = ensureObject(factions, '空间坐标')
  ensureObject(coordinates, '位面/宇宙')
  ensureObject(coordinates, '大陆/星域')
  ensureObject(coordinates, '疆域/国度')
  ensureObject(coordinates, '州/郡/省')
  ensureObject(coordinates, '具体地点')
  ensureObject(factions, '势力评级')
  ensureObject(factions, '势力类型')
  const intro = ensureObject(factions, '核心简介')
  ensureObject(intro, '一句话定位')
  ensureObject(intro, '实力构成')
  ensureObject(intro, '标志性特征')
  ensureObject(intro, '与主角关系')

  const protagonist = ensureObject(data, '主角设定')
  ensureObject(protagonist, '主角')
  ensureObject(protagonist, '外貌')
  ensureObject(protagonist, '性格和动机')
  ensureObject(protagonist, '金手指/外挂')
  ensureObject(protagonist, '成长弧光')

  const supporting = ensureObject(data, '配角')
  const mainSupporting = ensureObject(supporting, '主要配角')
  ensureObject(mainSupporting, '姓名')
  ensureObject(mainSupporting, '来自哪里')
  ensureObject(mainSupporting, '与主角关系描述（主要是正面或中性）')
  const antagonist = ensureObject(supporting, '反派')
  ensureObject(antagonist, '姓名')
  ensureObject(antagonist, '来自哪里')
  ensureObject(antagonist, '与主角关系描述（主要是负面）')

  if (!data['剧情结构'] || typeof data['剧情结构'] !== 'object' || Array.isArray(data['剧情结构'])) {
    data['剧情结构'] = {}
  }

  return data as OutlineStructure
}

// ============================================================================
// 文件操作
// ============================================================================

/**
 * 保存分块结果
 */
async function saveChunkOutlineResult(
  outputDir: string,
  chunkIndex: number,
  chunkName: string,
  outline: OutlineStructure
): Promise<void> {
  const fileName = `chunk_${String(chunkIndex + 1).padStart(3, '0')}.json`
  const filePath = path.join(outputDir, fileName)

  const data: OutlineChunkResult = {
    chunkIndex,
    chunkName,
    outline
  }

  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
  logger.info('分块结果已保存', { filePath })
}

/**
 * 加载已完成的分块结果（继续最近任务）
 */
async function loadChunkResults(outputDir: string): Promise<OutlineChunkResult[]> {
  try {
    const files = await fs.readdir(outputDir)
    const chunkFiles = files.filter(f => f.startsWith('chunk_') && f.endsWith('.json'))

    const results: OutlineChunkResult[] = []
    for (const file of chunkFiles) {
      const content = await fs.readFile(path.join(outputDir, file), 'utf-8')
      const data = JSON.parse(content)
      validateOutlineStructure(data.outline)
      results.push(data)
    }

    return results.sort((a, b) => a.chunkIndex - b.chunkIndex)
  } catch (error) {
    logger.warn('加载分块结果失败', { error })
    return []
  }
}

/**
 * 加载最终大纲JSON（场景2：查看已完成的大纲）
 */
export async function loadFinalOutlineJSON(filePath: string): Promise<NovelOutlineResult> {
  const content = await fs.readFile(filePath, 'utf-8')
  const data = JSON.parse(content)

  validateOutlineStructure(data.merged)

  return {
    chunks: data.chunks || [],
    merged: data.merged,
    final: data.final || '',
    metadata: data.metadata
  }
}

// ============================================================================
// 大纲合并
// ============================================================================

/**
 * 深度合并对象
 */
const isPrimitiveValue = (value: any) =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

function combinePrimitive(target: any, source: any) {
  const toArray = (val: any) => (Array.isArray(val) ? val : [val])
  if (target === undefined || target === null) return source
  if (source === undefined || source === null) return target

  const targetArr = toArray(target)
  const sourceArr = toArray(source)
  return [...targetArr, ...sourceArr]
}

function deepMerge(target: any, source: any): any {
  if (Array.isArray(target) && Array.isArray(source)) {
    return [...target, ...source]
  }

  if (Array.isArray(target) && !Array.isArray(source)) {
    return source !== undefined && source !== null ? [...target, source] : target
  }

  if (!Array.isArray(target) && Array.isArray(source)) {
    return target !== undefined && target !== null ? [target, ...source] : source
  }

  if (isPrimitiveValue(target) && isPrimitiveValue(source)) {
    if (target === source) return target
    return combinePrimitive(target, source)
  }

  if (isPrimitiveValue(target) && !isPrimitiveValue(source)) {
    return source !== undefined && source !== null ? combinePrimitive(target, source) : target
  }

  if (!isPrimitiveValue(target) && isPrimitiveValue(source)) {
    return combinePrimitive(target, source)
  }

  if (typeof target === 'object' && target !== null && typeof source === 'object' && source !== null) {
    const result: any = { ...target }
    for (const key in source) {
      if (source[key] !== null && source[key] !== undefined) {
        if (key in result) {
          result[key] = deepMerge(result[key], source[key])
        } else {
          result[key] = source[key]
        }
      }
    }
    return result
  }

  return source !== null && source !== undefined ? source : target
}

/**
 * 合并所有分块的大纲
 */
function mergeOutlineChunks(chunks: OutlineChunkResult[]): OutlineStructure {
  let merged: OutlineStructure = {
    '世界观/背景': {
      时代: {},
      世界格局: {},
      核心矛盾: {},
      力量体系: {
        能量来源: {},
        修炼境界: {}
      },
      特殊设定: {}
    },
    '功法与武技': {
      功法: {
        名称: {},
        描述: {}
      },
      '武技/法术': {
        名称: {},
        描述: {}
      }
    },
    '势力分布': {
      势力全称: {},
      空间坐标: {
        '位面/宇宙': {},
        '大陆/星域': {},
        '疆域/国度': {},
        '州/郡/省': {},
        '具体地点': {}
      },
      势力评级: {},
      势力类型: {},
      核心简介: {
        一句话定位: {},
        实力构成: {},
        标志性特征: {},
        与主角关系: {}
      }
    },
    '主角设定': {
      主角: {},
      外貌: {},
      性格和动机: {},
      '金手指/外挂': {},
      成长弧光: {}
    },
    '配角': {
      主要配角: {
        姓名: {},
        来自哪里: {},
        '与主角关系描述（主要是正面或中性）': {}
      },
      反派: {
        姓名: {},
        来自哪里: {},
        '与主角关系描述（主要是负面）': {}
      }
    },
    '剧情结构': {}
  }

  for (const chunk of chunks) {
    merged = deepMerge(merged, chunk.outline) as OutlineStructure
  }

  return merged
}

// ============================================================================
// 模型执行
// ============================================================================

/**
 * 创建模型执行器
 */
async function createModelExecutors(
  providerConfigs: { modelId: string; providerId: ProviderId; options: any }[]
): Promise<ModelExecutor[]> {
  // 清理所有已注册的 provider，确保状态一致性
  clearAllProviders()

  const executors: ModelExecutor[] = []

  for (let i = 0; i < providerConfigs.length; i++) {
    const config = providerConfigs[i]

    // 注册 provider
    await createAndRegisterProvider(config.providerId, config.options)

    // 创建 executor
    const executor = createExecutor(config.providerId, { ...config.options, mode: 'chat' })

    // 构建临时的 Model 对象（用于兼容现有接口）
    const model: Model = {
      id: config.modelId,
      name: config.modelId,
      provider: config.providerId as any
    } as Model

    executors.push({
      model,
      provider: null as any,  // Provider 对象不再需要
      executor,
      providerId: config.providerId,
      providerOptions: config.options,
      index: i
    })
    
    logger.info(`初始化模型执行器 #${i}`, {
      index: i,
      modelId: config.modelId,
      providerId: config.providerId
    })
  }

  return executors
}

/**
 * 分析单个分块
 */
async function analyzeChunkForOutline(
  chunk: string,
  chunkIndex: number,
  executor: ModelExecutor,
  temperature: number,
  signal?: AbortSignal
): Promise<OutlineStructure> {
  const messages = buildOutlineExtractionPrompt(chunk)

  // 尝试使用结构化输出
  try {
    const structuredResponse = await executor.executor.generateObject({
      model: executor.model.id,
      schema: OUTLINE_SCHEMA,
      messages,
      temperature,
      abortSignal: signal
    })

    const outlineObject = (structuredResponse as any)?.object
    if (outlineObject && typeof outlineObject === 'object') {
      return validateOutlineStructure(outlineObject)
    }
    throw new Error('AI未返回结构化 object')
  } catch (structuredError) {
    logger.warn('结构化大纲生成失败，尝试重新注册 provider 后回退到文本JSON解析', {
      error: structuredError,
      model: executor.model.name,
      chunkIndex
    })

    // 失败回退：重新注册 provider 以确保状态一致性
    try {
      await createAndRegisterProvider(executor.providerId, executor.providerOptions)
      logger.info('已重新注册 provider', { providerId: executor.providerId, chunkIndex })
    } catch (reregisterError) {
      logger.warn('重新注册 provider 失败，继续使用现有状态', {
        error: reregisterError,
        providerId: executor.providerId
      })
    }
  }

  // 回退到文本生成 + JSON 解析
  const response: GenerateTextResponse = await executor.executor.generateText({
    model: executor.model.id,
    messages,
    temperature,
    signal
  })

  if (!response.text) {
    throw new NovelOutlineError('AI返回为空')
  }

  return parseOutlineJSON(response.text, { chunkIndex, model: executor.model.name })
}

/**
 * 并发处理所有分块
 */
async function processChunksWithModelPool(
  chunks: string[],
  executors: ModelExecutor[],
  outputDir: string,
  options: NovelOutlineOptions
): Promise<OutlineChunkResult[]> {
  const memoryService = novelOutlineMemoryService
  const results: OutlineChunkResult[] = new Array(chunks.length)
  const temperature = clamp(options.temperature, 0, 2)
  const maxConcurrency = options.maxConcurrency || 3

  // 加载已完成的分块
  const existingResults = await loadChunkResults(outputDir)
  const completedIndices = new Set(existingResults.map(r => r.chunkIndex))

  for (const result of existingResults) {
    results[result.chunkIndex] = result
  }

  // 初始化 chunkSummaries - 所有分块初始状态
  const chunkSummaries: import('@shared/types').ChunkSummary[] = chunks.map((chunk, index) => ({
    index,
    status: completedIndices.has(index) ? 'completed' : 'pending',
    inputLength: chunk.length,
    targetLength: chunk.length, // 大纲提取不压缩，目标长度等于输入长度
    outputLength: completedIndices.has(index) ? chunk.length : undefined
  }))

  // 更新初始 chunkSummaries 状态
  memoryService.updateState({ chunkSummaries })

  // 记录断���续传状态
  if (completedIndices.size > 0) {
    logger.info('检测到已完成的分块', {
      completed: completedIndices.size,
      total: chunks.length,
      indices: Array.from(completedIndices).sort((a, b) => a - b)
    })

    memoryService.updateState({
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', `继续最近任务：已完成 ${completedIndices.size}/${chunks.length} 个分块`, {
          completedIndices: Array.from(completedIndices).map(i => i + 1)
        })
      ],
      progress: {
        current: completedIndices.size,
        total: chunks.length,
        percentage: Math.round((completedIndices.size / chunks.length) * 100),
        stage: 'compressing'
      }
    })
  }

  // 创建任务队列
  const pendingIndices = chunks
    .map((_, i) => i)
    .filter(i => !completedIndices.has(i))

  logger.info('开始处理分块', {
    total: chunks.length,
    completed: completedIndices.size,
    pending: pendingIndices.length
  })

  // 多模型并发处理
  const workers = executors.map(async (executor) => {
    while (pendingIndices.length > 0) {
      // 检查是否已取消
      if (options.signal?.aborted) {
        logger.info('任务已取消，停止处理')
        break
      }
      const tasks = pendingIndices.splice(0, maxConcurrency)

      await Promise.all(
        tasks.map(async (index) => {
          const chunkName = `第${index + 1}节`
          const startTime = Date.now()

          try {
            // 更新状态为 processing
            const currentSummaries = [...memoryService.getState().chunkSummaries]
            currentSummaries[index] = {
              ...currentSummaries[index],
              status: 'processing',
              startedAt: startTime
            }
            memoryService.updateState({
              chunkSummaries: currentSummaries,
              logs: [
                ...memoryService.getState().logs,
                createLogEntry('info', `开始分析 ${chunkName}`, { executor: executor.model.name })
              ]
            })

            const outline = await analyzeChunkForOutline(
              chunks[index],
              index,
              executor,
              temperature,
              options.signal
            )

            await saveChunkOutlineResult(outputDir, index, chunkName, outline)

            results[index] = { chunkIndex: index, chunkName, outline }

            // 更新进度和 chunkSummaries
            const completed = results.filter(r => r).length
            const endTime = Date.now()
            const updatedSummaries = [...memoryService.getState().chunkSummaries]
            updatedSummaries[index] = {
              ...updatedSummaries[index],
              status: 'completed',
              outputLength: JSON.stringify(outline).length,
              durationMs: endTime - startTime,
              finishedAt: endTime
            }
            memoryService.updateState({
              chunkSummaries: updatedSummaries,
              progress: {
                current: completed,
                total: chunks.length,
                percentage: Math.round((completed / chunks.length) * 100),
                stage: 'compressing'
              },
              logs: [
                ...memoryService.getState().logs,
                createLogEntry('info', `${chunkName} 分析完成`, { progress: `${completed}/${chunks.length}` })
              ]
            })
          } catch (error) {
            logger.error(`${chunkName} 分析失败`, { error })
            try {
              if (error instanceof NovelOutlineError && error.detail) {
                const fileName = `chunk_${String(index + 1).padStart(3, '0')}_failure.json`
                const filePath = path.join(outputDir, fileName)
                await fs.writeFile(
                  filePath,
                  JSON.stringify(
                    {
                      chunkIndex: index,
                      chunkName,
                      model: executor.model.name,
                      createdAt: Date.now(),
                      errorMessage: error.message,
                      detail: error.detail
                    },
                    null,
                    2
                  ),
                  'utf-8'
                )
                logger.warn('已保存分块失败诊断信息', { filePath })
              }
            } catch (artifactError) {
              logger.warn('保存分块失败诊断信息失败', { artifactError })
            }
            // 更新 chunkSummaries 为 error 状态
            const errorSummaries = [...memoryService.getState().chunkSummaries]
            errorSummaries[index] = {
              ...errorSummaries[index],
              status: 'error',
              errorMessage: (error as Error).message,
              finishedAt: Date.now()
            }
            memoryService.updateState({
              chunkSummaries: errorSummaries,
              logs: [
                ...memoryService.getState().logs,
                createLogEntry('error', `${chunkName} 分析失败: ${(error as Error).message}`)
              ]
            })
            // 不抛出错误，继续处理其他分块
          }
        })
      )
    }
  })

  await Promise.all(workers)

  // 检查完成情况
  const successfulResults = results.filter(r => r)
  const failedCount = chunks.length - successfulResults.length

  if (successfulResults.length === 0) {
    throw new NovelOutlineError('所有分块分析都失败了')
  }

  if (failedCount > 0) {
    const failedIndices = Array.from({ length: chunks.length }, (_, i) => i)
      .filter(i => !results[i])

    memoryService.updateState({
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('error', `任务部分失败：有 ${failedCount} 个分块未能生成，请开启“继续最近任务”重新运行`, {
          successfulChunks: successfulResults.length,
          failedChunks: failedCount,
          totalChunks: chunks.length,
          failedIndices: failedIndices.map(i => i + 1)
        })
      ]
    })

    throw new NovelOutlineError(
      `大纲提取未完成：${failedCount}/${chunks.length} 个分块失败。已生成的分块已保存，请开启“继续最近任务”后重新运行任务。`
    )
  }

  return results.filter(r => r)
}

/**
 * 二次总结生成最终大纲（分块式总结）
 *
 * 约定（版本 B）：
 * - 世界观/背景：单独问一次 AI
 * - 主角设定：单独问一次 AI
 * - 功法与武技：单独问一次 AI
 * - 势力分布：单独问一次 AI
 * - 配角：单独问一次 AI
 * - 剧情结构：不再让 AI 总结，按合并结果的顺序直接格式化
 */
async function synthesizeFinalOutline(
  merged: OutlineStructure,
  executor: ModelExecutor,
  temperature: number,
  signal?: AbortSignal
): Promise<string> {
  const state = novelOutlineMemoryService.getState()
  const useCustomPrompts = state.useCustomPrompts
  const style =
    useCustomPrompts && state.customSynthesisPrompt.trim()
      ? state.customSynthesisPrompt.trim()
      : ''

  const summarizeSection = async (
    sectionName: string,
    sectionData: any,
    customTemplate: string | undefined,
    defaultTemplate: string
  ): Promise<string> => {
    if (!sectionData || (typeof sectionData === 'object' && Object.keys(sectionData).length === 0)) {
      return ''
    }

    const systemPrompt = `你是一位专业的小说分析专家，擅长整合和总结小说大纲。`

    const sectionJson = JSON.stringify(sectionData, null, 2)

    const rawTemplate =
      useCustomPrompts && customTemplate && customTemplate.trim().length > 0
        ? customTemplate
        : defaultTemplate

    let userPrompt = rawTemplate || defaultTemplate

    if (userPrompt.includes('{{SECTION_JSON}}')) {
      userPrompt = userPrompt.replace('{{SECTION_JSON}}', sectionJson)
    } else {
      userPrompt = `${userPrompt.trim()}

以下是本小节对应的结构化 JSON，可作为参考：
\`\`\`json
${sectionJson}
\`\`\``
    }

    if (style) {
      userPrompt = `${userPrompt}

【写作风格指引】（可选参考）：
${style}`
    }

    const messages: ModelMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]

    const response: GenerateTextResponse = await executor.executor.generateText({
      model: executor.model.id,
      messages,
      temperature,
      signal
    })

    if (!response.text) {
      throw new NovelOutlineError(`AI在生成【${sectionName}】小节时返回为空`)
    }

    return response.text.trim()
  }

  const buildPlotSection = (outline: OutlineStructure): string => {
    const lines: string[] = ['# 剧情结构']
    const plot = outline['剧情结构'] || {}
    const entries = Object.entries(plot)

    const flattenObject = (obj: any): string => {
      const parts: string[] = []
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string') {
          parts.push(`${key}：${value}`)
        } else if (Array.isArray(value)) {
          if (value.length > 0) {
            parts.push(
              `${key}：${value
                .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
                .join('、')}`
            )
          }
        } else if (typeof value === 'object' && value !== null) {
          const nested = flattenObject(value)
          if (nested) parts.push(`${key}：${nested}`)
        }
      }
      return parts.join('，')
    }

    if (!entries.length) {
      lines.push('- 暂无剧情信息')
      return lines.join('\n')
    }

    for (const [key, value] of entries) {
      if (typeof value === 'string') {
        lines.push(`- **${key}**：${value}`)
      } else if (typeof value === 'object' && value !== null) {
        const content = flattenObject(value)
        if (content) {
          lines.push(`- **${key}**：${content}`)
        }
      } else if (Array.isArray(value) && value.length > 0) {
        lines.push(`- **${key}**：${value.join('、')}`)
      }
    }

    return lines.join('\n')
  }

  // 1. 分别总结各大模块
  const [worldviewMd, protagonistMd, techniquesMd, factionsMd, charactersMd] = await Promise.all([
    summarizeSection(
      '世界观/背景',
      merged['世界观/背景'],
      state.customWorldviewPrompt,
      DEFAULT_WORLDVIEW_PROMPT
    ),
    summarizeSection(
      '主角设定',
      merged['主角设定'],
      state.customProtagonistPrompt,
      DEFAULT_PROTAGONIST_PROMPT
    ),
    summarizeSection(
      '功法与武技',
      merged['功法与武技'],
      state.customTechniquesPrompt,
      DEFAULT_TECHNIQUES_PROMPT
    ),
    summarizeSection(
      '势力分布',
      merged['势力分布'],
      state.customFactionsPrompt,
      DEFAULT_FACTIONS_PROMPT
    ),
    summarizeSection(
      '配角',
      merged['配角'],
      state.customCharactersPrompt,
      DEFAULT_CHARACTERS_PROMPT
    )
  ])

  // 2. 剧情结构按顺序直接保留
  const plotMd = buildPlotSection(merged)

  // 3. 组合最终 Markdown（标题在这里统一加）
  const sections: string[] = []

  if (worldviewMd) {
    sections.push(`# 世界观/背景\n\n${worldviewMd}`)
  }
  if (protagonistMd) {
    sections.push(`# 主角设定\n\n${protagonistMd}`)
  }
  if (techniquesMd) {
    sections.push(`# 功法与武技\n\n${techniquesMd}`)
  }
  if (factionsMd) {
    sections.push(`# 势力分布\n\n${factionsMd}`)
  }
  if (charactersMd) {
    sections.push(`# 配角\n\n${charactersMd}`)
  }
  sections.push(plotMd)

  return sections.filter(Boolean).join('\n\n')
}

/**
 * 将 OutlineStructure 转换为 Markdown
 */
function convertOutlineStructureToMarkdown(outline: OutlineStructure): string {
  const lines: string[] = []

  const isEmptyObject = (value: any) =>
    !value || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)

  const flattenObject = (obj: any): string => {
    const parts: string[] = []
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        parts.push(`${key}：${value}`)
      } else if (Array.isArray(value)) {
        if (value.length > 0) {
          parts.push(`${key}：${value.map(item => (typeof item === 'string' ? item : JSON.stringify(item))).join('、')}`)
        }
      } else if (typeof value === 'object' && value !== null) {
        const nested = flattenObject(value)
        if (nested) parts.push(`${key}：${nested}`)
      }
    }
    return parts.join('，')
  }

  const pushEntry = (label: string, value: any, indent = 0) => {
    if (value === undefined || value === null) return
    const prefix = '  '.repeat(indent)

    if (typeof value === 'string' && value.trim().length > 0) {
      lines.push(`${prefix}- **${label}**：${value}`)
      return
    }

    if (Array.isArray(value) && value.length > 0) {
      lines.push(`${prefix}- **${label}**：`)
      value.forEach((item, index) => {
        if (typeof item === 'string') {
          lines.push(`${prefix}  - ${item}`)
        } else if (isPrimitiveValue(item)) {
          lines.push(`${prefix}  - ${String(item)}`)
        } else if (typeof item === 'object' && item !== null) {
          lines.push(`${prefix}  - 项${index + 1}`)
          for (const [subKey, subValue] of Object.entries(item)) {
            pushEntry(subKey, subValue, indent + 2)
          }
        }
      })
      return
    }

    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0) {
      lines.push(`${prefix}- **${label}**：`)
      for (const [subKey, subValue] of Object.entries(value)) {
        pushEntry(subKey, subValue, indent + 1)
      }
    }
  }

  const worldBackground = outline['世界观/背景']
  lines.push('# 世界观/背景')
  pushEntry('时代', worldBackground.时代)
  pushEntry('世界格局', worldBackground.世界格局)
  pushEntry('核心矛盾', worldBackground.核心矛盾)
  lines.push('## 力量体系')
  pushEntry('能量来源', worldBackground.力量体系?.能量来源)
  pushEntry('修炼境界', worldBackground.力量体系?.修炼境界)
  pushEntry('特殊设定', worldBackground.特殊设定)
  lines.push('')

  const martialArts = outline['功法与武技']
  lines.push('# 功法与武技')
  lines.push('## 功法')
  pushEntry('名称', martialArts.功法?.名称)
  pushEntry('描述', martialArts.功法?.描述)
  lines.push('## 武技/法术')
  pushEntry('名称', martialArts['武技/法术']?.名称)
  pushEntry('描述', martialArts['武技/法术']?.描述)
  lines.push('')

  const factions = outline['势力分布']
  lines.push('# 势力分布')
  pushEntry('势力全称', factions.势力全称)
  lines.push('## 空间坐标')
  const coordinates = factions.空间坐标 || {}
  pushEntry('位面/宇宙', coordinates['位面/宇宙'])
  pushEntry('大陆/星域', coordinates['大陆/星域'])
  pushEntry('疆域/国度', coordinates['疆域/国度'])
  pushEntry('州/郡/省', coordinates['州/郡/省'])
  pushEntry('具体地点', coordinates['具体地点'])
  lines.push('## 势力评级与类型')
  pushEntry('势力评级', factions.势力评级)
  pushEntry('势力类型', factions.势力类型)
  lines.push('## 核心简介')
  const intro = factions.核心简介 || {}
  pushEntry('一句话定位', intro.一句话定位)
  pushEntry('实力构成', intro.实力构成)
  pushEntry('标志性特征', intro.标志性特征)
  pushEntry('与主角关系', intro.与主角关系)
  lines.push('')

  const protagonist = outline['主角设定']
  lines.push('# 主角设定')
  pushEntry('主角', protagonist.主角)
  pushEntry('外貌', protagonist.外貌)
  pushEntry('性格和动机', protagonist['性格和动机'])
  pushEntry('金手指/外挂', protagonist['金手指/外挂'])
  pushEntry('成长弧光', protagonist.成长弧光)
  lines.push('')

  const supporting = outline['配角']
  lines.push('# 配角')
  lines.push('## 主要配角')
  if (!isEmptyObject(supporting.主要配角)) {
    pushEntry('姓名', supporting.主要配角?.姓名)
    pushEntry('来自哪里', supporting.主要配角?.来自哪里)
    pushEntry('与主角关系（正面/中性）', supporting.主要配角?.['与主角关系描述（主要是正面或中性）'])
  }
  lines.push('## 反派')
  if (!isEmptyObject(supporting.反派)) {
    pushEntry('姓名', supporting.反派?.姓名)
    pushEntry('来自哪里', supporting.反派?.来自哪里)
    pushEntry('与主角关系（负面）', supporting.反派?.['与主角关系描述（主要是负面）'])
  }
  lines.push('')

  const plot = outline['剧情结构']
  lines.push('# 剧情结构')
  const plotEntries = Object.entries(plot)
  if (plotEntries.length === 0) {
    lines.push('- 暂无剧情信息')
  } else {
    for (const [key, value] of plotEntries) {
      if (typeof value === 'string') {
        lines.push(`- **${key}**：${value}`)
      } else if (typeof value === 'object' && value !== null) {
        const content = flattenObject(value)
        if (content) {
          lines.push(`- **${key}**：${content}`)
        }
      }
    }
  }

  return lines.join('\n')
}

/**
 * 保存最终结果
 */
async function saveFinalOutlineResult(
  outputDir: string,
  result: NovelOutlineResult
): Promise<void> {
  // 保存JSON
  const jsonPath = path.join(outputDir, 'final_outline.json')
  await fs.writeFile(jsonPath, JSON.stringify(result, null, 2), 'utf-8')

  // 保存简单合并的Markdown
  const mergedMdPath = path.join(outputDir, 'merged_outline.md')
  const mergedMd = convertOutlineStructureToMarkdown(result.merged)
  await fs.writeFile(mergedMdPath, mergedMd, 'utf-8')

  // 保存AI二次总结的Markdown
  const finalMdPath = path.join(outputDir, 'final_outline.md')
  await fs.writeFile(finalMdPath, result.final, 'utf-8')

  logger.info('最终结果已保存', { jsonPath, mergedMdPath, finalMdPath })
}

// ============================================================================
// 主函数
// ============================================================================

/**
 * 分析小说大纲（主函数）
 */
export async function analyzeNovelOutline(
  providerConfigs: { modelId: string; providerId: ProviderId; options: any }[],
  content: string,
  options: NovelOutlineOptions,
  outputPath: string
): Promise<NovelOutlineResult> {
  const memoryService = novelOutlineMemoryService

  // 记录初始内存使用
  const initialMemory = process.memoryUsage()
  logger.info('大纲分析开始 - 内存状态', {
    heapUsed: `${Math.round(initialMemory.heapUsed / 1024 / 1024)}MB`,
    heapTotal: `${Math.round(initialMemory.heapTotal / 1024 / 1024)}MB`,
    rss: `${Math.round(initialMemory.rss / 1024 / 1024)}MB`
  })

  try {
    // 1. 计算内容Hash（用于任务分组标识）
    const contentHash = crypto.createHash('sha256').update(content).digest('hex')
    logger.info('内容Hash计算完成', { hash: contentHash.slice(0, 12) })

    // 2. 分块
    memoryService.updateState({
      logs: [...memoryService.getState().logs, createLogEntry('info', '开始分块处理')]
    })

    const chunks = splitTextIntoStringChunks(content, options.chunkSize, options.overlap)
    logger.info('文本分块完成', { chunkCount: chunks.length })

    // 3. 创建或复用输出目录（根据“继续最近任务（目录续用）”开关）
    const enableResume = options.enableResume ?? false
    const { outputDir, isResuming } = await createOutputDirectory(outputPath, contentHash, enableResume)

    if (isResuming) {
      memoryService.updateState({
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('info', '检测到未完成任务，继续最近任务（目录续用）已启用', {
            outputDir
          })
        ]
      })
    } else if (enableResume) {
      memoryService.updateState({
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('info', '继续最近任务（目录续用）已启用，但未检测到已完成的分块', {
            outputDir
          })
        ]
      })
    } else {
      memoryService.updateState({
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('info', '从头开始处理（继续最近任务已关闭）', {
            outputDir
          })
        ]
      })
    }

    // 4. 创建模型执行器
    const executors = await createModelExecutors(providerConfigs)
    if (executors.length === 0) {
      throw new NovelOutlineError('没有可用的模型执行器')
    }

    // 5. 并发处理分块（自动检测并跳过已完成的分块）
    memoryService.updateState({
      logs: [...memoryService.getState().logs, createLogEntry('info', '开始提取大纲要素')]
    })

    const chunkResults = await processChunksWithModelPool(chunks, executors, outputDir, options)

    // 检查内存使用（分析完成后）
    const afterAnalysisMemory = process.memoryUsage()
    logger.info('分块分析完成 - 内存状态', {
      heapUsed: `${Math.round(afterAnalysisMemory.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(afterAnalysisMemory.heapTotal / 1024 / 1024)}MB`,
      heapIncrease: `${Math.round((afterAnalysisMemory.heapUsed - initialMemory.heapUsed) / 1024 / 1024)}MB`
    })

    // 6. 合并大纲
    memoryService.updateState({
      logs: [...memoryService.getState().logs, createLogEntry('info', '开始合并大纲')]
    })

    const merged = mergeOutlineChunks(chunkResults)

    // 7. 二次总结
    memoryService.updateState({
      logs: [...memoryService.getState().logs, createLogEntry('info', '开始生成最终大纲')]
    })

    const final = await synthesizeFinalOutline(merged, executors[0], options.temperature, options.signal)

    // 8. 保存结果
    const result: NovelOutlineResult = {
      chunks: chunkResults,
      merged,
      final,
      metadata: {
        version: '1.0',
        createdAt: Date.now(),
        models: providerConfigs.map(c => c.modelId),
        chunkCount: chunks.length
      }
    }

    await saveFinalOutlineResult(outputDir, result)

    // 记录最终内存使用
    const finalMemory = process.memoryUsage()
    const memoryIncrease = Math.round((finalMemory.heapUsed - initialMemory.heapUsed) / 1024 / 1024)
    logger.info('大纲分析完成 - 最终内存状态', {
      heapUsed: `${Math.round(finalMemory.heapUsed / 1024 / 1024)}MB`,
      totalIncrease: `${memoryIncrease}MB`,
      chunkCount: chunks.length
    })

    // 如果内存增长超过500MB，记录警告
    if (memoryIncrease > 500) {
      logger.warn('内存使用增长较大', {
        increase: `${memoryIncrease}MB`,
        recommendation: '考虑减小分块大小或分批处理'
      })
      memoryService.updateState({
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('warning', `内存使用增长 ${memoryIncrease}MB，建议优化分块参数`, {
            memoryIncrease: `${memoryIncrease}MB`
          })
        ]
      })
    }

    memoryService.updateState({
      logs: [...memoryService.getState().logs, createLogEntry('info', '大纲提取完成')],
      outputPath: outputDir,  // 更新为实际的任务目录路径（带时间戳/哈希）
      progress: {
        current: chunks.length,
        total: chunks.length,
        percentage: 100,
        stage: 'completed'
      }
    })

    return result
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '未知错误'
    logger.error('大纲提取失败', { error })
    memoryService.updateState({
      logs: [...memoryService.getState().logs, createLogEntry('error', `大纲提取失败: ${errorMessage}`)]
    })
    throw error
  }
}

// ============================================================================
// 主执行函数
// ============================================================================

/**
 * 执行大纲分析（从 memoryService 获取状态）
 */
async function executeOutlineAnalysis(
  providerConfigs: { modelId: string; providerId: ProviderId; options: any }[],
  startOptions?: StartOptions
): Promise<void> {
  const memoryService = novelOutlineMemoryService
  const state = memoryService.getState()

  currentStartOptions = startOptions ?? {}

  // 1. 检查输入
  if (!state.selectedFile && !state.inputText) {
    throw new NovelOutlineError('未选择文件或输入文本')
  }

  try {
    // 2. 设置处理状态（关键：让前端知道开始处理了）
    const startTime = Date.now()
    memoryService.updateState({
      isProcessing: true,
      result: null,
      logs: [createLogEntry('info', '开始大纲提取')]
    })

    // 3. 读取文件内容或使用输入文本
    // 性能优化：避免重复读取文件，缓存读取结果
    let content: string
    if (state.inputText) {
      content = state.inputText
    } else {
      const fileReadResult = await readTextFileWithAutoEncoding(state.selectedFile!.path)
      content = fileReadResult.content
      logger.info('文件已读取', { encoding: fileReadResult.encoding })
    }

    // 4. 构建选项
    const options: NovelOutlineOptions = {
      chunkSize: state.chunkSize,
      overlap: state.overlap,
      temperature: state.temperature,
      maxConcurrency: state.maxConcurrency,
      signal: abortController.signal,
      enableResume: state.continueLatestTask
    }

    // 5. 执行分析（直接传递 providerConfigs）
    const result = await analyzeNovelOutline(providerConfigs, content, options, state.outputPath)

    // 6. 更新状态
    const endTime = Date.now()
    const durationMs = endTime - startTime
    memoryService.updateState({
      result,
      isProcessing: false,
      progress: {
        current: result.chunks.length,
        total: result.chunks.length,
        percentage: 100,
        stage: 'completed'
      },
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', `大纲提取完成，耗时 ${Math.round(durationMs / 1000)}秒`)
      ]
    })
  } catch (error) {
    const err = error as Error
    if (err?.name === 'AbortError' || err?.message?.includes('用户取消')) {
      logger.info('大纲提取任务被用户取消/中止')
      const currentState = memoryService.getState()
      if (currentState.progress?.stage === 'cancelled') {
        memoryService.updateState({ isProcessing: false })
        return
      }
      memoryService.updateState({
        isProcessing: false,
        progress: {
          current: currentState.progress?.current ?? 0,
          total: currentState.progress?.total ?? 0,
          percentage: currentState.progress?.percentage ?? 0,
          stage: 'cancelled'
        },
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('warning', '用户取消了大纲提取任务')
        ]
      })
      return
    }

    // 错误处理（失败）
    logger.error('大纲提取失败', { error })
    memoryService.updateState({
      isProcessing: false,
      progress: {
        current: 0,
        total: 0,
        percentage: 0,
        stage: 'failed'
      },
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('error', `大纲提取失败: ${err?.message ?? '未知错误'}`)
      ]
    })

    // 检查是否需要失败自动重试
    const stateAfterFailure = memoryService.getState()
    if (stateAfterFailure.enableAutoResume && stateAfterFailure.autoResumeAttempts < MAX_AUTO_RESUME_ATTEMPTS) {
      const nextAttempt = stateAfterFailure.autoResumeAttempts + 1
      logger.info(`失败自动重试已启用，将通知前端进行第${nextAttempt}次重试...`)

      memoryService.updateState({
        autoResumeAttempts: nextAttempt,
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('info', `失败自动重试：将在3秒后进行第${nextAttempt}次重试...`, {
            attempt: nextAttempt,
            maxAttempts: MAX_AUTO_RESUME_ATTEMPTS
          })
        ]
      })

      const allWindows = BrowserWindow.getAllWindows()
      allWindows.forEach((window) => {
        if (!window.isDestroyed() && window.webContents) {
          window.webContents.send(IpcChannel.NovelOutline_AutoResumeTriggered, {
            attempt: nextAttempt,
            maxAttempts: MAX_AUTO_RESUME_ATTEMPTS
          })
        }
      })
    } else if (stateAfterFailure.enableAutoResume) {
      logger.warn(`已达到最大失败自动重试次数限制（${MAX_AUTO_RESUME_ATTEMPTS}次）`)
      memoryService.updateState({
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('warning', `已达到最大失败自动重试次数限制（${MAX_AUTO_RESUME_ATTEMPTS}次），自动重试停止`, {
            attempts: stateAfterFailure.autoResumeAttempts
          })
        ]
      })
    }
    return
  }
}

// ============================================================================
// IPC 处理
// ============================================================================

export function registerNovelOutlineHandlers(_mainWindow: BrowserWindow): void {
  ipcMain.handle(
    IpcChannel.NovelOutline_Start,
    async (
      _,
      providerConfigs: { modelId: string; providerId: ProviderId; options: any }[],
      _customPrompt?: string,
      startOptions?: StartOptions
    ): Promise<void> => {
      // 如果之前的任务已被取消，则创建一个新的 AbortController
      if (abortController.signal.aborted) {
        abortController = new AbortController()
      }

      // 重置失败自动重试计数器（仅在非失败状态启动时重置，失败后的重试需要保留计数）
      const currentState = novelOutlineMemoryService.getState()
      if (currentState.progress?.stage !== 'failed') {
        novelOutlineMemoryService.updateState({ autoResumeAttempts: 0 })
      }

      // 性能优化：使用即时返回+异步处理模式，避免阻塞渲染进程
      // 立即设置处理状态，让前端知道任务已开始
      novelOutlineMemoryService.updateState({ isProcessing: true })

      // 异步执行分析任务，不等待完成
      executeOutlineAnalysis(providerConfigs, startOptions)
        .catch((error) => {
          logger.error('Outline analysis task failed:', error)
        })
        .finally(() => {
          currentStartOptions = {}
        })

      // 立即返回，渲染进程不会阻塞
      return
    }
  )

  ipcMain.on(IpcChannel.NovelOutline_Cancel, () => {
    abortController.abort()
    logger.info('大纲提取已停止')
    // 更新状态，通知前端任务已取消
    const memoryService = novelOutlineMemoryService
    memoryService.updateState({
      isProcessing: false,
      progress: {
        current: memoryService.getState().progress?.current ?? 0,
        total: memoryService.getState().progress?.total ?? 0,
        percentage: memoryService.getState().progress?.percentage ?? 0,
        stage: 'cancelled'
      },
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('warning', '用户取消了大纲提取任务')
      ]
    })
  })

  // 加载已保存的大纲JSON
  ipcMain.handle(IpcChannel.NovelOutline_LoadJSON, async (_event, filePath) => {
    try {
      const result = await loadFinalOutlineJSON(filePath)
      return { success: true, result }
    } catch (error) {
      logger.error('加载大纲JSON失败', { error })
      return { success: false, error: (error as Error).message }
    }
  })
}
