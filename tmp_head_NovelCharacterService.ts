import { loggerService } from '@logger'
import { AsyncMutex } from '@main/utils/async-mutex'
import { parseChapters } from '@main/utils/chapter-parser'
import { readTextFileWithAutoEncoding } from '@main/utils/file'
import { clamp, splitTextIntoChunks as baseSplitTextIntoChunks } from '@main/utils/novel-utils'
import { IpcChannel } from '@shared/IpcChannel'
import type {
  ChapterChunk,
  ChapterInfo,
  ChapterParseResult,
  Character,
  CharacterOutputFormat,
  CharacterPlotMatrix,
  ChunkAnalysisFile,
  ChunkCharacterPlotAnalysis,
  ChunkSummary,
  CompressionChunk,
  CompressionLogEntry,
  NovelCompressionResult
} from '@shared/types'
import type { Model, Provider } from '@types'
import type { ModelMessage } from 'ai'
import { BrowserWindow, ipcMain, Notification } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { z } from 'zod'

import {
  clearAllProviders,
  createAndRegisterProvider,
  type ProviderId
} from '../../../packages/aiCore/src/core/providers'
import { createExecutor } from '../../../packages/aiCore/src/core/runtime'
import { novelCharacterMemoryService } from './NovelCharacterMemoryService'

const logger = loggerService.withContext('NovelCharacterService')
let abortController = new AbortController()

type StartOptions = { autoRetry?: boolean }

const characterRunDirByTaskKey = new Map<string, string>()
let currentStartOptions: StartOptions = {}

export interface NovelCompressionOptions {
  ratio: number
  chunkSize: number
  overlap: number
  temperature: number
  maxConcurrency?: number  // 每个模型的最大并发数，默认8
  signal?: AbortSignal
  resumeFromChunk?: number
  maxRetries?: number
  retryDelay?: number
  models?: Model[]
  providers?: Provider[]
  enableModelRotation?: boolean
  customPrompt?: string
}

type ModelExecutor = {
  model: Model
  provider: Provider
  executor: any
  providerId: ProviderId
  providerOptions: any
  index: number  // 执行器在数组中的索引，用于健康度追踪
}

interface GenerateTextResponse {
  text?: string
  [key: string]: any
}

export class NovelCompressionError extends Error {
  constructor(
    message: string,
    public detail?: unknown
  ) {
    super(message)
    this.name = 'NovelCompressionError'
  }
}

/**
 * 模型健康检查配置
 */
const MODEL_HEALTH_CONFIG = {
  /** 连续失败多少次后标记为不健康 */
  MAX_CONSECUTIVE_FAILURES: 3,
  /** 最小尝试次数（用于计算成功率） */
  MIN_ATTEMPTS_FOR_RATE: 5,
  /** 成功率低于此阈值标记为不健康 */
  MIN_SUCCESS_RATE: 0.3
} as const

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

// splitTextIntoChunks 包装器 - 基于 @main/utils/novel-utils
function splitTextIntoChunks(
  text: string,
  chunkSize: number,
  overlap: number,
  ratio: number
): Omit<CompressionChunk, 'compressed' | 'model' | 'usage' | 'durationMs' | 'retries'>[] {
  return baseSplitTextIntoChunks(text, chunkSize, overlap, ratio) as Omit<CompressionChunk, 'compressed' | 'model' | 'usage' | 'durationMs' | 'retries'>[]
}

// =================================================================
// 章节解析器 (Chapter Parser) - 任务 2.1-2.3
// =================================================================

/**
 * 按章节分块（本地封装）
 * 使用共享的 parseChapters，但返回本服务特有的 ChapterChunk 类型
 */
function localSplitTextByChapters(
  text: string,
  chapters: ChapterInfo[],
  chaptersPerChunk: number
): ChapterChunk[] {
  const normalizedChaptersPerChunk = Math.max(1, Math.floor(chaptersPerChunk))
  const chunks: ChapterChunk[] = []

  for (let i = 0; i < chapters.length; i += normalizedChaptersPerChunk) {
    const chunkChapters = chapters.slice(i, i + normalizedChaptersPerChunk)
    const startOffset = chunkChapters[0].startOffset
    const endOffset = chunkChapters[chunkChapters.length - 1].endOffset

    chunks.push({
      index: chunks.length,
      chapters: chunkChapters,
      text: text.slice(startOffset, endOffset)
    })
  }

  logger.info('按章节分块完成', {
    totalChunks: chunks.length,
    chaptersPerChunk: normalizedChaptersPerChunk,
    totalChapters: chapters.length
  })

  return chunks
}

// =================================================================
// 章节感知 Prompt 构建 - 任务 6.1
// =================================================================

/**
 * 构建章节感知的角色剧情分析Prompt
 * 
 * 两种分块模式都使用此函数：
 * - 按字数分块：AI 需要自行识别文本中的章节标题
 * - 按章节分块：章节信息已知，传入 chapterTitles 参数
 */
function buildChapterAwarePrompt(
  chunk: string,
  chunkIndex: number,
  targetCharacters?: string[],
  chapterTitles?: string[]  // 可选：已知的章节标题列表
): ModelMessage[] {
  const hasKnownChapters = chapterTitles && chapterTitles.length > 0
  const chapterListStr = hasKnownChapters ? chapterTitles.join('、') : ''

  const targetConfigs =
    targetCharacters && targetCharacters.length > 0 ? buildTargetCharacterAliasConfigs(targetCharacters) : []
  const targetCanonicals = targetConfigs.map((c) => c.canonical)
  const uniqueTargetCanonicals = Array.from(new Set(targetCanonicals))
  const isTargetMode = uniqueTargetCanonicals.length > 0
  const targetAliasMapText = targetConfigs
    .map((c) => `- ${c.canonical}：${c.promptAliases.length > 0 ? c.promptAliases.join('、') : '（无）'}`)
    .join('\n')
  const exampleCharacterKey = isTargetMode ? uniqueTargetCanonicals[0] : '角色名（别名）'

  const systemPrompt = `你是小说剧情分析AI，专门负责从文本中提取角色剧情线索，并按章节分别输出。

【任务目标】
${targetCharacters && targetCharacters.length > 0 
  ? `仅分析指定的目标角色（规范名）：${uniqueTargetCanonicals.join('、')}。\n\n【指定人物映射表】\n${targetAliasMapText || '（无）'}\n\n重要口径：\n- 文本中出现“规范名/别名/简称/称号”等任一称呼（见映射表）即算“提及”，必须在对应规范名下输出剧情线索（提及者是谁、语境是什么、传闻/回忆内容是什么、与当前事件/人物关系有什么关联）。\n- **输出JSON顶层key必须严格使用上述“规范名”，不得使用别名/简称/称号作为key。**\n- **输出只能包含这些规范名；每个规范名都必须输出一个字段。若本分块未提及该人物，则值填写空字符串\"\"或空对象{}。**` 
  : '识别文本中的所有出场角色，并为每个角色按章节撰写剧情摘要。'
}

【章节识别规则】
${hasKnownChapters 
  ? `本分块包含以下章节：${chapterListStr}
请严格按照这些章节标题分别输出每个角色的剧情。`
  : `请自动识别文本中的章节标题（如"第X章"、"Chapter X"、数字分隔符等），并按章节分别输出剧情。
如果文本中没有明确的章节标题，则将整个分块作为单个整体输出。`
}

【角色识别规则】
1. **识别标准**：
   - 必须有明确的人名（真名、别名、称号均可）
   - 必须实际出场（有对话、行动、心理描写等）
   - 排除：群体代称（"村民"）、人称代词（"他"）${targetCharacters && targetCharacters.length > 0 ? '' : '、仅被提及者'}

2. **同一角色判定**（重要）：
   - 同一人物的不同称呼必须合并为一个条目
   - 示例："叶凝雪" = "白枼公主" = "凝雪"（均指同一人）

3. **角色命名格式**：
   - 格式：主名（别名1、别名2）
   - 示例："石昊（小不点、荒）"

【剧情摘要规则】
1. **按章节分别输出**：每个章节的剧情独立描述
2. **未出场章节省略**：如果角色在某章节完全未出现且未被提及，不要输出该章节的键值对（被提及也算该章节相关信息）
3. **叙事完整性**：采用连贯的叙事语言，体现时间顺序和因果关系
4. **信息要素**：包含时间、地点、对象、行为、结果

【输出格式要求】
**严格输出纯JSON，不含任何其他内容（无代码块标记、无说明文字）**

${hasKnownChapters ? `正确格式（按章节输出）：
{
  "${exampleCharacterKey}": {
    "${chapterTitles[0]}": "该角色在此章节的剧情描述",
    "${chapterTitles.length > 1 ? chapterTitles[1] : '第二章 标题'}": "该角色在此章节的剧情描述"
  }
}` : `正确格式（按章节输出）：
{
  "${exampleCharacterKey}": {
    "第一章 标题": "该角色在第一章的剧情描述",
    "第二章 标题": "该角色在第二章的剧情描述"
  }
}

如果没有识别到章节标题，使用整段模式：
{
  "${exampleCharacterKey}": "整段剧情描述"
}`}

**重要**：角色未出场的章节不要输出，直接省略该章节的键值对。`

  const userPrompt = `请分析第${chunkIndex + 1}节文本${targetCharacters && targetCharacters.length > 0 
  ? `，重点关注指定角色（规范名）：${uniqueTargetCanonicals.join('、')}` 
  : '，提取所有角色及其剧情'
}。

${hasKnownChapters ? `**本分块包含章节**：${chapterListStr}
请按这些章节分别输出每个角色的剧情，未出场的章节省略。` : '**请识别章节标题并按章节分别输出剧情，未出场的章节省略。**'}

---文本内容---
${chunk}

---输出JSON---`

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ]
}

function buildCompressionMessages(
  chunk: CompressionChunk,
  _ratio: number,
  _customPrompt?: string,
  _isLastChunk?: boolean,
  targetCharacters?: string[]
): ModelMessage[] {
  // 注意：此函数仅用于向后兼容，矩阵模式不会调用此函数
  // 如果 targetCharacters 为空，返回空的提示（不应该执行到这里）
  const characterList = targetCharacters?.join('、') || '所有角色'

  const systemPrompt = `你是一位资深的文学评论家和小说鉴赏家，擅长以优美精炼的笔触刻画小说人物形象。

你的任务：
为指定角色撰写专业的文学人物志，用流畅的叙述性语言，将角色的外貌、性格、言行、心理、关系、背景等要素融为一体，呈现出立体鲜活的人物形象。

写作原则：
- 采用文学评论的叙述口吻，而非条目罗列
- 基于原文细节，用精炼语言概括提炼
- 保留关键对话原文以增强真实感
- 刻画要立体饱满，突出人物特质`
  
  const userPrompt = `请为以下文本片段中出现的角色撰写人物志：${characterList}

【写作要求】
1. **整体叙述**：用连贯的段落文字描绘人物，而非分条罗列
2. **文学化表达**：采用优美、精炼的文学语言
3. **基于原文**：所有描写须有原文依据，不可臆测
4. **保留对话**：重要对话需引用原文，用引号标注
5. **突出特质**：抓住人物最鲜明的特征进行刻画

【输出格式】
【角色名】
（此处用2-4段优美流畅的文字，完整刻画该角色的形象、性格、经历、关系等。如原文对该角色着墨不多，则简练概括即可。若该角色在本片段未出现，则写"本片段未见此人"）

【示例】
【张三】
张三是一位饱经沧桑的中年剑客。他身着一袭青衫，腰悬长剑，双目深邃如古井，眉宇间透着难以掩饰的疲惫。多年的江湖漂泊在他脸上刻下风霜的痕迹，却未能磨灭那股凛然傲骨。

性情上，张三是个寡言少语之人，但并非冷漠。面对弱者，他会毫不犹豫地拔剑相助；面对强敌，他从不轻易低头。正如他对李四所言："宁可站着死，不愿跪着生。"这句话道尽了他的处世之道。

在本段情节中，张三与旧日好友李四重逢，两人把酒言欢，却也难掩心中感慨。他们的交情可追溯到二十年前的那场江湖纷争，彼时张三孤身犯险，正是李四及时赶到，方才化险为夷。此情此义，早已超越寻常兄弟。

【文本片段】
${chunk.text}`

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ]
}

function sanitizeDirBaseName(raw: string): string {
  const cleaned = (raw ?? '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  return cleaned.length > 0 ? cleaned : '未命名'
}

function getTaskBaseNameFromOutputPath(outputPath: string, selectedFile?: { origin_name?: string; name?: string } | null): string {
  const outputBaseName = path.parse(outputPath).name
  let rawBaseName = outputBaseName

  if (outputBaseName.toLowerCase() === 'compressed') {
    rawBaseName =
      (selectedFile?.origin_name ? path.parse(selectedFile.origin_name).name : '') ||
      (selectedFile?.name ? path.parse(selectedFile.name).name : '') ||
      outputBaseName
  } else if (outputBaseName.toLowerCase().endsWith('.compressed')) {
    rawBaseName = outputBaseName.slice(0, -'.compressed'.length)
  }

  return sanitizeDirBaseName(rawBaseName)
}


// 文件夹管理工具函数
async function createOutputDirectory(
  baseOutputPath: string,
  dirBaseName: string,
  continueLatestTask: boolean,
  targetCharacters?: string[]
): Promise<{
  rootOutputDir: string
  chunksDir: string
  finalResultsDir: string
  characterTextsDir: string
}> {
  const parsedPath = path.parse(baseOutputPath)
  const suffix =
    targetCharacters && targetCharacters.length > 0
      ? `_${targetCharacters.join('_')}_人物志结果`
      : '_人物志结果'

  const parentDir = parsedPath.dir
  const baseDirName = `${dirBaseName}${suffix}`
  const prefix = `${baseDirName}_`
  const legacyRootDir = path.join(parentDir, baseDirName)
  const taskKey = `${parentDir}|${baseDirName}`

  const listTimestampDirs = async (): Promise<string[]> => {
    try {
      const entries = await fs.readdir(parentDir)
      const dirs = await Promise.all(
        entries
          .filter((name) => name.startsWith(prefix))
          .map(async (name) => {
            const full = path.join(parentDir, name)
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

  const createNewTimestampDir = async (): Promise<string> => {
    const baseRunDirName = `${baseDirName}_${Date.now()}`
    let runDir = path.join(parentDir, baseRunDirName)
    let counter = 1

    while (true) {
      try {
        await fs.mkdir(runDir, { recursive: false })
        return runDir
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error
        counter += 1
        runDir = path.join(parentDir, `${baseRunDirName}_${counter}`)
      }
    }
  }

  let rootOutputDir = ''

  if (currentStartOptions.autoRetry) {
    const forcedDir = characterRunDirByTaskKey.get(taskKey)
    if (forcedDir) {
      try {
        const stat = await fs.stat(forcedDir)
        if (stat.isDirectory()) {
          rootOutputDir = forcedDir
          logger.info('失败自动重试：复用本次任务目录', { rootOutputDir })
          characterRunDirByTaskKey.set(taskKey, rootOutputDir)
        }
      } catch {
        // ignore
      }
    }
  }

  if (!rootOutputDir && !continueLatestTask) {
    rootOutputDir = await createNewTimestampDir()
    logger.info('继续最近任务已关闭，创建新的输出目录', { rootOutputDir })
    characterRunDirByTaskKey.set(taskKey, rootOutputDir)
  } else if (!rootOutputDir) {
    try {
      const candidateDirs = await listTimestampDirs()
      if (candidateDirs.length > 0) {
        const dirsWithStats = await Promise.all(
          candidateDirs.map(async (dir) => ({
            dir,
            stat: await fs.stat(dir)
          }))
        )
        rootOutputDir = dirsWithStats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0].dir
        logger.info('继续最近任务已开启，复用最新任务目录', { rootOutputDir })
        characterRunDirByTaskKey.set(taskKey, rootOutputDir)
      }
    } catch (error) {
      logger.debug('检查最新任务目录失败', { error })
    }

    if (!rootOutputDir) {
      try {
        const stat = await fs.stat(legacyRootDir)
        if (stat.isDirectory()) {
          rootOutputDir = legacyRootDir
          logger.info('检测到旧格式人物志目录，复用该目录', { rootOutputDir })
          characterRunDirByTaskKey.set(taskKey, rootOutputDir)
        }
      } catch {
        // ignore
      }
    }

    if (!rootOutputDir) {
      rootOutputDir = await createNewTimestampDir()
      logger.info('没有可复用目录，创建新的任务目录', { rootOutputDir })
      characterRunDirByTaskKey.set(taskKey, rootOutputDir)
    }
  }

  const chunksDir = path.join(rootOutputDir, '分块内容')
  const finalResultsDir = path.join(rootOutputDir, '最终结果')
  const characterTextsDir = path.join(rootOutputDir, '人物TXT合集')

  await fs.mkdir(chunksDir, { recursive: true })
  await fs.mkdir(finalResultsDir, { recursive: true })
  await fs.mkdir(characterTextsDir, { recursive: true })

  return { rootOutputDir, chunksDir, finalResultsDir, characterTextsDir }
}

async function saveChunkFile(outputDir: string, baseName: string, chunkIndex: number, content: string): Promise<void> {
  const chunkFileName = `${baseName}_output_${chunkIndex + 1}.txt`
  const chunkFilePath = path.join(outputDir, chunkFileName)

  await fs.writeFile(chunkFilePath, content, 'utf-8')
}

async function mergeChunkFiles(outputDir: string, baseName: string, totalChunks: number, finalOutputPath: string): Promise<string> {
  const mergedParts: string[] = []

  for (let i = 0; i < totalChunks; i++) {
    const chunkFileName = `${baseName}_output_${i + 1}.txt`
    const chunkFilePath = path.join(outputDir, chunkFileName)

    try {
      const chunkContent = await fs.readFile(chunkFilePath, 'utf-8')
      mergedParts.push(chunkContent.trim())
    } catch (error) {
      throw new NovelCompressionError(`缺少块文件: ${chunkFileName}`)
    }
  }

  const mergedContent = mergedParts.join('\n\n')
  await fs.writeFile(finalOutputPath, mergedContent, 'utf-8')

  return mergedContent
}

/**
 * 从合并的文本中提取各个角色的人物志片段
 * @param mergedText 所有分块合并后的文本
 * @param targetCharacters 目标角色列表
 * @returns 角色名 -> 人物志片段内容的映射
 */
function extractCharacterProfiles(mergedText: string, targetCharacters: string[]): Record<string, string> {
  const profiles: Record<string, string> = {}
  
  if (!targetCharacters || targetCharacters.length === 0) {
    return profiles
  }

  // 为每个角色提取信息
  for (const character of targetCharacters) {
    const characterInfos: string[] = []
    
    // 使用正则匹配角色块 【角色名】
    const pattern = new RegExp(`【${character}】([\\s\\S]*?)(?=【|$)`, 'g')
    let match
    
    while ((match = pattern.exec(mergedText)) !== null) {
      const info = match[1].trim()
      if (info && info !== '本片段无相关信息' && info !== '本片段未见此人') {
        characterInfos.push(info)
      }
    }
    
    // 合并该角色的所有信息
    if (characterInfos.length > 0) {
      profiles[character] = characterInfos.join('\n\n---\n\n')
    } else {
      profiles[character] = '暂无相关信息'
    }
  }
  
  return profiles
}

/**
 * 构建最终总结的 Prompt
 * @param characterName 角色名称
 * @param characterInfo 该角色从各分块提取的信息片段
 * @returns AI 消息数组
 */
function buildFinalSynthesisMessages(characterName: string, characterInfo: string): ModelMessage[] {
  const systemPrompt = `你是一位资深的文学评论家，擅长提炼人物形象，用优美精炼的文学语言撰写人物志。

你的任务：
将提供的角色信息片段（来自小说的多个章节段落），综合提炼为一篇完整、连贯、优美的人物志。

写作要求：
- 采用叙述性段落，而非条目列表
- 语言优美精炼，富有文学性
- 内容基于提供的信息，不可臆测
- 保留关键对话原文（用引号标注）
- 突出人物最鲜明的特质
- 篇幅控制在 2-4 个自然段

输出格式：
直接输出人物志正文，无需标题或【角色名】标记。`

  const userPrompt = `请为角色"${characterName}"撰写最终人物志。

以下是从小说各章节提取的该角色信息片段：

${characterInfo}

---

请将以上信息综合提炼，撰写一篇完整、优美、连贯的人物志（2-4段）：`

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ]
}

/**
 * 对提取的角色信息进行最终总结，生成精炼的人物志
 * @param extractedProfiles 从合并文本中提取的角色信息片段
 * @param targetCharacters 目标角色列表
 * @param executor AI 执行器
 * @param model 模型
 * @param temperature 温度参数
 * @param signal 取消信号
 * @returns 角色名 -> 最终人物志的映射
 */
async function synthesizeFinalCharacterBios(
  extractedProfiles: Record<string, string>,
  targetCharacters: string[],
  executor: any,
  model: Model,
  temperature: number,
  signal?: AbortSignal
): Promise<Record<string, string>> {
  const memoryService = novelCharacterMemoryService
  const finalBios: Record<string, string> = {}

  memoryService.updateState({
    logs: [
      ...memoryService.getState().logs,
      createLogEntry('info', '开始生成最终人物志总结', {
        characterCount: targetCharacters.length
      })
    ]
  })

  for (let i = 0; i < targetCharacters.length; i++) {
    const character = targetCharacters[i]
    const characterInfo = extractedProfiles[character]

    if (!characterInfo || characterInfo === '暂无相关信息') {
      finalBios[character] = `【${character}】\n\n原文中未出现该角色的相关信息。`
      continue
    }

    if (signal?.aborted) {
      throw new NovelCompressionError('用户取消了阅读任务')
    }

    try {
      memoryService.updateState({
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('info', `正在生成"${character}"的最终人物志 (${i + 1}/${targetCharacters.length})`, {
            character,
            index: i + 1,
            total: targetCharacters.length
          })
        ]
      })

      const response = await createCancellablePromise<GenerateTextResponse>(
        executor.generateText({
          model: model.id,
          messages: buildFinalSynthesisMessages(character, characterInfo),
          temperature,
          signal
        }),
        signal!
      )

      const bioText = response.text?.trim() ?? ''
      if (!bioText) {
        logger.warn(`Final synthesis returned empty text for character: ${character}`)
        // 降级使用提取的原始信息
        finalBios[character] = `【${character}】\n\n${characterInfo}`
      } else {
        finalBios[character] = `【${character}】\n\n${bioText}`
      }

      memoryService.updateState({
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('info', `完成"${character}"的人物志生成`, {
            character,
            length: bioText.length
          })
        ]
      })
    } catch (error) {
      logger.error(`Failed to synthesize bio for character: ${character}`, error as Error)
      // 降级使用提取的原始信息
      finalBios[character] = `【${character}】\n\n${characterInfo}`
      memoryService.updateState({
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('warning', `"${character}"人物志生成失败，使用提取信息`, {
            character,
            error: (error as Error).message
          })
        ]
      })
    }
  }

  memoryService.updateState({
    logs: [
      ...memoryService.getState().logs,
      createLogEntry('info', '所有角色人物志生成完成', {
        characterCount: targetCharacters.length
      })
    ]
  })

  return finalBios
}

// =================================================================
// 矩阵模式核心函数 (Character Plot Matrix Mode)
// =================================================================

/**
 * 解析显示名称：支持多个括号的多身份识别
 * 例如："石昊（小不点）" → {canonical: "石昊", aliases: ["小不点"]}
 * 例如："叶无辰(冥帝)(黑莲)" → {canonical: "叶无辰", aliases: ["冥帝", "黑莲"]}
 * 支持中英文括号混用和多种分隔符
 */
function parseDisplayName(displayName: string): {
  canonical: string
  aliases: string[]
} {
  const trimmed = displayName.trim()
  if (!trimmed) {
    return { canonical: '', aliases: [] }
  }

  // 提取主名称（第一个括号之前的部分）
  const mainNameMatch = trimmed.match(/^([^（(]+)/)
  const canonical = mainNameMatch ? mainNameMatch[1].trim() : trimmed
  
  // 提取所有括号中的别名（支持中英文括号）
  const aliases: string[] = []
  const aliasRegex = /[（(]([^）)]+)[）)]/g
  let match
  
  while ((match = aliasRegex.exec(trimmed)) !== null) {
    const aliasText = match[1].trim()
    // 支持多种分隔符：、（顿号），（中文逗号）,（英文逗号）
    // 注意：不要把“·（间隔号/中点）”当作分隔符，它常用于人名（如“伊丽莎白·洛朗”）。
    const splitAliases = aliasText.split(/[、，,]/).map(a => a.trim()).filter(Boolean)
    aliases.push(...splitAliases)
  }
  
  return { canonical, aliases }
}

type TargetCharacterAliasConfig = {
  target: string
  canonical: string
  explicitAliases: string[]
  strongAliases: string[]
  weakAliases: string[]
  promptAliases: string[]
}

const NAME_DOT_VARIANTS_REGEX = /[·・･•‧∙]/g

function normalizeNameForMatch(input: string): string {
  return (input || '')
    .normalize('NFKC')
    .replace(NAME_DOT_VARIANTS_REGEX, '·')
    .replace(/\s+/g, '')
    .trim()
}

function deriveNameVariantsFromCanonical(canonical: string): { dotless?: string; primary?: string } {
  const normalizedCanonical = normalizeNameForMatch(canonical)
  if (!normalizedCanonical.includes('·')) return {}

  const parts = normalizedCanonical.split('·').map((p) => p.trim()).filter(Boolean)
  if (parts.length < 2) return {}

  const primary = parts[0]
  const dotless = parts.join('')

  return { primary, dotless }
}

function buildTargetCharacterAliasConfigs(targetCharacters: string[]): TargetCharacterAliasConfig[] {
  const parsed = targetCharacters
    .map((target) => {
      const { canonical, aliases } = parseDisplayName(target)
      return { target, canonical: canonical.trim(), explicitAliases: aliases.map((a) => a.trim()).filter(Boolean) }
    })
    .filter((item) => item.canonical.length > 0)

  // 仅在“派生简称”在目标集合中唯一时才启用，避免多个“伊丽莎白·X”都派生为“伊丽莎白”造成误判。
  const derivedPrimaryCounts = new Map<string, number>()
  const derivedByTarget = new Map<string, { primary?: string; dotless?: string }>()

  for (const item of parsed) {
    const derived = deriveNameVariantsFromCanonical(item.canonical)
    derivedByTarget.set(item.target, derived)
    if (derived.primary && derived.primary.length >= 2) {
      derivedPrimaryCounts.set(derived.primary, (derivedPrimaryCounts.get(derived.primary) ?? 0) + 1)
    }
  }

  return parsed.map((item) => {
    const derived = derivedByTarget.get(item.target) ?? {}
    const strongAliases: string[] = []
    const weakAliases: string[] = []

    strongAliases.push(...item.explicitAliases)

    if (derived.dotless && derived.dotless.length >= 2 && derived.dotless !== normalizeNameForMatch(item.canonical)) {
      strongAliases.push(derived.dotless)
    }

    if (derived.primary && derived.primary.length >= 2) {
      if ((derivedPrimaryCounts.get(derived.primary) ?? 0) === 1) {
        strongAliases.push(derived.primary)
      } else {
        // 为了“不漏”，仍把派生简称作为弱别名：用于提示模型与提及判断，但避免强匹配造成误判归一化。
        weakAliases.push(derived.primary)
      }
    }

    const dedup = (values: string[]) => {
      const seen = new Set<string>()
      const result: string[] = []
      for (const v of values) {
        const s = v.trim()
        if (!s) continue
        if (seen.has(s)) continue
        seen.add(s)
        result.push(s)
      }
      return result
    }

    const strong = dedup(strongAliases).filter((a) => a !== item.canonical)
    const weak = dedup(weakAliases).filter((a) => a !== item.canonical && !strong.includes(a))
    const promptAliases = dedup([...strong, ...weak])

    return {
      target: item.target,
      canonical: item.canonical,
      explicitAliases: item.explicitAliases,
      strongAliases: strong,
      weakAliases: weak,
      promptAliases
    }
  })
}

/**
 * 查找已存在的角色（模糊匹配）
 */
function findExistingCharacter(
  characterMap: Map<string, Character>,
  canonical: string,
  aliases: string[]
): Character | undefined {
  // 1. 完全匹配正式名
  if (characterMap.has(canonical)) {
    return characterMap.get(canonical)
  }
  
  // 2. 遍历查找别名匹配
  for (const char of characterMap.values()) {
    // 正式名匹配别名
    if (char.aliases.includes(canonical)) {
      return char
    }
    
    // 别名匹配正式名
    if (aliases.includes(char.canonicalName)) {
      return char
    }
    
    // 别名互相匹配
    if (aliases.some(alias => char.aliases.includes(alias))) {
      return char
    }
  }
  
  return undefined
}

/**
 * 解析AI返回的角色剧情JSON（带容错）
 * 返回: { plots: Record<string, string>, parseMethod: 'direct' | 'extract' | 'regex' | 'failed' }
 */
function parseCharacterPlotJSON(responseText: string): {
  plots: Record<string, string>
  parseMethod: 'direct' | 'extract' | 'regex' | 'failed'
} {
  try {
    // 尝试直接解析
    const parsed = JSON.parse(responseText)
    if (typeof parsed === 'object' && parsed !== null) {
      return { plots: parsed, parseMethod: 'direct' }
    }
  } catch (e) {
    // JSON解析失败，尝试提取JSON部分
  }

  // 容错方案1：尝试提取 {...} 包裹的JSON部分
  const jsonMatch = responseText.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0])
      if (typeof parsed === 'object' && parsed !== null) {
        logger.info('成功从响应中提取JSON')
        return { plots: parsed, parseMethod: 'extract' }
      }
    } catch (e) {
      logger.warn('提取的JSON仍然解析失败')
    }
  }

  // 容错方案2：正则提取键值对
  logger.warn('使用正则表达式提取��色剧情', {
    responseLength: responseText.length,
    preview: responseText.substring(0, 300)
  })

  const plots: Record<string, string> = {}

  // 匹配 "key": "value" 格式（支持值中包含引号的转义）
  const regex = /"([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g
  let match

  while ((match = regex.exec(responseText)) !== null) {
    // 处理转义字符
    const value = match[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    plots[match[1]] = value
  }

  if (Object.keys(plots).length === 0) {
    logger.error('无法从响应中提取角色剧情', {
      responseText: responseText.substring(0, 500)
    })
    // 返回空对象和失败状态，让任务继续
    return { plots: {}, parseMethod: 'failed' }
  }

  logger.info(`正则提取成功，找到 ${Object.keys(plots).length} 个角色`)
  return { plots, parseMethod: 'regex' }
}

type CharacterPlotParseMethod = 'structured' | 'direct' | 'extract' | 'regex' | 'failed'

type StructuredCharacterPlots = Record<string, string | Record<string, string>>

const CHARACTER_PLOT_TEXT_SCHEMA = z.preprocess((value) => {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
      .filter((item) => item.length > 0)
      .join('；')
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return value
}, z.string())

const CHARACTER_PLOTS_BY_CHAPTER_SCHEMA = z.record(z.string(), CHARACTER_PLOT_TEXT_SCHEMA)

const CHARACTER_PLOTS_SCHEMA: z.ZodType<StructuredCharacterPlots> = z.record(
  z.string(),
  z.union([CHARACTER_PLOT_TEXT_SCHEMA, CHARACTER_PLOTS_BY_CHAPTER_SCHEMA])
)

function truncateForArtifact(text: string, maxLength: number = 1_000_000): string {
  if (!text) return ''
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength)
}

function safeStringifyForArtifact(value: unknown, maxLength: number = 1_000_000): string {
  try {
    const visited = new WeakSet<object>()
    const json = JSON.stringify(
      value,
      (_key, val) => {
        if (typeof val === 'object' && val !== null) {
          if (visited.has(val)) return '[Circular]'
          visited.add(val)
        }
        return val
      },
      2
    )
    return truncateForArtifact(json, maxLength)
  } catch (error) {
    return truncateForArtifact(String(value), maxLength)
  }
}

function getMentionedTargetCharacters(chunkText: string, targetCharacters: string[] | undefined): string[] {
  if (!targetCharacters || targetCharacters.length === 0) return []
  const text = chunkText || ''
  if (!text) return []

  const normalizedText = normalizeNameForMatch(text)
  const configs = buildTargetCharacterAliasConfigs(targetCharacters)
  const mentioned: string[] = []

  for (const config of configs) {
    const candidates = [config.canonical, ...config.strongAliases, ...config.weakAliases]
      .map((s) => s.trim())
      .filter((s) => s.length >= 2)
    const hit = candidates.some((name) => {
      if (text.includes(name)) return true
      const normalizedName = normalizeNameForMatch(name)
      return normalizedName.length >= 2 && normalizedText.includes(normalizedName)
    })
    if (hit) mentioned.push(config.target)
  }

  return mentioned
}

function normalizeStructuredCharacterPlots(structured: StructuredCharacterPlots): {
  plots: Record<string, string>
  plotsByChapter?: Record<string, Record<string, string>>
} {
  const plots: Record<string, string> = {}
  const plotsByChapter: Record<string, Record<string, string>> = {}

  for (const [characterName, value] of Object.entries(structured)) {
    if (typeof value === 'string') {
      plots[characterName] = value
      continue
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const chapters: Record<string, string> = {}
      for (const [chapterTitle, chapterPlot] of Object.entries(value)) {
        if (typeof chapterPlot === 'string') {
          chapters[chapterTitle] = chapterPlot
        } else if (chapterPlot === null || chapterPlot === undefined) {
          chapters[chapterTitle] = ''
        } else {
          chapters[chapterTitle] = String(chapterPlot)
        }
      }

      plotsByChapter[characterName] = chapters
      plots[characterName] = Object.entries(chapters)
        .map(([chapterTitle, chapterPlot]) => `【${chapterTitle}】${chapterPlot}`)
        .join('\n\n')
    }
  }

  return Object.keys(plotsByChapter).length > 0 ? { plots, plotsByChapter } : { plots }
}

function normalizeTargetCharacterPlots(
  plots: Record<string, string>,
  plotsByChapter: Record<string, Record<string, string>> | undefined,
  targetCharacters: string[] | undefined
): { plots: Record<string, string>; plotsByChapter?: Record<string, Record<string, string>> } {
  if (!targetCharacters || targetCharacters.length === 0) {
    return plotsByChapter ? { plots, plotsByChapter } : { plots }
  }

  const configs = buildTargetCharacterAliasConfigs(targetCharacters)
  const configByTarget = new Map(configs.map((c) => [c.target, c]))
  const keyVariantSetCache = new Map<string, Set<string>>()

  const buildKeyVariantSet = (displayName: string): Set<string> => {
    const cached = keyVariantSetCache.get(displayName)
    if (cached) return cached

    const { canonical, aliases } = parseDisplayName(displayName)
    const derived = deriveNameVariantsFromCanonical(canonical)
    const variants = [canonical, ...aliases, derived.dotless, derived.primary].filter(
      (v): v is string => typeof v === 'string' && v.trim().length >= 2
    )
    const normalized = new Set(variants.map((v) => normalizeNameForMatch(v)).filter((v) => v.length >= 2))
    keyVariantSetCache.set(displayName, normalized)
    return normalized
  }

  const buildTargetVariantSet = (target: string): Set<string> => {
    const config = configByTarget.get(target)
    if (!config) return new Set()
    const variants = [config.canonical, ...config.strongAliases].filter((v) => v.trim().length >= 2)
    return new Set(variants.map((v) => normalizeNameForMatch(v)).filter((v) => v.length >= 2))
  }

  // 指定人物模式：结果统一归一化为“只包含指定人物”的输出。
  // 这样即使某个分块人物未出场，也能用空字符串占位，保证分块被视为已完成且后续矩阵/导出行稳定。
  const normalizedPlots: Record<string, string> = {}
  const normalizedPlotsByChapter: Record<string, Record<string, string>> | undefined = plotsByChapter ? {} : undefined

  for (const target of targetCharacters) {
    const config = configByTarget.get(target)
    const targetCanonical = config?.canonical ?? parseDisplayName(target).canonical

    let matchedKey: string | undefined
    if (target in plots) {
      matchedKey = target
    } else if (targetCanonical in plots) {
      matchedKey = targetCanonical
    } else {
      const targetSet = buildTargetVariantSet(target)
      for (const key of Object.keys(plots)) {
        const keySet = buildKeyVariantSet(key)
        const hit = Array.from(targetSet).some((v) => keySet.has(v))
        if (hit) {
          matchedKey = key
          break
        }
      }
    }

    normalizedPlots[target] = matchedKey ? plots[matchedKey] ?? '' : ''

    if (normalizedPlotsByChapter) {
      if (matchedKey && plotsByChapter && matchedKey in plotsByChapter) {
        normalizedPlotsByChapter[target] = plotsByChapter[matchedKey] || {}
      } else {
        normalizedPlotsByChapter[target] = {}
      }
    }
  }

  return normalizedPlotsByChapter ? { plots: normalizedPlots, plotsByChapter: normalizedPlotsByChapter } : { plots: normalizedPlots }
}

/**
 * 解析AI返回的角色剧情JSON（支持章节模式）
 * 
 * 支持两种格式：
 * 1. 整段模式：{"角色": "剧情"}
 * 2. 章节模式：{"角色": {"章节标题": "剧情"}}
 * 
 * 返回:
 * - plots: 兼容旧格式的整段剧情（章节模式下合并所有章节）
 * - plotsByChapter: 按章节分组的剧情（仅章节模式有值）
 * - parseMethod: 解析方法
 */
function parseCharacterPlotJSONWithChapters(responseText: string): {
  plots: Record<string, string>
  plotsByChapter?: Record<string, Record<string, string>>
  parseMethod: CharacterPlotParseMethod
} {
  // 首先尝试解析 JSON
  let parsed: Record<string, unknown> | null = null
  let parseMethod: CharacterPlotParseMethod = 'failed'
  
  try {
    parsed = JSON.parse(responseText)
    parseMethod = 'direct'
  } catch (e) {
    // 尝试从代码块中提取 JSON（模型偶尔会输出 ```json ... ```）
    const fencedMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
    if (fencedMatch?.[1]) {
      try {
        parsed = JSON.parse(fencedMatch[1])
        parseMethod = 'extract'
      } catch {
        // 继续使用其他方案
      }
    }

    // 尝试提取 JSON 部分
    if (!parsed) {
      const start = responseText.indexOf('{')
      if (start >= 0) {
        // 尝试从后向前逐步收缩，避免“贪婪匹配到多个 JSON/尾部解释文字”导致解析失败
        const endPositions: number[] = []
        for (let i = responseText.length - 1; i > start; i -= 1) {
          if (responseText[i] === '}') endPositions.push(i)
        }

        const maxAttempts = Math.min(endPositions.length, 80)
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          const end = endPositions[attempt]
          try {
            parsed = JSON.parse(responseText.slice(start, end + 1))
            parseMethod = 'extract'
            break
          } catch {
            // continue
          }
        }
      }
    }
  }
  
  if (!parsed || typeof parsed !== 'object') {
    // 降级到原有的正则解析
    const result = parseCharacterPlotJSON(responseText)
    return { plots: result.plots, parseMethod: result.parseMethod }
  }
  
  // 检测是否为章节模式（值是对象而非字符串）
  const firstValue = Object.values(parsed)[0]
  const isChapterMode = firstValue && typeof firstValue === 'object' && !Array.isArray(firstValue)
  
  if (isChapterMode) {
    // 章节模式：{"角色": {"章节": "剧情"}}
    const plots: Record<string, string> = {}
    const plotsByChapter: Record<string, Record<string, string>> = {}
    
    for (const [character, chapters] of Object.entries(parsed)) {
      if (typeof chapters === 'object' && chapters !== null && !Array.isArray(chapters)) {
        // 存储按章节的剧情
        plotsByChapter[character] = chapters as Record<string, string>
        
        // 合并所有章节剧情为整段（用于兼容旧逻辑）
        const chapterPlots = Object.entries(chapters as Record<string, string>)
          .map(([chapterTitle, plot]) => `【${chapterTitle}】${plot}`)
          .join('\n\n')
        plots[character] = chapterPlots
      } else if (typeof chapters === 'string') {
        // 混合模式：部分角色是整段，部分是章节
        plots[character] = chapters
      }
    }
    
    logger.info('章节模式JSON解析成功', {
      characterCount: Object.keys(plots).length,
      chapterMode: true,
      parseMethod
    })
    
    return { plots, plotsByChapter, parseMethod }
  } else {
    // 整段模式：{"角色": "剧情"}
    const plots: Record<string, string> = {}
    
    for (const [character, plot] of Object.entries(parsed)) {
      if (typeof plot === 'string') {
        plots[character] = plot
      }
    }
    
    logger.info('整段模式JSON解析成功', {
      characterCount: Object.keys(plots).length,
      chapterMode: false,
      parseMethod
    })
    
    return { plots, parseMethod }
  }
}

// 默认并发限制：每个模型一次最多处理8个分块
const DEFAULT_MAX_CONCURRENT_CHUNKS_PER_MODEL = 8

/**
 * 并发控制处理函数
 * 限制同时执行的任务数量，返回所有任务的结果
 */
async function processConcurrently<T>(
  tasks: Array<() => Promise<T>>,
  maxConcurrency: number
): Promise<T[]> {
  const results: T[] = []
  const executing: Set<Promise<void>> = new Set()

  for (const [index, task] of tasks.entries()) {
    // 创建一个包装promise，在完成后自动从队列中移除
    const wrappedPromise = (async () => {
      try {
        results[index] = await task()
      } catch (error) {
        // 错误会在外层处理，这里只是确保promise能正确完成
        throw error
      }
    })()
    
    // 创建一个自动清理的promise
    const cleanupPromise = wrappedPromise.finally(() => {
      executing.delete(cleanupPromise)
    })

    executing.add(cleanupPromise)

    // 如果达到并发上限，等待任一任务完成
    if (executing.size >= maxConcurrency) {
      await Promise.race(executing)
    }
  }

  // 等待所有剩余任务完成
  await Promise.all(Array.from(executing))
  return results
}

/**
 * 构建角色剧情分析的Prompt（旧版，保留用于向后兼容）
 * @deprecated 使用 buildChapterAwarePrompt 替代
 */
// @ts-ignore - 保留用于向后兼容
function buildCharacterPlotAnalysisPrompt(
  chunk: string,
  chunkIndex: number,
  targetCharacters?: string[]
): ModelMessage[] {
  const targetConfigs =
    targetCharacters && targetCharacters.length > 0 ? buildTargetCharacterAliasConfigs(targetCharacters) : []
  const targetCanonicals = targetConfigs.map((c) => c.canonical)
  const uniqueTargetCanonicals = Array.from(new Set(targetCanonicals))
  const targetAliasMapText = targetConfigs
    .map((c) => `- ${c.canonical}：${c.promptAliases.length > 0 ? c.promptAliases.join('、') : '（无）'}`)
    .join('\\n')

  const systemPrompt = `你是小说剧情分析AI，专门负责从文本中提取角色剧情线索。

【任务目标】
${targetCharacters && targetCharacters.length > 0 
  ? `仅分析指定的目标角色（规范名）：${uniqueTargetCanonicals.join('、')}。\n\n【指定人物映射表】\n${targetAliasMapText || '（无）'}\n\n重要口径：\n- 文本中出现“规范名/别名/简称/称号”等任一称呼（见映射表）即算“提及”，也必须输出与该“提及”相关的剧情线索。\n- **输出JSON顶层key必须严格使用上述“规范名”，不得使用别名/简称/称号作为key。**\n- **输出只能包含这些规范名；每个规范名都必须输出一个字段。若本段未提及该人物，则值输出空字符串\"\"或空对象{}。**` 
  : '识别文本中的所有出场角色，并为每个角色撰写连贯的剧情摘要。'
}

【角色识别规则】
1. **识别标准**：
   - 必须有明确的人名（真名、别名、称号均可）
   - 必须实际出场（有对话、行动、心理描写等）
   - 排除：群体代称（"村民"）、人称代词（"他"）${targetCharacters && targetCharacters.length > 0 ? '' : '、仅被提及者'}

2. **同一角色判定**（重要）：
   - 同一人物的不同称呼必须合并为一个条目
   - 判断依据：相同姓名、明确的同名关系、特征描述一致
   - 示例：
     * "叶凝雪" = "白枼公主" = "凝雪" = "白发少女"（均指同一人）
     * "石昊" = "小不点" = "荒天帝"（均指同一人）
     * "萧炎" = "炎帝" = "小炎子"（均指同一人）

3. **角色命名格式**：
   - 格式：主名（别名1、别名2）
   - 主名选择：使用文中最正式或最常用的称呼
   - 别名排序：按重要性或出现频率降序
   - 示例：
     * "叶凝雪（白枼公主、凝雪）"
     * "石昊（小不点、荒）"
     * "萧炎（炎帝）"
   - 如果只有一个名字：直接使用，不加括号

【剧情摘要规则】
1. **叙事完整性**：
   - 采用连贯的叙事语言，非条目罗列
   - 体现事件的时间顺序、因果关系、逻辑链条
   - 使用连接词："随后"、"接着"、"因此"、"为了"、"在...之后"等

2. **信息要素**：
   - 时间：清晨、正午、夜晚、事件发生的时间节点
   - 地点：具体场所、地理位置
   - 对象：与谁互动、对话、冲突
   - 行为：做了什么、说了什么
   - 结果：导致了什么后果、达成了什么目标

3. **详略处理**：
   - 重要情节：详细记录，包含对话、动作、结果
   - 次要情节：简略概括，保留关键信息
   - 无字数限制：完整性优先于简洁性

4. **未出场处理**：
   - 该角色未在本段出场：输出空字符串 ""
   - 文本无任何角色：输出空对象 {}

${targetCharacters && targetCharacters.length > 0 
? `【指定角色识别规则】
1. **优先匹配**：
   - 优先识别指定角色（规范名）：${uniqueTargetCanonicals.join('、')}
   - 匹配时包含该角色的各种称呼形式（别名、称号等）
   - 示例：如果指定"张三"，也要识别"小张"、"张三哥"等

2. **输出限制**：
   - 只输出指定角色的剧情摘要
   - 即使文本中有其他角色出现，也忽略不处理
   - 如果指定角色均未出场，输出空对象{}` 
: ''}

【输出格式要求】
**严格输出纯JSON，不含任何其他内容（无代码块标记、无说明文字）**

正确格式：
{"叶凝雪（白枼公主、凝雪）": "清晨在雪域深处修炼寒冰神功，随后感知到外敌入侵，立即赶往边境，与入侵的魔族大军展开激战，经过一番苦战后击退敌军，但自身也身受重伤，不得不返回宫殿疗伤", "石昊（小不点）": "在石村柳树下聆听柳神讲述上古秘辛，得知关于祖地的线索后，决定前往探索，途中遭遇凶兽袭击，激战后成功斩杀凶兽，获得一块骨符"}

错误格式（禁止）：
\`\`\`json
{"角色": "剧情"}
\`\`\`

或

分析结果如下：
{"角色": "剧情"}

【质量标准】

❌ 低质量示例：
{
  "叶凝雪": "修炼；战斗；受伤",
  "白枼公主": "击退敌军"
}
问题：同一人物被拆分；缺乏叙事性；过度精简

❌ 低质量示例：
{
  "叶凝雪（白枼公主）": "在雪域修炼；在边境战斗；返回宫殿"
}
问题：简单列举，无逻辑连接

✅ 高质量示例：
{
  "叶凝雪（白枼公主、凝雪）": "清晨在雪域深处修炼寒冰神功，随后感知到外敌入侵，立即赶往边境，与入侵的魔族大军展开激战，经过一番苦战后击退敌军，但自身也身受重伤，不得不返回宫殿疗伤"
}
优点：同一人物合并；时间顺序清晰；因果关系明确；细节完整`

  const userPrompt = `请分析第${chunkIndex + 1}节文本${targetCharacters && targetCharacters.length > 0 
  ? `，重点关注指定角色（规范名）：${uniqueTargetCanonicals.join('、')}` 
  : '，提取所有角色及其剧情'
}。

**特别注意**：
1. 同一角色的不同称呼必须合并（如"叶凝雪"和"白枼公主"是同一人）
2. 剧情描述要有逻辑连贯性，体现时间顺序和因果关系
3. 直接输出JSON，不要任何额外文字
${targetCharacters && targetCharacters.length > 0 
  ? `4. 只分析指定角色，忽略其他角色`
  : ''
}

---文本内容---
${chunk}

---输出JSON---`

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ]
}

/**
 * 提取并合并角色列表
 */
function extractUnifiedCharacterList(
  chunkResults: ChunkCharacterPlotAnalysis[]
): Character[] {
  const characterMap = new Map<string, Character>()
  
  logger.info('开始合并角色列表', {
    totalChunks: chunkResults.length
  })
  
  chunkResults.forEach((chunk) => {
    Object.keys(chunk.characterPlots).forEach((displayName) => {
      // 解析显示名称
      const { canonical, aliases } = parseDisplayName(displayName)
      
      // 查找是否已存在（通过名称或别名匹配）
      const existing = findExistingCharacter(characterMap, canonical, aliases)
      
      if (existing) {
        // 合并别名
        const newAliases = [...new Set([...existing.aliases, ...aliases])]
        existing.aliases = newAliases
        
        // 更新显示名（选择最完整的）
        if (displayName.includes('（') && !existing.displayName.includes('（')) {
          existing.displayName = displayName
        }
        
        logger.debug(`合并角色`, {
          canonical,
          existingDisplay: existing.displayName,
          newDisplay: displayName,
          mergedAliases: newAliases
        })
      } else {
        // 新建角色
        const newChar: Character = {
          displayName,
          canonicalName: canonical,
          aliases,
          firstAppearance: chunk.chunkIndex
        }
        characterMap.set(canonical, newChar)
        
        logger.debug(`新增角色`, newChar)
      }
    })
  })
  
  // 按首次出场排序
  const sortedCharacters = Array.from(characterMap.values())
    .sort((a, b) => a.firstAppearance - b.firstAppearance)
  
  logger.info('角色列表合并完成', {
    totalCharacters: sortedCharacters.length,
    characters: sortedCharacters.map(c => c.displayName)
  })
  
  return sortedCharacters
}

/**
 * 构建角色-剧情矩阵
 */
function buildCharacterPlotMatrix(
  characters: Character[],
  chunkResults: ChunkCharacterPlotAnalysis[]
): CharacterPlotMatrix {
  const matrix: string[][] = []
  
  logger.info('开始构建角色-剧情矩阵', {
    characters: characters.length,
    chunks: chunkResults.length
  })
  
  characters.forEach((char, charIndex) => {
    matrix[charIndex] = []
    
    chunkResults.forEach((chunk, chunkIndex) => {
      // 尝试多种方式匹配角色名（使用 undefined 作为未找到标记）
      let plot: string | undefined = undefined
      
      // 1. 尝试完整显示名
      if (char.displayName in chunk.characterPlots) {
        plot = chunk.characterPlots[char.displayName]
      }
      
      // 2. 尝试正式名
      if (plot === undefined && char.canonicalName in chunk.characterPlots) {
        plot = chunk.characterPlots[char.canonicalName]
      }
      
      // 3. 尝试所有别名
      if (plot === undefined) {
        for (const alias of char.aliases) {
          // 尝试纯别名
          if (alias in chunk.characterPlots) {
            plot = chunk.characterPlots[alias]
            break
          }
          
          // 尝试"正式名（别名）"格式（中文括号）
          const combinedKeyCN = `${char.canonicalName}（${alias}）`
          if (combinedKeyCN in chunk.characterPlots) {
            plot = chunk.characterPlots[combinedKeyCN]
            break
          }
          
          // 尝试"正式名(别名)"格式（英文括号）
          const combinedKeyEN = `${char.canonicalName}(${alias})`
          if (combinedKeyEN in chunk.characterPlots) {
            plot = chunk.characterPlots[combinedKeyEN]
            break
          }
        }
      }
      
      // 4. 反向模糊匹配
      if (plot === undefined) {
        for (const key of Object.keys(chunk.characterPlots)) {
          const { canonical: keyCanonical, aliases: keyAliases } = parseDisplayName(key)
          
          if (
            keyCanonical === char.canonicalName ||
            keyAliases.includes(char.canonicalName) ||
            char.aliases.includes(keyCanonical) ||
            keyAliases.some(ka => char.aliases.includes(ka))
          ) {
            plot = chunk.characterPlots[key]
            break
          }
        }
      }
      
      // 使用 ?? 确保空字符串也能正确处理
      matrix[charIndex][chunkIndex] = plot ?? ''
    })
  })
  
  return {
    characters,
    chunks: chunkResults,
    matrix,
    metadata: {
      totalCharacters: characters.length,
      totalChunks: chunkResults.length,
      generatedAt: Date.now()
    }
  }
}

/**
 * 生成Markdown表格
 */
function generateMarkdownTable(matrixData: CharacterPlotMatrix): string {
  const { characters, chunks, matrix } = matrixData
  
  // Markdown转义函数：转义管道符和换行符
  const escapeMd = (str: string): string => {
    return str.replace(/\|/g, '\\|').replace(/\n/g, '<br>')
  }
  
  let table = `| 人物 | ${chunks.map(c => escapeMd(c.chunkName)).join(' | ')} |\n`
  table += `|------|${chunks.map(() => '--------').join('|')}|\n`
  
  characters.forEach((char, charIndex) => {
    const cells = matrix[charIndex].map(plot => escapeMd(plot || ''))
    table += `| ${escapeMd(char.displayName)} | ${cells.join(' | ')} |\n`
  })
  
  return table
}

/**
 * 生成CSV格式
 */
function generateCSV(matrixData: CharacterPlotMatrix): string {
  const { characters, chunks, matrix } = matrixData
  
  const escapeCSV = (str: string): string => {
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`
    }
    return str
  }
  
  let csv = `人物,${chunks.map(c => escapeCSV(c.chunkName)).join(',')}\n`
  
  characters.forEach((char, charIndex) => {
    const row = [escapeCSV(char.displayName)]
    matrix[charIndex].forEach(plot => {
      row.push(escapeCSV(plot || ''))
    })
    csv += row.join(',') + '\n'
  })
  
  return csv
}

/**
 * 生成HTML表格（带大小限制保护）
 */
function generateHTMLTable(matrixData: CharacterPlotMatrix): string {
  const { characters, chunks, matrix, metadata } = matrixData
  
  // 检查矩阵规模，防止浏览器崩溃
  const totalCells = characters.length * chunks.length
  const MAX_CELLS = 10000  // 最大10000个单元格
  const MAX_CHARACTERS = 20  // 最多显示20个角色
  const MAX_CHUNKS = 50      // 最多显示50个分块
  
  let limitedCharacters = characters
  let limitedChunks = chunks
  let limitedMatrix = matrix
  let isLimited = false
  
  if (totalCells > MAX_CELLS || characters.length > MAX_CHARACTERS || chunks.length > MAX_CHUNKS) {
    logger.warn(`矩阵过大 (${totalCells} cells, ${characters.length} chars, ${chunks.length} chunks)，生成简化HTML`)
    isLimited = true
    
    // 限制角色数量
    if (characters.length > MAX_CHARACTERS) {
      limitedCharacters = characters.slice(0, MAX_CHARACTERS)
      limitedMatrix = matrix.slice(0, MAX_CHARACTERS)
    }
    
    // 限制分块数量
    if (chunks.length > MAX_CHUNKS) {
      limitedChunks = chunks.slice(0, MAX_CHUNKS)
      limitedMatrix = limitedMatrix.map(row => row.slice(0, MAX_CHUNKS))
    }
  }
  
  const escapeHTML = (str: string): string => {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }
  
  let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>小说人物志矩阵</title>
  <style>
    body { font-family: "Microsoft YaHei", Arial, sans-serif; margin: 20px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background-color: #4CAF50; color: white; position: sticky; top: 0; }
    tr:nth-child(even) { background-color: #f2f2f2; }
    tr:hover { background-color: #ddd; }
    .empty { color: #999; }
    .char-name { font-weight: bold; background-color: #f9f9f9; }
    .warning { 
      background-color: #fff3cd; 
      border: 1px solid #ffc107; 
      padding: 12px; 
      margin-bottom: 16px;
      border-radius: 4px;
    }
  </style>
</head>
<body>
  <h1>小说人物志矩阵</h1>
  <p>生成时间：${new Date(metadata.generatedAt).toLocaleString('zh-CN')}</p>
  <p>总角色数：${metadata.totalCharacters} | 总节数：${metadata.totalChunks}</p>`

  if (isLimited) {
    html += `
  <div class="warning">
    <strong>⚠️ 注意：</strong>矩阵数据过大（${totalCells}个单元格），HTML仅显示前${limitedCharacters.length}个角色和前${limitedChunks.length}个分块。
    <br>建议使用CSV或JSON格式在Excel/专业工具中查看完整数据。
  </div>`
  }
  
  html += `
  <table>
    <thead>
      <tr>
        <th>人物</th>
${limitedChunks.map(c => `        <th>${escapeHTML(c.chunkName)}</th>`).join('\n')}
      </tr>
    </thead>
    <tbody>
`
  
  limitedCharacters.forEach((char, charIndex) => {
    html += `      <tr>\n`
    html += `        <td class="char-name">${escapeHTML(char.displayName)}</td>\n`
    limitedMatrix[charIndex].forEach(plot => {
      if (plot) {
        html += `        <td>${escapeHTML(plot)}</td>\n`
      } else {
        html += `        <td class="empty">-</td>\n`
      }
    })
    html += `      </tr>\n`
  })
  
  html += `    </tbody>
  </table>
</body>
</html>`
  
  return html
}

/**
 * 生成JSON格式
 */
function generateJSON(matrixData: CharacterPlotMatrix): string {
  return JSON.stringify(matrixData, null, 2)
}

// =================================================================
// 断点续传相关函数 (Resume Support)
// =================================================================

/**
 * 保存单个分块分析结果
 */
async function saveChunkCharacterAnalysis(
  outputDir: string,
  chunkIndex: number,
  chunkName: string,
  characterPlots: Record<string, string>,
  metadata: {
    modelId: string
    temperature: number
    durationMs: number
  }
): Promise<void> {
  const chunkFileName = `chunk_${String(chunkIndex + 1).padStart(3, '0')}.json`
  const chunkFilePath = path.join(outputDir, chunkFileName)

  const chunkData: ChunkAnalysisFile = {
    chunkIndex,
    chunkName,
    chunkHash: '',  // 保留字段以兼容类型定义，但不使用
    characterPlots,
    metadata: {
      analyzedAt: Date.now(),
      ...metadata
    }
  }

  await fs.writeFile(chunkFilePath, JSON.stringify(chunkData, null, 2), 'utf-8')
  logger.debug(`保存分块分析结果: ${chunkFileName}`, {
    chunkIndex,
    characterCount: Object.keys(characterPlots).length
  })
}

/**
 * 检测已存在的分块JSON文件（断点续传）
 * 简单方案：只检查文件是否存在，存在即视为已完成
 */
async function detectExistingChunks(
  outputDir: string,
  totalChunks: number
): Promise<{
  existingChunks: Set<number>
  existingResults: Map<number, ChunkCharacterPlotAnalysis>
}> {
  const existingChunks = new Set<number>()
  const existingResults = new Map<number, ChunkCharacterPlotAnalysis>()

  try {
    const files = await fs.readdir(outputDir)

    for (const file of files) {
      const match = file.match(/^chunk_(\d{3})\.json$/)
      if (match) {
        const chunkIndex = parseInt(match[1], 10) - 1

        if (chunkIndex >= 0 && chunkIndex < totalChunks) {
          try {
            const chunkFilePath = path.join(outputDir, file)
            const chunkContent = await fs.readFile(chunkFilePath, 'utf-8')
            const chunkData: ChunkAnalysisFile = JSON.parse(chunkContent)

            // 只要文件存在且能解析，就认为已完成
            if (chunkData.characterPlots && typeof chunkData.characterPlots === 'object') {
              existingChunks.add(chunkIndex)
              existingResults.set(chunkIndex, {
                chunkIndex,
                chunkName: chunkData.chunkName || `第${chunkIndex + 1}节`,
                characterPlots: chunkData.characterPlots
              })
            }
          } catch (error) {
            logger.warn(`读取分块文件失败，将重新生成: ${file}`, error as Error)
            // 文件损坏，删除它，稍后重新生成
            try {
              await fs.unlink(path.join(outputDir, file))
            } catch (e) {
              // 忽略删除失败
            }
          }
        }
      }
    }

    if (existingChunks.size > 0) {
      logger.info(`检测到 ${existingChunks.size}/${totalChunks} 个已完成分块，将跳过`)
    }

  } catch (error) {
    logger.debug('输出目录不存在或为空，将全新生成')
  }

  return { existingChunks, existingResults }
}

/**
 * 模型池健康度管理
 */
interface ModelHealth {
  modelId: string
  successCount: number
  failureCount: number
  totalAttempts: number
  successRate: number
  lastError?: string
  isHealthy: boolean
}

/**
 * 使用模型池并发分析所有分块（支持断点续传和模型自动切换）
 * @param chapterChunks 可选的章节分块信息，用于章节模式下传递章节标题给 AI
 */
async function analyzeAllChunksWithModelPool(
  chunks: string[],
  models: Model[],
  providerConfigs: { modelId: string; providerId: ProviderId; options: any }[],
  temperature: number,
  maxConcurrentPerModel: number,  // 每个模型的最大并发数
  outputDir: string,
  signal?: AbortSignal,
  targetCharacters?: string[],
  chapterChunks?: ChapterChunk[]  // 新增：章节分块信息
): Promise<ChunkCharacterPlotAnalysis[]> {
  const memoryService = novelCharacterMemoryService
  const totalChunks = chunks.length

  // JSON解析统计
  const parseStats: Record<CharacterPlotParseMethod, number> = {
    structured: 0,
    direct: 0,
    extract: 0,
    regex: 0,
    failed: 0
  }

  // 模型健康度追踪（使用索引作为key，支持同名模型）
  const modelHealthMap = new Map<string, ModelHealth>()
  models.forEach((model, index) => {
    const healthKey = `${index}`  // 使用索引作为唯一标识
    modelHealthMap.set(healthKey, {
      modelId: model.id,
      successCount: 0,
      failureCount: 0,
      totalAttempts: 0,
      successRate: 1.0,
      isHealthy: true
    })
    logger.info(`初始化健康度追踪 #${index}`, {
      healthKey,
      modelId: model.id,
      modelName: model.name
    })
  })

  // 辅助函数：生成模型健康度统计数据
  const generateModelHealthStats = () => {
    return Array.from(modelHealthMap.entries()).map(([healthKey, health]) => {
      const executorIndex = parseInt(healthKey, 10)
      const executor = modelExecutors[executorIndex]
      return {
        index: executorIndex,
        model: executor?.model.name || health.modelId,
        provider: executor?.providerId || 'unknown',
        baseUrl: executor?.providerOptions?.baseURL?.slice(0, 30) || 'N/A',
        successRate: `${Math.round(health.successRate * 100)}%`,
        successes: health.successCount,
        failures: health.failureCount,
        total: health.totalAttempts,
        healthy: health.isHealthy,
        lastError: health.lastError // 包含最后一次失败的错误信息
      }
    })
  }

  // 创建所有模型的执行器（使用索引来支持同名模型）
  // 清理所有已注册的 provider，确保状态一致性
  clearAllProviders()
  const modelExecutors: ModelExecutor[] = []

  for (let index = 0; index < providerConfigs.length; index++) {
    const config = providerConfigs[index]
    const model = models[index]  // 使用索引匹配对应的model
    if (!model) {
      logger.warn(`模型索引 ${index} 没有对应的模型配置`, { config })
      continue
    }

    // 注册 provider
    await createAndRegisterProvider(config.providerId, config.options)
    const executor = createExecutor(config.providerId, { ...config.options, mode: 'chat' })

    modelExecutors.push({
      model,
      provider: null as any,
      executor,
      providerId: config.providerId,
      providerOptions: config.options,
      index  // 存储索引用于健康度追踪
    })
    
    logger.info(`初始化模型执行器 #${index}`, {
      index,
      modelId: model.id,
      modelName: model.name,
      providerId: config.providerId
    })
  }

  logger.info('模型池已初始化', {
    modelCount: modelExecutors.length,
    models: modelExecutors.map(e => e.model.name)
  })

  // 初始化模型健康度统计状态
  const initialHealthStats = generateModelHealthStats()
  memoryService.updateState({
    modelHealthStats: initialHealthStats,
    logs: [
      ...memoryService.getState().logs,
      createLogEntry('info', `【模型池】初始化 ${modelExecutors.length} 个模型`, {
        models: modelExecutors.map(e => ({ id: e.model.id, name: e.model.name }))
      })
    ]
  })

  // 1. 检测已存在的分块文件
  const { existingChunks, existingResults } = await detectExistingChunks(outputDir, totalChunks)

  if (existingChunks.size > 0) {
    memoryService.updateState({
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', `检测到 ${existingChunks.size}/${totalChunks} 个已完成分块，将跳过`, {
          existingCount: existingChunks.size,
          totalChunks
        })
      ]
    })
  }

  // 2. 筛选待处理分块
  const pendingIndexes: number[] = []
  for (let i = 0; i < totalChunks; i++) {
    if (!existingChunks.has(i)) {
      pendingIndexes.push(i)
    }
  }

  logger.info('开始处理待分析分块', {
    pending: pendingIndexes.length,
    existing: existingChunks.size,
    total: totalChunks
  })

  // 3. 初始化结果数组
  const results: (ChunkCharacterPlotAnalysis | undefined)[] = Array.from({ length: totalChunks })

  // 填充已有结果
  for (const [index, result] of existingResults.entries()) {
    results[index] = result
  }

  // 原子计数器，避免并发race condition
  let completedCount = existingChunks.size

  // 分块重试次数追踪（避免无限重试）
  const chunkRetryCount = new Map<number, number>()
  const MAX_CHUNK_RETRIES = modelExecutors.length * 3  // 每个模型最多尝试3次

  // 4. 初始任务均匀分配给每个模型
  const modelCount = modelExecutors.length
  const tasksPerModel = Math.floor(pendingIndexes.length / modelCount)
  const remainingTasks = pendingIndexes.length % modelCount
  
  // 为每个模型分配初始任务
  const initialTasksPerModel: number[][] = []
  let offset = 0
  
  for (let i = 0; i < modelCount; i++) {
    const taskCount = tasksPerModel + (i < remainingTasks ? 1 : 0)
    initialTasksPerModel.push(pendingIndexes.slice(offset, offset + taskCount))
    offset += taskCount
  }
  
  // 共享队列（用于失败任务重分配）
  const sharedQueue: number[] = []
  
  // 记录每个分块最近失败的模型，避免同模型重复尝试同一失败任务
  const chunkFailedModels = new Map<number, Set<number>>()  // chunkIndex -> Set<modelIndex>
  const chunkFailedModelsMutex = new AsyncMutex()  // 保护chunkFailedModels
  
  logger.info('[MultiModel] Per-Model Worker架构 - 初始任务均匀分配', {
    maxConcurrentPerModel: maxConcurrentPerModel,
    modelCount: modelExecutors.length,
    totalConcurrency: modelExecutors.length * maxConcurrentPerModel,
    totalPendingChunks: pendingIndexes.length,
    tasksPerModel,
    remainingTasks,
    distribution: initialTasksPerModel.map((tasks, idx) => ({
      model: idx,
      taskCount: tasks.length,
      taskRange: tasks.length > 0 ? `${tasks[0]}-${tasks[tasks.length - 1]}` : 'none'
    }))
  })

  memoryService.updateState({
    logs: [
      ...memoryService.getState().logs,
      createLogEntry('info', `【模型池】Per-Model Worker架构启动 - 均匀分配`, {
        modelCount: modelExecutors.length,
        perModelConcurrency: maxConcurrentPerModel,
        totalConcurrency: modelExecutors.length * maxConcurrentPerModel,
        totalPendingChunks: pendingIndexes.length,
        tasksPerModel,
        distribution: initialTasksPerModel.map((tasks, idx) => ({
          modelIndex: idx,
          modelName: modelExecutors[idx].model.name,
          assignedTasks: tasks.length
        }))
      })
    ]
  })

  // 5. 创建互斥锁保护共享资源
  const queueMutex = new AsyncMutex()  // 保护 sharedQueue
  const initialTasksMutexes = modelExecutors.map(() => new AsyncMutex())  // 每个模型一个锁保护其 initialTasks

  // 全局Worker状态追踪（用于协调退出）
  const workerState = {
    activeSlotCount: 0,  // 当前正在处理任务的Slot数量
    totalSlots: modelExecutors.length * maxConcurrentPerModel,  // 总Slot数
    shouldTerminate: false  // 是否应该全局终止
  }
  const workerStateMutex = new AsyncMutex()  // 保护workerState

  // 辅助函数：检查是否所有健康模型的健康度都为0
  const hasAnyHealthyModel = () => {
    return Array.from(modelHealthMap.values()).some(h => h.isHealthy)
  }

  // 6. 为每个模型创建独立的worker，并发运行
  const workerPromises = modelExecutors.map((executor, idx) =>
    runModelWorker(
      executor,
      initialTasksPerModel[idx],  // 专属初始任务
      sharedQueue,                // 共享失败任务队列
      queueMutex,                 // 共享队列互斥锁
      initialTasksMutexes[idx],   // 该模型的 initialTasks 互斥锁
      chunks,
      temperature,
      outputDir,
      modelHealthMap,
      results,
      () => ++completedCount,  // 原子递增函数
      totalChunks,
      parseStats,
      signal,
      memoryService,
      chunkRetryCount,
      MAX_CHUNK_RETRIES,
      maxConcurrentPerModel,      // 每个模型的最大并发数
      generateModelHealthStats,   // 传入健康度统计生成函数
      workerState,                // 全局Worker状态
      workerStateMutex,           // Worker状态互斥锁
      hasAnyHealthyModel,         // 健康模型检查函数
      chunkFailedModels,          // 分块失败模型追踪
      chunkFailedModelsMutex,     // 失败模型追踪互斥锁
      targetCharacters,           // 目标角色列表
      chapterChunks               // 章节分块信息
    )
  )

  // 等待所有worker完成
  const workerResults = await Promise.allSettled(workerPromises)

  // 检查worker结果
  const failedWorkers = workerResults.filter(r => r.status === 'rejected')
  if (failedWorkers.length > 0) {
    logger.warn(`${failedWorkers.length}/${modelExecutors.length} 个worker失败`, {
      failures: failedWorkers.map((r, i) => ({
        modelIndex: i,
        reason: (r as PromiseRejectedResult).reason
      }))
    })
  }

  // 7. 检查完成情况
  const successfulResults = results.filter((r): r is ChunkCharacterPlotAnalysis => r !== undefined)
  const failedCount = totalChunks - successfulResults.length

  // 生成并更新最终的模型性能统计
  const finalModelStats = generateModelHealthStats()

  logger.info('模型池性能统计', { models: finalModelStats })
  memoryService.updateState({
    modelHealthStats: finalModelStats,
    logs: [
      ...memoryService.getState().logs,
      createLogEntry('info', '【模型池】性能统计', {
        models: finalModelStats
      })
    ]
  })

  if (successfulResults.length === 0) {
    throw new NovelCompressionError('所有分块分析都失败了')
  }

  if (failedCount > 0) {
    const failedIndexes = Array.from({ length: totalChunks }, (_, i) => i)
      .filter(i => results[i] === undefined)

    const failureDetails = memoryService.getState().chunkSummaries
      .filter(cs => cs.status === 'error' && cs.errorMessage)
      .map(cs => `第${cs.index + 1}节: ${cs.errorMessage}`)

    memoryService.updateState({
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('error', `任务失败：有 ${failedCount} 个分块未能生成，请使用断点续传重新运行`, {
          successfulChunks: successfulResults.length,
          failedChunks: failedCount,
          totalChunks,
          failedIndexes: failedIndexes.map(i => i + 1),
          failures: failureDetails
        })
      ]
    })

    // 发送失败通知
    try {
      new Notification({
        title: '矩阵分析失败',
        body: `${failedCount} 个分块失败，请重新运行以续传`,
        silent: false
      }).show()
    } catch (notifError) {
      logger.warn('Failed to show failure notification', notifError as Error)
    }

    // 抛出错误，阻止继续执行
    throw new NovelCompressionError(
      `矩阵分析未完成：${failedCount}/${totalChunks} 个分块失败。已生成的分块已保存，请重新运行任务以断点续传。`,
      {
        successfulChunks: successfulResults.length,
        failedChunks: failedCount,
        totalChunks,
        failedIndexes: failedIndexes.map(i => i + 1),
        failureDetails,
        canResume: true,
        outputDir
      }
    )
  }

  // 记录JSON解析统计
  logger.info('JSON解析统计', parseStats)
  memoryService.updateState({
    logs: [
      ...memoryService.getState().logs,
      createLogEntry('info', 'JSON解析质量统计', {
        direct: parseStats.direct,
        extract: parseStats.extract,
        regex: parseStats.regex,
        failed: parseStats.failed,
        totalParsed: parseStats.direct + parseStats.extract + parseStats.regex,
        directRate: totalChunks > 0 ? `${Math.round((parseStats.direct / totalChunks) * 100)}%` : '0%'
      })
    ]
  })

  return successfulResults.sort((a, b) => a.chunkIndex - b.chunkIndex)
}

/**
 * Per-Model Worker: 每个模型独立运行，最多8个并发
 * 
 * 核心设计：
 * - 每个worker有8个"任务槽"（类似goroutine）
 * - 阶段1: 处理专属初始任务（均匀分配）
 * - 阶段2: 处理共享队列中的失败任务
 * - 健康模型快速处理，自动获得更多任务
 * - 总并发数 = n × 8
 * 
 * 退出条件：
 * - 队列为空 && (所有模型不健康 || 所有Worker空闲 || 所有任务完成)
 */
async function runModelWorker(
  executor: ModelExecutor,
  initialTasks: number[],      // 专属初始任务
  sharedQueue: number[],        // 共享失败任务队列
  queueMutex: AsyncMutex,       // 队列访问互斥锁
  initialTasksMutex: AsyncMutex, // initialTasks 访问互斥锁
  chunks: string[],
  temperature: number,
  outputDir: string,
  modelHealthMap: Map<string, ModelHealth>,
  results: (ChunkCharacterPlotAnalysis | undefined)[],
  incrementCompleted: () => number,
  totalChunks: number,
  parseStats: { direct: number; extract: number; regex: number; failed: number },
  signal: AbortSignal | undefined,
  memoryService: typeof novelCharacterMemoryService,
  chunkRetryCount: Map<number, number>,
  maxChunkRetries: number,
  maxConcurrentPerModel: number,  // 每个模型的最大并发数
  generateModelHealthStats: () => any[],  // 生成健康度统计的函数
  workerState: { activeSlotCount: number; totalSlots: number; shouldTerminate: boolean },  // 全局Worker状态
  workerStateMutex: AsyncMutex,  // Worker状态互斥锁
  hasAnyHealthyModel: () => boolean,  // 检查是否有健康模型
  chunkFailedModels: Map<number, Set<number>>,  // 分块失败模型追踪
  chunkFailedModelsMutex: AsyncMutex,  // 失败模型追踪互斥锁
  targetCharacters?: string[],  // 目标角色列表
  chapterChunks?: ChapterChunk[]  // 新增：章节分块信息
): Promise<void> {
  const healthKey = `${executor.index}`
  const modelHealth = modelHealthMap.get(healthKey)!

  // 日志批处理缓冲区，减少状态更新频率
  const logBuffer: CompressionLogEntry[] = []
  const LOG_BATCH_SIZE = 10  // 每10条日志批量更新一次

  const flushLogs = () => {
    if (logBuffer.length > 0) {
      memoryService.updateState({
        logs: [...memoryService.getState().logs, ...logBuffer]
      })
      logBuffer.length = 0  // 清空缓冲区
    }
  }

  const addLog = (entry: CompressionLogEntry) => {
    logBuffer.push(entry)
    if (logBuffer.length >= LOG_BATCH_SIZE) {
      flushLogs()
    }
  }

  logger.info(`Worker #${executor.index} 启动`, {
    model: executor.model.name,
    maxConcurrency: maxConcurrentPerModel,
    initialTasksCount: initialTasks.length,
    taskRange: initialTasks.length > 0 ? `${initialTasks[0] + 1}-${initialTasks[initialTasks.length - 1] + 1}` : 'none',
    healthKey
  })

  addLog(createLogEntry('info', `Worker #${executor.index} ${executor.model.name} 启动`, {
    workerIndex: executor.index,
    model: executor.model.name,
    initialTasks: initialTasks.length,
    taskRange: initialTasks.length > 0 ? `${initialTasks[0] + 1}-${initialTasks[initialTasks.length - 1] + 1}` : 'none'
  }))

  // 创建任务槽，每个槽持续从共享队列获取任务
  const workerSlots: Promise<void>[] = []
  
  for (let slotId = 0; slotId < maxConcurrentPerModel; slotId++) {
    const slotPromise = (async () => {
      logger.info(`Worker #${executor.index} Slot ${slotId} 启动`)
      
      while (true) {
        if (signal?.aborted) {
          logger.info(`Worker #${executor.index} Slot ${slotId} 收到取消信号`)
          break
        }

        // 检查模型健康度 - 不健康立即停止，释放资源给其他模型
        if (!modelHealth.isHealthy) {
          // 使用互斥锁保护任务转移操作，避免竞态条件
          await initialTasksMutex.runExclusive(async () => {
            if (initialTasks.length > 0) {
              const tasksToTransfer = [...initialTasks]
              initialTasks.length = 0  // 先清空，避免其他Slot同时访问

              // 使用队列锁保护 sharedQueue 的写入
              await queueMutex.runExclusive(async () => {
                sharedQueue.push(...tasksToTransfer)
              })

              logger.warn(`Worker #${executor.index} Slot ${slotId} 将${tasksToTransfer.length}个未完成任务转移到共享队列`, {
                transferredTasks: tasksToTransfer.length
              })
            }
          })
          
          logger.warn(`Worker #${executor.index} Slot ${slotId} 模型不健康，停止工作，释放资源`, {
            failureCount: modelHealth.failureCount,
            successRate: `${Math.round(modelHealth.successRate * 100)}%`,
            sharedQueueLength: sharedQueue.length
          })

          addLog(createLogEntry('warning', `Worker #${executor.index} Slot ${slotId} 因健康度下降停止，未完成任务转移到共享队列`, {
            model: executor.model.name,
            workerIndex: executor.index,
            slotId,
            failureCount: modelHealth.failureCount,
            successRate: `${Math.round(modelHealth.successRate * 100)}%`,
            sharedQueueLength: sharedQueue.length
          }))
          flushLogs()  // 立即刷新日志，因为worker即将退出
          break
        }

        // 使用互斥锁原子地获取任务：先从专属队列，再从共享队列
        const taskInfo = await initialTasksMutex.runExclusive(async () => {
          let chunkIndex = initialTasks.shift()
          let fromSharedQueue = false

          if (chunkIndex === undefined) {
            // 专属队列为空，尝试从共享队列获取
            chunkIndex = await queueMutex.runExclusive(async () => {
              return sharedQueue.shift()
            })
            fromSharedQueue = true
          }

          return { chunkIndex, fromSharedQueue }
        })

        let { chunkIndex, fromSharedQueue } = taskInfo  // 使用let，允许后续重新赋值

        if (chunkIndex === undefined) {
          // 队列为空，需要智能等待：
          // 1. 如果还有其他Worker在处理任务，等待它们可能放回失败任务
          // 2. 如果还有健康模型，等待它们可能产生新任务
          // 3. 只有当所有模型都不健康 && 没有活跃Worker时才退出
          
          const WAIT_INTERVAL = 500  // 500ms
          let totalWaits = 0
          let foundTask: number | undefined = undefined
          
          while (foundTask === undefined) {  // 持续等待直到找到任务或满足退出条件
            await new Promise(resolve => setTimeout(resolve, WAIT_INTERVAL))
            totalWaits++
            
            // 检查是否有新任务（直接获取，不放回）
            foundTask = await queueMutex.runExclusive(async () => {
              return sharedQueue.shift()
            })
            
            if (foundTask !== undefined) {
              // 找到新任务！记录日志并跳出
              logger.info(`Worker #${executor.index} Slot ${slotId} 在等待期间发现新任务${foundTask + 1}`, {
                waitedMs: totalWaits * WAIT_INTERVAL,
                totalWaits
              })
              break  // 跳出等待循环，使用找到的任务
            }
            
            // 没有找到任务，检查是否应该继续等待
            const shouldContinueWaiting = await workerStateMutex.runExclusive(async () => {
              const hasHealthyModel = hasAnyHealthyModel()
              const hasActiveWorkers = workerState.activeSlotCount > 0
              const shouldTerminate = workerState.shouldTerminate
              
              // 每10次等待（5秒）打印一次详细日志
              if (totalWaits % 10 === 0) {
                logger.info(`Worker #${executor.index} Slot ${slotId} 持续等待中`, {
                  hasHealthyModel,
                  hasActiveWorkers,
                  activeSlotCount: workerState.activeSlotCount,
                  shouldTerminate,
                  totalWaits,
                  waitedSeconds: Math.round((totalWaits * WAIT_INTERVAL) / 1000)
                })
              }
              
              // 如果有健康模型或有活跃Worker，继续等待
              if (hasHealthyModel || hasActiveWorkers) {
                return true
              }
              
              // 如果全局标记了终止，立即退出
              if (shouldTerminate) {
                return false
              }
              
              // 所有模型都不健康且没有活跃Worker，应该退出
              return false
            })
            
            if (!shouldContinueWaiting) {
              logger.info(`Worker #${executor.index} Slot ${slotId} 退出条件满足：所有模型不健康且无活跃Worker`, {
                waitedMs: totalWaits * WAIT_INTERVAL,
                totalWaits
              })
              break  // 跳出等待循环
            }
          }
          
          // 检查是否找到了任务
          if (foundTask !== undefined) {
            // 找到任务，重新赋值给chunkIndex，继续处理
            chunkIndex = foundTask
            fromSharedQueue = true
            
            logger.info(`Worker #${executor.index} Slot ${slotId} 获取等待任务${chunkIndex + 1}`, {
              source: 'shared-queue-after-wait',
              remainingShared: sharedQueue.length,
              totalWaits
            })
          } else {
            // 没有找到任务且满足退出条件，退出Slot
            logger.info(`Worker #${executor.index} Slot ${slotId} 无新任务且满足退出条件，完成工作`, {
              totalWaits,
              waitedSeconds: Math.round((totalWaits * WAIT_INTERVAL) / 1000)
            })
            break
          }
        }
        
        logger.info(`Worker #${executor.index} Slot ${slotId} 获取分块${chunkIndex + 1}`, {
          source: fromSharedQueue ? 'shared-queue' : 'initial-tasks',
          remainingInitial: initialTasks.length,
          remainingShared: sharedQueue.length
        })

        // 检查该分块是否在当前模型最近失败过，如果是则跳过让其他模型处理
        const shouldSkipChunk = await chunkFailedModelsMutex.runExclusive(async () => {
          const failedModels = chunkFailedModels.get(chunkIndex)
          if (failedModels && failedModels.has(executor.index)) {
            return true  // 该分块在当前模型刚失败过，应该跳过
          }
          return false
        })

        if (shouldSkipChunk) {
          logger.info(`Worker #${executor.index} Slot ${slotId} 跳过分块${chunkIndex + 1}（该模型最近失败过），放回队列`, {
            chunkIndex,
            modelIndex: executor.index,
            modelName: executor.model.name
          })

          // 放回共享队列，让其他模型处理
          await queueMutex.runExclusive(async () => {
            sharedQueue.push(chunkIndex)
          })

          addLog(createLogEntry('info', `分块${chunkIndex + 1}跳过，等待其他模型处理`, {
            chunkIndex,
            skippedModel: executor.model.name
          }))

          // 继续处理下一个任务
          continue
        }

        // 检查该分块的全局重试次数
        const currentRetries = chunkRetryCount.get(chunkIndex) || 0
        if (currentRetries >= maxChunkRetries) {
          logger.error(`Worker #${executor.index} Slot ${slotId} 分块${chunkIndex + 1}已达最大重试次数${maxChunkRetries}，标记为彻底失败`, {
            chunkIndex,
            retries: currentRetries,
            maxRetries: maxChunkRetries
          })
          
          memoryService.updateState({
            chunkSummaries: memoryService.getState().chunkSummaries.map((cs, idx) =>
              idx === chunkIndex ? {
                ...cs,
                status: 'error',
                errorMessage: `所有模型尝试均失败（${currentRetries}次重试）`
              } : cs
            )
          })

          addLog(createLogEntry('error', `分块${chunkIndex + 1}已达最大重试次数，彻底失败`, {
            chunkIndex,
            retries: currentRetries,
            maxRetries: maxChunkRetries
          }))
          
          // 不放回队列，继续处理下一个任务
          continue
        }

        // 增加重试计数
        chunkRetryCount.set(chunkIndex, currentRetries + 1)

        // 标记该Slot为活跃状态（正在处理任务）
        await workerStateMutex.runExclusive(async () => {
          workerState.activeSlotCount++
        })

        // 使用try-finally确保无论成功还是失败都会减少活跃计数
        try {
          // 处理该分块
          const maxRetries = 2
          let success = false
        
        for (let retry = 0; retry <= maxRetries && !success; retry++) {
          if (signal?.aborted) {
            // 使用互斥锁将任务放回共享队列
            await queueMutex.runExclusive(async () => {
              sharedQueue.unshift(chunkIndex)
            })
            throw new NovelCompressionError('用户取消了分析任务')
          }

          try {
            memoryService.updateState({
              chunkSummaries: memoryService.getState().chunkSummaries.map((cs, idx) =>
                idx === chunkIndex ? { 
                  ...cs, 
                  status: 'processing', 
                  startedAt: Date.now(),
                  model: `#${executor.index} ${executor.model.name}`
                } : cs
              )
            })

            const startTime = Date.now()
            const chunk = chunks[chunkIndex]
            const mentionedTargets = getMentionedTargetCharacters(chunk, targetCharacters)

            logger.info(`Worker #${executor.index} Slot ${slotId} 处理分块${chunkIndex + 1} (重试${retry}/${maxRetries})`, {
              chunkIndex,
              executorIndex: executor.index,
              slotId,
              attempt: retry + 1
            })

            const messages =
              chapterChunks && chapterChunks[chunkIndex]
                ? buildChapterAwarePrompt(
                    chunk,
                    chunkIndex,
                    targetCharacters,
                    chapterChunks[chunkIndex].chapters.map(c => c.title)
                  )
                : buildChapterAwarePrompt(chunk, chunkIndex, targetCharacters)  // 无章节信息时 AI 自行识别

            let characterPlots: Record<string, string> = {}
            let plotsByChapter: Record<string, Record<string, string>> | undefined
            let parseMethod: CharacterPlotParseMethod = 'failed'
            let rawResponseText = ''
            let structuredResponseRaw = ''
            let textResponseRaw = ''

            try {
              const structuredResponse = await createCancellablePromise(
                executor.executor.generateObject({
                  model: executor.model.id,
                  schema: CHARACTER_PLOTS_SCHEMA,
                  messages,
                  temperature,
                  abortSignal: signal
                }),
                signal!
              )

              structuredResponseRaw = safeStringifyForArtifact(structuredResponse)
              const structuredObject = (structuredResponse as any)?.object
              if (!structuredObject || typeof structuredObject !== 'object' || Array.isArray(structuredObject)) {
                throw new Error('AI未返回结构化 object')
              }

              if (Object.keys(structuredObject as Record<string, unknown>).length === 0 && mentionedTargets.length > 0) {
                throw new Error('AI返回空结构化对象，但文本提及目标人物')
              }

              rawResponseText = JSON.stringify(structuredObject)
              const normalized = normalizeStructuredCharacterPlots(structuredObject as StructuredCharacterPlots)
              characterPlots = normalized.plots
              plotsByChapter = normalized.plotsByChapter
              parseMethod = 'structured'
            } catch (structuredError) {
              logger.warn('结构化角色剧情生成失败，回退到文本JSON解析', {
                chunkIndex,
                model: executor.model.name,
                error: structuredError instanceof Error ? structuredError.message : String(structuredError)
              })

              const response = await createCancellablePromise<GenerateTextResponse>(
                executor.executor.generateText({
                  model: executor.model.id,
                  // 根据是否有章节信息选择不同的 Prompt 构建方式
                  messages,
                  temperature,
                  signal
                }),
                signal!
              )
              rawResponseText = response.text || ''
              textResponseRaw = rawResponseText

              // 解析 AI 输出（支持章节模式和整段模式）
              const parsed = parseCharacterPlotJSONWithChapters(response.text || '')
              characterPlots = parsed.plots
              plotsByChapter = parsed.plotsByChapter
              parseMethod = parsed.parseMethod
            }

            const durationMs = Date.now() - startTime

            // 统计解析方法
            parseStats[parseMethod]++

            // 指定人物模式：允许“空结果”作为合法分块完成（人物未出场）。
            // 但若分块文本中疑似出现目标人物，而结果为空，则更可能是模型输出/解析失败，需要重试。
            if (Object.keys(characterPlots).length === 0 && targetCharacters && targetCharacters.length > 0) {
              if (mentionedTargets.length > 0) {
                throw new NovelCompressionError('模型返回了空结果，但分块中提及目标人物，可能解析失败', {
                  chunkIndex,
                  model: executor.model.name,
                  parseMethod,
                  targetCharacters,
                  mentionedTargets,
                  responseTextPreview: truncateForArtifact(rawResponseText, 200000),
                  responseText: rawResponseText,
                  structuredResponsePreview: truncateForArtifact(structuredResponseRaw, 200000),
                  structuredResponse: structuredResponseRaw,
                  textResponsePreview: truncateForArtifact(textResponseRaw, 200000),
                  textResponse: textResponseRaw
                })
              }

              const normalized = normalizeTargetCharacterPlots(characterPlots, plotsByChapter, targetCharacters)
              characterPlots = normalized.plots
              plotsByChapter = normalized.plotsByChapter
            }

            if (parseMethod === 'failed' || Object.keys(characterPlots).length === 0) {
              throw new NovelCompressionError('模型返回了无法解析的JSON或空结果', {
                chunkIndex,
                model: executor.model.name,
                parseMethod,
                mentionedTargets,
                responseTextPreview: truncateForArtifact(rawResponseText, 200000),
                responseText: rawResponseText,
                structuredResponsePreview: truncateForArtifact(structuredResponseRaw, 200000),
                structuredResponse: structuredResponseRaw,
                textResponsePreview: truncateForArtifact(textResponseRaw, 200000),
                textResponse: textResponseRaw
              })
            }

            // 指定人物模式：对非空结果也做归一化，保证输出稳定（只包含指定人物，缺失用空串占位）。
            if (targetCharacters && targetCharacters.length > 0) {
              const normalized = normalizeTargetCharacterPlots(characterPlots, plotsByChapter, targetCharacters)
              characterPlots = normalized.plots
              plotsByChapter = normalized.plotsByChapter
            }

            // 指定人物模式：只要目标人物在文本中被提及（哪怕未出场），也必须产出非空剧情线索。
            // 若模型返回空串，认为更可能是输出/解析失败，触发重试，并在失败诊断中保留原始输出。
            if (targetCharacters && targetCharacters.length > 0 && mentionedTargets.length > 0) {
              const missingMentionedTargets = mentionedTargets.filter((target) => {
                const value = characterPlots[target]
                return typeof value !== 'string' || value.trim().length === 0
              })
              if (missingMentionedTargets.length > 0) {
                throw new NovelCompressionError('模型返回了空内容，但分块中提及目标人物，可能解析失败', {
                  chunkIndex,
                  model: executor.model.name,
                  parseMethod,
                  targetCharacters,
                  mentionedTargets,
                  missingMentionedTargets,
                  responseTextPreview: truncateForArtifact(rawResponseText, 200000),
                  responseText: rawResponseText,
                  structuredResponsePreview: truncateForArtifact(structuredResponseRaw, 200000),
                  structuredResponse: structuredResponseRaw,
                  textResponsePreview: truncateForArtifact(textResponseRaw, 200000),
                  textResponse: textResponseRaw
                })
              }
            }

            // 生成分块名称（章节模式下使用章节范围）
            const chunkName = chapterChunks && chapterChunks[chunkIndex]
              ? `${chapterChunks[chunkIndex].chapters[0].title} - ${chapterChunks[chunkIndex].chapters[chapterChunks[chunkIndex].chapters.length - 1].title}`
              : `第${chunkIndex + 1}节`

            // 保存分块结果
            await saveChunkCharacterAnalysis(
              outputDir,
              chunkIndex,
              chunkName,
              characterPlots,
              {
                modelId: executor.model.id,
                temperature,
                durationMs
              }
            )

            // 设置结果（包含按章节的剧情信息）
            results[chunkIndex] = {
              chunkIndex,
              chunkName,
              characterPlots,
              characterPlotsByChapter: plotsByChapter  // 新增：按章节的剧情
            }

            // 更新模型健康度（成功）
            modelHealth.successCount++
            modelHealth.totalAttempts++
            modelHealth.successRate = modelHealth.successCount / modelHealth.totalAttempts
            modelHealth.isHealthy = true

            // 原子递增完成计数
            const completedCount = incrementCompleted()

            // 更新UI状态（分离日志更新以提高性能）
            // 每次成功都更新健康度统计，让用户看到实时变化
            memoryService.updateState({
              progress: {
                current: completedCount,
                total: totalChunks,
                percentage: Math.round((completedCount / totalChunks) * 100),
                stage: 'compressing'
              },
              chunkSummaries: memoryService.getState().chunkSummaries.map((cs, idx) =>
                idx === chunkIndex ? {
                  ...cs,
                  status: 'completed',
                  durationMs,
                  finishedAt: Date.now(),
                  outputLength: JSON.stringify(characterPlots).length,
                  model: `#${executor.index} ${executor.model.name}`
                } : cs
              ),
              modelHealthStats: generateModelHealthStats() // 每次都更新
            })

            // 使用批量日志更新
            addLog(createLogEntry('info', `完成第 ${chunkIndex + 1}/${totalChunks} 节 [Worker #${executor.index} Slot ${slotId}] (${completedCount}/${totalChunks})`, {
              chunkIndex,
              characterCount: Object.keys(characterPlots).length,
              model: executor.model.name,
              parseMethod,
              workerIndex: executor.index,
              slotId
            }))

            logger.info(`Worker #${executor.index} Slot ${slotId} 完成分块${chunkIndex + 1}`, {
              chunkIndex,
              characterCount: Object.keys(characterPlots).length,
              parseMethod,
              durationMs
            })

            // ✅ 成功时清除该分块的失败模型记录
            await chunkFailedModelsMutex.runExclusive(async () => {
              chunkFailedModels.delete(chunkIndex)
            })

            success = true

          } catch (error) {
            logger.warn(`Worker #${executor.index} Slot ${slotId} 分块${chunkIndex + 1}失败 (重试${retry}/${maxRetries})`, error as Error)

            // 更新模型健康度（失败）
            modelHealth.failureCount++
            modelHealth.totalAttempts++
            modelHealth.successRate = modelHealth.totalAttempts > 0 
              ? modelHealth.successCount / modelHealth.totalAttempts 
              : 0
            modelHealth.lastError = (error as Error).message

            // 根据配置的阈值判断模型健康度
            if (modelHealth.failureCount >= MODEL_HEALTH_CONFIG.MAX_CONSECUTIVE_FAILURES ||
                (modelHealth.totalAttempts >= MODEL_HEALTH_CONFIG.MIN_ATTEMPTS_FOR_RATE &&
                 modelHealth.successRate < MODEL_HEALTH_CONFIG.MIN_SUCCESS_RATE)) {
              modelHealth.isHealthy = false
              logger.warn(`Worker #${executor.index} 模型被标记为不健康`, {
                successRate: `${Math.round(modelHealth.successRate * 100)}%`,
                failures: modelHealth.failureCount
              })

              // 立即更新健康度统计，让用户看到模型状态变化
              memoryService.updateState({
                modelHealthStats: generateModelHealthStats(),
                logs: [
                  ...memoryService.getState().logs,
                  createLogEntry('warning', `Worker #${executor.index} ${executor.model.name}健康度下降`, {
                    model: executor.model.name,
                    workerIndex: executor.index,
                    successRate: `${Math.round(modelHealth.successRate * 100)}%`,
                    failures: modelHealth.failureCount
                  })
                ]
              })
            }

            // 如果是最后一次重试且失败，将任务放回共享队列供其他worker尝试
            if (retry === maxRetries && !success) {
              const totalRetries = chunkRetryCount.get(chunkIndex) || 0
              const healthyWorkersCount = Array.from(modelHealthMap.values()).filter(h => h.isHealthy).length
              
              try {
                if (error instanceof NovelCompressionError && error.detail) {
                  const fileName = `chunk_${String(chunkIndex + 1).padStart(3, '0')}_failure_worker_${executor.index}.json`
                  const filePath = path.join(outputDir, fileName)
                  await fs.writeFile(
                    filePath,
                    JSON.stringify(
                      {
                        chunkIndex,
                        chunkName: `第${chunkIndex + 1}节`,
                        createdAt: Date.now(),
                        workerIndex: executor.index,
                        slotId,
                        model: executor.model.name,
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
              
              // ❌ 记录该分块在当前模型失败，避免同模型其他Slot重复尝试
              await chunkFailedModelsMutex.runExclusive(async () => {
                let failedModels = chunkFailedModels.get(chunkIndex)
                if (!failedModels) {
                  failedModels = new Set<number>()
                  chunkFailedModels.set(chunkIndex, failedModels)
                }
                failedModels.add(executor.index)
                
                logger.debug(`记录分块${chunkIndex + 1}在模型#${executor.index}失败`, {
                  chunkIndex,
                  modelIndex: executor.index,
                  failedModelsCount: failedModels.size
                })
              })
              
              logger.warn(`Worker #${executor.index} Slot ${slotId} 分块${chunkIndex + 1}所有重试均失败，放回共享队列`, {
                chunkIndex,
                workerRetries: retry + 1,
                totalRetries,
                healthyWorkers: healthyWorkersCount
              })
              
              sharedQueue.push(chunkIndex)  // 放入共享队列
              
              memoryService.updateState({
                chunkSummaries: memoryService.getState().chunkSummaries.map((cs, idx) =>
                  idx === chunkIndex ? {
                    ...cs,
                    status: 'pending',  // 改为pending，因为会重新尝试
                    errorMessage: `Worker #${executor.index} 失败，放入共享队列等待重试（总重试${totalRetries}/${maxChunkRetries}次）`
                  } : cs
                )
              })

              addLog(createLogEntry('warning', `分块${chunkIndex + 1}放入共享队列，等待其他worker重试`, {
                chunkIndex,
                failedWorker: executor.index,
                failedModel: executor.model.name,
                totalRetries,
                maxRetries: maxChunkRetries,
                sharedQueueLength: sharedQueue.length,
                healthyWorkers: healthyWorkersCount
              }))
            } else if (retry < maxRetries) {
              await new Promise(resolve => setTimeout(resolve, 500))  // 缩短重试等待时间从1000ms到500ms
            }
          }
        }
        } finally {
          // 无论成功还是失败，都要减少活跃Slot计数
          await workerStateMutex.runExclusive(async () => {
            workerState.activeSlotCount--
            logger.debug(`Worker #${executor.index} Slot ${slotId} 完成任务，活跃Slot数: ${workerState.activeSlotCount}`)
          })
        }
      }
      
      logger.info(`Worker #${executor.index} Slot ${slotId} 完成`)
    })()
    
    workerSlots.push(slotPromise)
  }

  // 等待所有任务槽完成
  await Promise.all(workerSlots)

  logger.info(`Worker #${executor.index} 完成`, {
    model: executor.model.name,
    successCount: modelHealth.successCount,
    failureCount: modelHealth.failureCount,
    successRate: `${Math.round(modelHealth.successRate * 100)}%`,
    remainingInitial: initialTasks.length,
    remainingShared: sharedQueue.length
  })

  addLog(createLogEntry('info', `Worker #${executor.index} ${executor.model.name} 完成`, {
    workerIndex: executor.index,
    model: executor.model.name,
    successCount: modelHealth.successCount,
    failureCount: modelHealth.failureCount,
    successRate: `${Math.round(modelHealth.successRate * 100)}%`,
    healthy: modelHealth.isHealthy
  }))

  // 最后刷新所有剩余日志
  flushLogs()
}

/**
 * 使用单个模型分析所有分块（原有函数，用于向后兼容）
 * @param chapterChunks 可选的章节分块信息，用于章节模式下传递章节标题给 AI
 */
async function analyzeAllChunksWithResume(
  chunks: string[],
  executor: any,
  model: Model,
  temperature: number,
  maxConcurrentPerModel: number,  // 每个模型的最大并发数
  outputDir: string,
  signal?: AbortSignal,
  targetCharacters?: string[],
  chapterChunks?: ChapterChunk[]  // 新增：章节分块信息
): Promise<ChunkCharacterPlotAnalysis[]> {
  const memoryService = novelCharacterMemoryService
  const totalChunks = chunks.length

  // JSON解析统计
  const parseStats = {
    direct: 0,
    extract: 0,
    regex: 0,
    failed: 0
  }

  // 1. 检测已存在的分块文件
  const { existingChunks, existingResults } = await detectExistingChunks(outputDir, totalChunks)

  if (existingChunks.size > 0) {
    memoryService.updateState({
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', `检测到 ${existingChunks.size}/${totalChunks} 个已完成分块，将跳过`, {
          existingCount: existingChunks.size,
          totalChunks
        })
      ]
    })
  }

  // 2. 筛选待处理分块
  const pendingIndexes: number[] = []
  for (let i = 0; i < totalChunks; i++) {
    if (!existingChunks.has(i)) {
      pendingIndexes.push(i)
    }
  }

  logger.info('开始处理待分析分块', {
    pending: pendingIndexes.length,
    existing: existingChunks.size,
    total: totalChunks
  })

  // 3. 初始化结果数组
  const results: (ChunkCharacterPlotAnalysis | undefined)[] = Array.from({ length: totalChunks })

  // 填充已有结果
  for (const [index, result] of existingResults.entries()) {
    results[index] = result
  }

  // 原子计数器，避免并发race condition
  let completedCount = existingChunks.size

  logger.info('[SingleModel] 并发配置', {
    maxConcurrentPerModel: maxConcurrentPerModel,
    pendingChunks: pendingIndexes.length,
    totalChunks
  })

  // 4. 并发处理待分析分块（限制并发数）
  await processConcurrently(
    pendingIndexes.map(index => async () => {
    if (signal?.aborted) {
      throw new NovelCompressionError('用户取消了分析任务')
    }

    try {
      memoryService.updateState({
        chunkSummaries: memoryService.getState().chunkSummaries.map((cs, idx) =>
          idx === index ? { ...cs, status: 'processing', startedAt: Date.now() } : cs
        )
      })

      const startTime = Date.now()
      const chunk = chunks[index]
      const mentionedTargets = getMentionedTargetCharacters(chunk, targetCharacters)

      const messages =
        chapterChunks && chapterChunks[index]
          ? buildChapterAwarePrompt(
              chunk,
              index,
              targetCharacters,
              chapterChunks[index].chapters.map(c => c.title)
            )
          : buildChapterAwarePrompt(chunk, index, targetCharacters)  // 无章节信息时 AI 自行识别

      let characterPlots: Record<string, string> = {}
      let plotsByChapter: Record<string, Record<string, string>> | undefined
      let parseMethod: CharacterPlotParseMethod = 'failed'
      let rawResponseText = ''
      let structuredResponseRaw = ''
      let textResponseRaw = ''

      try {
        const structuredResponse = await createCancellablePromise(
          executor.generateObject({
            model: model.id,
            schema: CHARACTER_PLOTS_SCHEMA,
            messages,
            temperature,
            abortSignal: signal
          }),
          signal!
        )

        structuredResponseRaw = safeStringifyForArtifact(structuredResponse)
        const structuredObject = (structuredResponse as any)?.object
        if (!structuredObject || typeof structuredObject !== 'object' || Array.isArray(structuredObject)) {
          throw new Error('AI未返回结构化 object')
        }

        if (Object.keys(structuredObject as Record<string, unknown>).length === 0 && mentionedTargets.length > 0) {
          throw new Error('AI返回空结构化对象，但文本提及目标人物')
        }

        rawResponseText = JSON.stringify(structuredObject)
        const normalized = normalizeStructuredCharacterPlots(structuredObject as StructuredCharacterPlots)
        characterPlots = normalized.plots
        plotsByChapter = normalized.plotsByChapter
        parseMethod = 'structured'
      } catch (structuredError) {
        logger.warn('结构化角色剧情生成失败，回退到文本JSON解析', {
          chunkIndex: index,
          model: model.name,
          error: structuredError instanceof Error ? structuredError.message : String(structuredError)
        })

        const response = await createCancellablePromise<GenerateTextResponse>(
          executor.generateText({
            model: model.id,
            // 根据是否有章节信息选择不同的 Prompt 构建方式
            messages,
            temperature,
            signal
          }),
          signal!
        )
        rawResponseText = response.text || ''
        textResponseRaw = rawResponseText

        // 解析 AI 输出（支持章节模式和整段模式）
        const parsed = parseCharacterPlotJSONWithChapters(response.text || '')
        characterPlots = parsed.plots
        plotsByChapter = parsed.plotsByChapter
        parseMethod = parsed.parseMethod
      }

      const durationMs = Date.now() - startTime

      // 统计解析方法
      parseStats[parseMethod]++

      // 指定人物模式：允许“空结果”作为合法分块完成（人物未出场）。
      // 但若分块文本中疑似出现目标人物，而结果为空，则更可能是模型输出/解析失败，需要重试。
      if (Object.keys(characterPlots).length === 0 && targetCharacters && targetCharacters.length > 0) {
        if (mentionedTargets.length > 0) {
          throw new NovelCompressionError('模型返回了空结果，但分块中提及目标人物，可能解析失败', {
            chunkIndex: index,
            model: model.name,
            parseMethod,
            targetCharacters,
            mentionedTargets,
            responseTextPreview: truncateForArtifact(rawResponseText, 200000),
            responseText: rawResponseText,
            structuredResponsePreview: truncateForArtifact(structuredResponseRaw, 200000),
            structuredResponse: structuredResponseRaw,
            textResponsePreview: truncateForArtifact(textResponseRaw, 200000),
            textResponse: textResponseRaw
          })
        }

        const normalized = normalizeTargetCharacterPlots(characterPlots, plotsByChapter, targetCharacters)
        characterPlots = normalized.plots
        plotsByChapter = normalized.plotsByChapter
      }

      if (parseMethod === 'failed' || Object.keys(characterPlots).length === 0) {
        throw new NovelCompressionError('模型返回了无法解析的JSON或空结果', {
          chunkIndex: index,
          model: model.name,
          parseMethod,
          mentionedTargets,
          responseTextPreview: truncateForArtifact(rawResponseText, 200000),
          responseText: rawResponseText,
          structuredResponsePreview: truncateForArtifact(structuredResponseRaw, 200000),
          structuredResponse: structuredResponseRaw,
          textResponsePreview: truncateForArtifact(textResponseRaw, 200000),
          textResponse: textResponseRaw
        })
      }

      // 指定人物模式：对非空结果也做归一化，保证输出稳定（只包含指定人物，缺失用空串占位）。
      if (targetCharacters && targetCharacters.length > 0) {
        const normalized = normalizeTargetCharacterPlots(characterPlots, plotsByChapter, targetCharacters)
        characterPlots = normalized.plots
        plotsByChapter = normalized.plotsByChapter
      }

      // 指定人物模式：只要目标人物在文本中被提及（哪怕未出场），也必须产出非空剧情线索。
      if (targetCharacters && targetCharacters.length > 0 && mentionedTargets.length > 0) {
        const missingMentionedTargets = mentionedTargets.filter((target) => {
          const value = characterPlots[target]
          return typeof value !== 'string' || value.trim().length === 0
        })
        if (missingMentionedTargets.length > 0) {
          throw new NovelCompressionError('模型返回了空内容，但分块中提及目标人物，可能解析失败', {
            chunkIndex: index,
            model: model.name,
            parseMethod,
            targetCharacters,
            mentionedTargets,
            missingMentionedTargets,
            responseTextPreview: truncateForArtifact(rawResponseText, 200000),
            responseText: rawResponseText,
            structuredResponsePreview: truncateForArtifact(structuredResponseRaw, 200000),
            structuredResponse: structuredResponseRaw,
            textResponsePreview: truncateForArtifact(textResponseRaw, 200000),
            textResponse: textResponseRaw
          })
        }
      }

      // 生成分块名称（章节模式下使用章节范围）
      const chunkName = chapterChunks && chapterChunks[index]
        ? `${chapterChunks[index].chapters[0].title} - ${chapterChunks[index].chapters[chapterChunks[index].chapters.length - 1].title}`
        : `第${index + 1}节`

      // 保存单个分块结果（文件即状态）
      await saveChunkCharacterAnalysis(
        outputDir,
        index,
        chunkName,
        characterPlots,
        {
          modelId: model.id,
          temperature,
          durationMs
        }
      )

      // 设置结果（包含按章节的剧情信息）
      results[index] = {
        chunkIndex: index,
        chunkName,
        characterPlots,
        characterPlotsByChapter: plotsByChapter  // 新增：按章节的剧情
      }

      // 原子递增完成计数
      completedCount++

      // 更新UI状态（使用原子计数器）
      memoryService.updateState({
        progress: {
          current: completedCount,
          total: totalChunks,
          percentage: Math.round((completedCount / totalChunks) * 100),
          stage: 'compressing'
        },
        chunkSummaries: memoryService.getState().chunkSummaries.map((cs, idx) =>
          idx === index ? {
            ...cs,
            status: 'completed',
            durationMs,
            finishedAt: Date.now(),
            outputLength: JSON.stringify(characterPlots).length
          } : cs
        ),
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('info', `完成第 ${index + 1}/${totalChunks} 节 (${completedCount}/${totalChunks})`, {
            chunkIndex: index,
            characterCount: Object.keys(characterPlots).length
          })
        ]
      })

      logger.info(`分块${index + 1}分析完成`, {
        chunkIndex: index,
        characterCount: Object.keys(characterPlots).length
      })

    } catch (error) {
      logger.error(`分块${index + 1}分析失败`, error as Error)
      try {
        if (error instanceof NovelCompressionError && error.detail) {
          const fileName = `chunk_${String(index + 1).padStart(3, '0')}_failure.json`
          const filePath = path.join(outputDir, fileName)
          await fs.writeFile(
            filePath,
            JSON.stringify(
              {
                chunkIndex: index,
                chunkName: `第${index + 1}节`,
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

      memoryService.updateState({
        chunkSummaries: memoryService.getState().chunkSummaries.map((cs, idx) =>
          idx === index ? {
            ...cs,
            status: 'error',
            errorMessage: (error as Error).message
          } : cs
        ),
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('error', `第${index + 1}节分析失败: ${(error as Error).message}`, {
            chunkIndex: index
          })
        ]
      })

      // 失败的分块不设置 results[index]，保持 undefined
      // 这样文件不存在，下次会重新尝试
    }
    }),
    maxConcurrentPerModel
  )

  // 5. 检查完成情况
  const successfulResults = results.filter((r): r is ChunkCharacterPlotAnalysis => r !== undefined)
  const failedCount = totalChunks - successfulResults.length

  if (successfulResults.length === 0) {
    throw new NovelCompressionError('所有分块分析都失败了')
  }

  if (failedCount > 0) {
    const failedIndexes = Array.from({ length: totalChunks }, (_, i) => i)
      .filter(i => results[i] === undefined)

    const failureDetails = memoryService.getState().chunkSummaries
      .filter(cs => cs.status === 'error' && cs.errorMessage)
      .map(cs => `第${cs.index + 1}节: ${cs.errorMessage}`)

    memoryService.updateState({
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('error', `任务失败：有 ${failedCount} 个分块未能生成，请使用断点续传重新运行`, {
          successfulChunks: successfulResults.length,
          failedChunks: failedCount,
          totalChunks,
          failedIndexes: failedIndexes.map(i => i + 1),
          failures: failureDetails
        })
      ]
    })

    // 发送失败通知
    try {
      new Notification({
        title: '矩阵分析失败',
        body: `${failedCount} 个分块失败，请重新运行以续传`,
        silent: false
      }).show()
    } catch (notifError) {
      logger.warn('Failed to show failure notification', notifError as Error)
    }

    // 抛出错误，阻止继续执行
    throw new NovelCompressionError(
      `矩阵分析未完成：${failedCount}/${totalChunks} 个分块失败。已生成的分块已保存，请重新运行任务以断点续传。`,
      {
        successfulChunks: successfulResults.length,
        failedChunks: failedCount,
        totalChunks,
        failedIndexes: failedIndexes.map(i => i + 1),
        failureDetails,
        canResume: true,
        outputDir
      }
    )
  }

  // 记录JSON解析统计
  logger.info('JSON解析统计', parseStats)
  memoryService.updateState({
    logs: [
      ...memoryService.getState().logs,
      createLogEntry('info', 'JSON解析质量统计', {
        direct: parseStats.direct,
        extract: parseStats.extract,
        regex: parseStats.regex,
        failed: parseStats.failed,
        totalParsed: parseStats.direct + parseStats.extract + parseStats.regex,
        directRate: totalChunks > 0 ? `${Math.round((parseStats.direct / totalChunks) * 100)}%` : '0%'
      })
    ]
  })

  return successfulResults.sort((a, b) => a.chunkIndex - b.chunkIndex)
}

/**
 * 矩阵模式主处理函数
 * 分析小说人物剧情并生成角色-剧情矩阵
 */
async function analyzeNovelCharacterMatrix(
  model: Model,
  providerConfig: { providerId: ProviderId; options: any },
  content: string,
  options: NovelCompressionOptions,
  outputPath: string,
  outputFormat: CharacterOutputFormat = 'markdown'
): Promise<NovelCompressionResult> {
  const memoryService = novelCharacterMemoryService
  const signal = abortController.signal
  options.signal = signal
  
  // 记录初始内存使用
  const initialMemory = process.memoryUsage()
  logger.info('矩阵分析开始 - 内存状态', {
    heapUsed: `${Math.round(initialMemory.heapUsed / 1024 / 1024)}MB`,
    heapTotal: `${Math.round(initialMemory.heapTotal / 1024 / 1024)}MB`,
    rss: `${Math.round(initialMemory.rss / 1024 / 1024)}MB`
  })
  
  logger.info('Character matrix analysis started', { 
    modelId: model.id, 
    providerId: providerConfig.providerId,
    outputFormat 
  })

  if (!model) {
    throw new NovelCompressionError('未选择任何模型')
  }
  if (!content || content.trim().length === 0) {
    throw new NovelCompressionError('文本内容为空，无法分析')
  }
  if (!outputPath) {
    throw new NovelCompressionError('矩阵模式需要指定输出路径')
  }

  const normalizedChunkSize = Math.max(500, Math.min(500000, Math.floor(options.chunkSize)))
  const normalizedOverlap = clamp(Math.floor(options.overlap), 0, normalizedChunkSize - 1)
  const normalizedTemperature = clamp(options.temperature, 0, 1.5)
  const maxConcurrentPerModel = Math.max(1, Math.min(50, Math.floor(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENT_CHUNKS_PER_MODEL)))

  // 获取当前状态以确定分块模式
  const currentStateForChunking = memoryService.getState()
  const chunkMode = currentStateForChunking.chunkMode || 'bySize'
  const chaptersPerChunk = currentStateForChunking.chaptersPerChunk || 3
  const chapterParseResult = currentStateForChunking.chapterParseResult

  // 根据分块模式选择分块方式
  let chunkTexts: string[] = []
  let chapterChunks: ChapterChunk[] = []  // 用于章节模式，保存章节信息
  
  if (chunkMode === 'byChapter' && chapterParseResult?.success && chapterParseResult.chapters.length > 0) {
    // 按章节分块模式
    logger.info('使用按章节分块模式', {
      totalChapters: chapterParseResult.totalChapters,
      chaptersPerChunk,
      usedRule: chapterParseResult.usedRule
    })
    
    chapterChunks = localSplitTextByChapters(content, chapterParseResult.chapters, chaptersPerChunk)
    chunkTexts = chapterChunks.map(c => c.text)
    
    memoryService.updateState({
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', '【章节模式】按章节分块完成', {
          totalChapters: chapterParseResult.totalChapters,
          chaptersPerChunk,
          totalChunks: chapterChunks.length,
          usedRule: chapterParseResult.usedRule
        })
      ]
    })
  } else {
    // 按字数分块模式（默认）
    logger.info('使用按字数分块模式', {
      chunkSize: normalizedChunkSize,
      overlap: normalizedOverlap
    })
    
    chunkTexts = splitTextIntoChunks(content, normalizedChunkSize, normalizedOverlap, 0.5)
      .map(c => c.text)
  }
  
  const totalChunks = chunkTexts.length

  if (totalChunks === 0) {
    throw new NovelCompressionError('无法根据当前设置生成有效的文本分块')
  }

  // 获取指定人物配置以确定输出文件夹名称
  const currentState = memoryService.getState()
  const targetCharactersForFolder = currentState.targetCharacterConfig?.enabled 
    ? currentState.targetCharacterConfig.characters 
    : undefined

  const baseName = getTaskBaseNameFromOutputPath(outputPath, currentState.selectedFile)
  let rootOutputDir = ''
  let chunksDir = ''
  let finalResultsDir = ''
  let characterTextsDir = ''

  try {
    ;({ rootOutputDir, chunksDir, finalResultsDir, characterTextsDir } = await createOutputDirectory(
      outputPath,
      baseName,
      !!currentState.continueLatestTask,
      targetCharactersForFolder
    ))
    logger.info('输出目录结构已创建', {
      rootDir: rootOutputDir,
      subdirs: ['分块内容', '最终结果', '人物TXT合集'],
      mode: targetCharactersForFolder ? '指定人物模式' : '全量分析模式'
    })
  } catch (error) {
    logger.warn('创建输出目录失败', error as Error)
  }

  // 使用分块目录作为 outputDir（兼容现有逻辑）
  const outputDir = chunksDir

  memoryService.updateState({
    progress: {
      current: 0,
      total: totalChunks,
      percentage: 0,
      stage: 'initializing'
    },
    logs: [
      ...memoryService.getState().logs,
      createLogEntry('info', '【矩阵模式】已生成文本分块', {
        totalChunks,
        chunkSize: normalizedChunkSize,
        overlap: normalizedOverlap
      })
    ],
    chunkSummaries: Array.from({ length: totalChunks }, (_, index) => ({
      index,
      status: 'pending',
      inputLength: chunkTexts[index]?.length ?? 0,
      targetLength: 0
    }))
  })

  try {
    // 注册AI Provider（清理后重新注册，确保状态一致性）
    clearAllProviders()
    const { providerId, options: providerOptions } = providerConfig
    await createAndRegisterProvider(providerId, providerOptions)

    memoryService.updateState({
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', '【矩阵模式】模型提供方已注册', { providerId, modelId: model.id })
      ]
    })

    const executor = createExecutor(providerId, { ...providerOptions, mode: 'chat' })

    // 获取指定人物配置
    const currentState = memoryService.getState()
    const targetCharacters = currentState.targetCharacterConfig?.enabled 
      ? currentState.targetCharacterConfig.characters 
      : undefined

    // 并发分析所有分块（支持断点续传）
    memoryService.updateState({
      progress: { current: 0, total: totalChunks, percentage: 0, stage: 'compressing' },
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', '【矩阵模式】开始并发分析所有分块', { 
          totalChunks,
          targetMode: targetCharacters ? '指定人物模式' : '全量分析模式',
          targetCharacters: targetCharacters || '无'
        })
      ]
    })

    const chunkResults = await analyzeAllChunksWithResume(
      chunkTexts,
      executor,
      model,
      normalizedTemperature,
      maxConcurrentPerModel,
      outputDir,
      signal,
      targetCharacters,
      chapterChunks.length > 0 ? chapterChunks : undefined  // 传递章节分块信息
    )

    // 检查内存使用（分析完成后）
    const afterAnalysisMemory = process.memoryUsage()
    logger.info('分块分析完成 - 内存状态', {
      heapUsed: `${Math.round(afterAnalysisMemory.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(afterAnalysisMemory.heapTotal / 1024 / 1024)}MB`,
      heapIncrease: `${Math.round((afterAnalysisMemory.heapUsed - initialMemory.heapUsed) / 1024 / 1024)}MB`
    })

    if (signal?.aborted) {
      throw new NovelCompressionError('用户取消了分析任务')
    }

    // 提取并合并角色列表
    memoryService.updateState({
      progress: { current: totalChunks, total: totalChunks, percentage: 100, stage: 'finalizing' },
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', '【矩阵模式】开始合并角色列表', { totalChunks })
      ]
    })

    const characters = extractUnifiedCharacterList(chunkResults)

    memoryService.updateState({
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', `【矩阵模式】识别出 ${characters.length} 个角色`, {
          characterCount: characters.length,
          characters: characters.map(c => c.displayName)
        })
      ]
    })

    // 构建角色-剧情矩阵
    const matrixData = buildCharacterPlotMatrix(characters, chunkResults)

    memoryService.updateState({
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', '【矩阵模式】矩阵构建完成', {
          characters: matrixData.metadata.totalCharacters,
          chunks: matrixData.metadata.totalChunks
        })
      ]
    })

    // 生成并保存输出文件
    const baseName = getTaskBaseNameFromOutputPath(outputPath, memoryService.getState().selectedFile)
    
    // 生成带时间戳的文件名，避免覆盖
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5) // 2025-01-20T12-34-56
    const uniqueBaseName = `${baseName}_character_matrix_${timestamp}`
    
    let primaryOutput = ''
    const outputFiles: string[] = []

    // 生成用户选择的格式 + JSON 格式（JSON 必须生成）
    const formatsToGenerate: Array<CharacterOutputFormat | 'json'> = [outputFormat, 'json']
    
    for (const format of formatsToGenerate) {
      let fileContent = ''
      let fileExt = ''
      
      switch (format) {
        case 'markdown':
          fileContent = generateMarkdownTable(matrixData)
          fileExt = 'md'
          break
        case 'csv':
          fileContent = generateCSV(matrixData)
          fileExt = 'csv'
          break
        case 'html':
          fileContent = generateHTMLTable(matrixData)
          fileExt = 'html'
          break
        case 'json':
          fileContent = generateJSON(matrixData)
          fileExt = 'json'
          break
      }
      
      // 保存到"最终结果"子目录
      const outputFilePath = path.join(finalResultsDir, `${uniqueBaseName}.${fileExt}`)
      
      try {
        await fs.writeFile(outputFilePath, fileContent, 'utf-8')
        outputFiles.push(outputFilePath)
        
        if (format === outputFormat) {
          primaryOutput = fileContent
        }
        
        logger.info(`矩阵文件已保存: ${outputFilePath}`)
      } catch (error) {
        logger.error(`保存${format}文件失败`, error as Error)
      }
    }

    // 额外保存一份 latest.json 副本（方便前端快速读取最新数据）
    try {
      const latestJsonPath = path.join(finalResultsDir, 'latest.json')
      const jsonContent = generateJSON(matrixData)
      await fs.writeFile(latestJsonPath, jsonContent, 'utf-8')
      logger.info('latest.json 副本已保存')
    } catch (error) {
      logger.error('保存 latest.json 副本失败', error as Error)
    }

    memoryService.updateState({
      progress: { current: totalChunks, total: totalChunks, percentage: 100, stage: 'completed' },
      outputPath: rootOutputDir,  // 更新为实际的任务目录路径（带时间戳）
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', '【矩阵模式】所有输出文件已生成', {
          formats: formatsToGenerate.join(', '),
          files: outputFiles
        })
      ]
    })

    // 自动导出人物剧情TXT
    try {
      logger.info('开始自动导出人物剧情TXT')

      let exportedCount = 0
      for (let charIndex = 0; charIndex < matrixData.characters.length; charIndex++) {
        const character = matrixData.characters[charIndex]
        const characterPlots = matrixData.matrix[charIndex]

        // 收集该人物的所有剧情
        const plotTexts: string[] = []
        for (let chunkIndex = 0; chunkIndex < characterPlots.length; chunkIndex++) {
          const plot = characterPlots[chunkIndex]
          if (plot && plot.trim().length > 0) {
            const chunkName = matrixData.chunks[chunkIndex]?.chunkName || `第${chunkIndex + 1}节`
            plotTexts.push(`【${chunkName}】\n${plot}`)
          }
        }

        // 如果该人物没有任何剧情，跳过
        if (plotTexts.length === 0) {
          continue
        }

        // 生成文件内容
        const fileContent = `${character.displayName} 剧情合集\n${'='.repeat(80)}\n\n` +
          plotTexts.join('\n\n' + '-'.repeat(80) + '\n\n')

        // 生成文件名（处理特殊字符）
        const safeFileName = character.displayName.replace(/[<>:"/\\|?*]/g, '_')
        const filePath = path.join(characterTextsDir, `${safeFileName}.txt`)

        // 写入文件
        await fs.writeFile(filePath, fileContent, 'utf-8')
        exportedCount++
      }

      logger.info('人物剧情TXT自动导出完成', {
        exportedCount,
        outputDir: characterTextsDir
      })

      memoryService.updateState({
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('info', `已自动导出 ${exportedCount} 个人物的剧情到"人物TXT合集"文件夹`, {
            exportedCount,
            outputDir: characterTextsDir
          })
        ]
      })
    } catch (error) {
      logger.error('自动导出人物剧情TXT失败', error as Error)
      memoryService.updateState({
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('warning', '自动导出人物剧情TXT失败，可手动导出', {
            error: (error as Error).message
          })
        ]
      })
    }

    // 记录最终内存使用
    const finalMemory = process.memoryUsage()
    const memoryIncrease = Math.round((finalMemory.heapUsed - initialMemory.heapUsed) / 1024 / 1024)
    logger.info('矩阵分析完成 - 最终内存状态', {
      heapUsed: `${Math.round(finalMemory.heapUsed / 1024 / 1024)}MB`,
      totalIncrease: `${memoryIncrease}MB`,
      charactersCount: matrixData.metadata.totalCharacters,
      chunksCount: matrixData.metadata.totalChunks
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

    // 发送系统通知
    try {
      new Notification({
        title: '人物志矩阵生成完成',
        body: `已识别 ${matrixData.metadata.totalCharacters} 个角色，生成 ${outputFiles.length} 个输出文件`,
        silent: false
      }).show()
      logger.info('Task completion notification sent', {
        characters: matrixData.metadata.totalCharacters,
        files: outputFiles.length
      })
    } catch (notifError) {
      logger.warn('Failed to show notification', notifError as Error)
    }

    // 返回结果
    return {
      merged: primaryOutput,
      chunks: [],
      characterMatrix: matrixData
    }

  } catch (error) {
    if ((error as Error).name === 'AbortError' || (error as Error).message.includes('用户取消')) {
      logger.info('Character matrix analysis was cancelled.')
      const currentState = memoryService.getState()
      memoryService.updateState({
        isProcessing: false,
        progress: {
          current: currentState.progress?.current ?? 0,
          total: currentState.progress?.total ?? totalChunks,
          percentage: currentState.progress?.percentage ?? 0,
          stage: 'cancelled'
        }
      })
      throw new NovelCompressionError('用户取消了分析任务')
    } else {
      logger.error('Character matrix analysis failed', error as Error)
      const currentState = memoryService.getState()
      
      // 收集失败摘要
      const failedChunks = currentState.chunkSummaries.filter(cs => cs.status === 'error')
      const errorSummary = {
        message: (error as Error).message,
        stack: (error as Error).stack,
        totalChunks,
        completedChunks: currentState.chunkSummaries.filter(cs => cs.status === 'completed').length,
        failedChunks: failedChunks.length,
        failureDetails: failedChunks.map(cs => ({
          index: cs.index + 1,
          error: cs.errorMessage
        }))
      }
      
      memoryService.updateState({
        isProcessing: false,
        progress: {
          current: currentState.progress?.current ?? 0,
          total: totalChunks,
          percentage: calculatePercentage(currentState.progress?.current ?? 0, totalChunks),
          stage: 'failed'
        },
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('error', '【矩阵模式】分析任务失败', errorSummary)
        ]
      })
      
      // 发送失败通知
      try {
        new Notification({
          title: '矩阵分析失败',
          body: `任务失败: ${(error as Error).message.substring(0, 100)}`,
          silent: false
        }).show()
      } catch (notifError) {
        logger.warn('Failed to show error notification', notifError as Error)
      }
      
      throw error instanceof NovelCompressionError
        ? error
        : new NovelCompressionError('矩阵分析过程中出现错误', error)
    }
  }
}

/**
 * 矩阵模式主处理函数（模型池版本）
 * 使用模型池分析小说人物剧情并生成角色-剧情矩阵
 */
async function analyzeNovelCharacterMatrixWithModelPool(
  models: Model[],
  providerConfigs: { modelId: string; providerId: ProviderId; options: any }[],
  content: string,
  options: NovelCompressionOptions,
  outputPath: string,
  outputFormat: CharacterOutputFormat = 'markdown'
): Promise<NovelCompressionResult> {
  const memoryService = novelCharacterMemoryService
  const signal = abortController.signal
  options.signal = signal

  // 记录初始内存使用
  const initialMemory = process.memoryUsage()
  logger.info('【模型池】矩阵分析开始 - 内存状态', {
    heapUsed: `${Math.round(initialMemory.heapUsed / 1024 / 1024)}MB`,
    heapTotal: `${Math.round(initialMemory.heapTotal / 1024 / 1024)}MB`,
    rss: `${Math.round(initialMemory.rss / 1024 / 1024)}MB`
  })

  logger.info('【模型池】Character matrix analysis started', {
    modelCount: models.length,
    modelIds: models.map(m => m.id),
    outputFormat
  })

  if (!models || models.length === 0) {
    throw new NovelCompressionError('未选择任何模型')
  }
  if (!content || content.trim().length === 0) {
    throw new NovelCompressionError('文本内容为空，无法分析')
  }
  if (!outputPath) {
    throw new NovelCompressionError('矩阵模式需要指定输出路径')
  }

  const normalizedChunkSize = Math.max(500, Math.min(500000, Math.floor(options.chunkSize)))
  const normalizedOverlap = clamp(Math.floor(options.overlap), 0, normalizedChunkSize - 1)
  const normalizedTemperature = clamp(options.temperature, 0, 1.5)
  const maxConcurrentPerModel = Math.max(1, Math.min(50, Math.floor(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENT_CHUNKS_PER_MODEL)))

  // 获取当前状态以确定分块模式
  const currentStateForChunking = memoryService.getState()
  const chunkMode = currentStateForChunking.chunkMode || 'bySize'
  const chaptersPerChunk = currentStateForChunking.chaptersPerChunk || 3
  const chapterParseResult = currentStateForChunking.chapterParseResult

  // 根据分块模式选择分块方式
  let chunkTexts: string[] = []
  let chapterChunks: ChapterChunk[] = []  // 用于章节模式，保存章节信息
  
  if (chunkMode === 'byChapter' && chapterParseResult?.success && chapterParseResult.chapters.length > 0) {
    // 按章节分块模式
    logger.info('【模型池】使用按章节分块模式', {
      totalChapters: chapterParseResult.totalChapters,
      chaptersPerChunk,
      usedRule: chapterParseResult.usedRule
    })
    
    chapterChunks = localSplitTextByChapters(content, chapterParseResult.chapters, chaptersPerChunk)
    chunkTexts = chapterChunks.map(c => c.text)
    
    memoryService.updateState({
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', '【模型池-章节模式】按章节分块完成', {
          totalChapters: chapterParseResult.totalChapters,
          chaptersPerChunk,
          totalChunks: chapterChunks.length,
          usedRule: chapterParseResult.usedRule
        })
      ]
    })
  } else {
    // 按字数分块模式（默认）
    logger.info('【模型池】使用按字数分块模式', {
      chunkSize: normalizedChunkSize,
      overlap: normalizedOverlap
    })
    
    chunkTexts = splitTextIntoChunks(content, normalizedChunkSize, normalizedOverlap, 0.5)
      .map(c => c.text)
  }
  
  const totalChunks = chunkTexts.length

  if (totalChunks === 0) {
    throw new NovelCompressionError('无法根据当前设置生成有效的文本分块')
  }

  // 获取指定人物配置以确定输出文件夹名称
  const currentState = memoryService.getState()
  const targetCharactersForFolder = currentState.targetCharacterConfig?.enabled 
    ? currentState.targetCharacterConfig.characters 
    : undefined

  const baseName = getTaskBaseNameFromOutputPath(outputPath, currentState.selectedFile)
  let rootOutputDir = ''
  let chunksDir = ''
  let finalResultsDir = ''
  let characterTextsDir = ''

  try {
    ;({ rootOutputDir, chunksDir, finalResultsDir, characterTextsDir } = await createOutputDirectory(
      outputPath,
      baseName,
      !!currentState.continueLatestTask,
      targetCharactersForFolder
    ))
    logger.info('输出目录结构已创建', {
      rootDir: rootOutputDir,
      subdirs: ['分块内容', '最终结果', '人物TXT合集'],
      mode: targetCharactersForFolder ? '指定人物模式' : '全量分析模式'
    })
  } catch (error) {
    logger.warn('创建输出目录失败', error as Error)
  }

  // 使用分块目录作为 outputDir（兼容现有逻辑）
  const outputDir = chunksDir

  memoryService.updateState({
    progress: {
      current: 0,
      total: totalChunks,
      percentage: 0,
      stage: 'initializing'
    },
    logs: [
      ...memoryService.getState().logs,
      createLogEntry('info', '【模型池-矩阵模式】已生成文本分块', {
        totalChunks,
        chunkSize: normalizedChunkSize,
        overlap: normalizedOverlap,
        modelCount: models.length,
        chunkMode
      })
    ],
    chunkSummaries: Array.from({ length: totalChunks }, (_, index) => ({
      index,
      status: 'pending',
      inputLength: chunkTexts[index]?.length ?? 0,
      targetLength: 0
    }))
  })

  try {
    // 获取指定人物配置
    const currentState = memoryService.getState()
    const targetCharacters = currentState.targetCharacterConfig?.enabled 
      ? currentState.targetCharacterConfig.characters 
      : undefined

    // 使用模型池并发分析所有分块（支持断点续传和模型自动切换）
    memoryService.updateState({
      progress: { current: 0, total: totalChunks, percentage: 0, stage: 'compressing' },
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', '【模型池-矩阵模式】开始并发分析所有分块', {
          totalChunks,
          modelCount: models.length,
          targetMode: targetCharacters ? '指定人物模式' : '全量分析模式',
          targetCharacters: targetCharacters || '无',
          chunkMode
        })
      ]
    })

    const chunkResults = await analyzeAllChunksWithModelPool(
      chunkTexts,
      models,
      providerConfigs,
      normalizedTemperature,
      maxConcurrentPerModel,
      outputDir,
      signal,
      targetCharacters,
      chapterChunks.length > 0 ? chapterChunks : undefined  // 传递章节分块信息
    )

    // 检查内存使用（分析完成后）
    const afterAnalysisMemory = process.memoryUsage()
    logger.info('【模型池】分块分析完成 - 内存状态', {
      heapUsed: `${Math.round(afterAnalysisMemory.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(afterAnalysisMemory.heapTotal / 1024 / 1024)}MB`,
      heapIncrease: `${Math.round((afterAnalysisMemory.heapUsed - initialMemory.heapUsed) / 1024 / 1024)}MB`
    })

    if (signal?.aborted) {
      throw new NovelCompressionError('用户取消了分析任务')
    }

    // 提取并合并角色列表
    memoryService.updateState({
      progress: { current: totalChunks, total: totalChunks, percentage: 100, stage: 'finalizing' },
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', '【模型池-矩阵模式】开始合并角色列表', { totalChunks })
      ]
    })

    const characters = extractUnifiedCharacterList(chunkResults)

    memoryService.updateState({
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', `【模型池-矩阵模式】识别出 ${characters.length} 个角色`, {
          characterCount: characters.length,
          characters: characters.map(c => c.displayName)
        })
      ]
    })

    // 构建角色-剧情矩阵
    const matrixData = buildCharacterPlotMatrix(characters, chunkResults)

    memoryService.updateState({
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', '【模型池-矩阵模式】矩阵构建完成', {
          characters: matrixData.metadata.totalCharacters,
          chunks: matrixData.metadata.totalChunks
        })
      ]
    })

    // 生成并保存输出文件（保存到“最终结果”子目录，避免覆盖历史任务）
    // 生成带时间戳的文件名，避免覆盖
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)
    const uniqueBaseName = `${baseName}_character_matrix_${timestamp}`

    let primaryOutput = ''
    const outputFiles: string[] = []

    // 生成用户选择的格式 + JSON 格式（JSON 必须生成）
    const formatsToGenerate: Array<CharacterOutputFormat | 'json'> = [outputFormat, 'json']

    for (const format of formatsToGenerate) {
      let fileContent = ''
      let fileExt = ''

      switch (format) {
        case 'markdown':
          fileContent = generateMarkdownTable(matrixData)
          fileExt = 'md'
          break
        case 'csv':
          fileContent = generateCSV(matrixData)
          fileExt = 'csv'
          break
        case 'html':
          fileContent = generateHTMLTable(matrixData)
          fileExt = 'html'
          break
        case 'json':
          fileContent = generateJSON(matrixData)
          fileExt = 'json'
          break
      }

      const outputFilePath = path.join(finalResultsDir, `${uniqueBaseName}.${fileExt}`)

      try {
        await fs.writeFile(outputFilePath, fileContent, 'utf-8')
        outputFiles.push(outputFilePath)

        if (format === outputFormat) {
          primaryOutput = fileContent
        }

        logger.info(`【模型池】矩阵文件已保存: ${outputFilePath}`)
      } catch (error) {
        logger.error(`【模型池】保存${format}文件失败`, error as Error)
      }
    }

    memoryService.updateState({
      progress: { current: totalChunks, total: totalChunks, percentage: 100, stage: 'completed' },
      outputPath: rootOutputDir,  // 更新为实际的任务目录路径（带时间戳）
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', '【模型池-矩阵模式】所有输出文件已生成', {
          formats: formatsToGenerate.join(', '),
          files: outputFiles
        })
      ]
    })

    // 自动导出人物剧情TXT
    try {
      logger.info('【模型池】开始自动导出人物剧情TXT')

      let exportedCount = 0
      for (let charIndex = 0; charIndex < matrixData.characters.length; charIndex++) {
        const character = matrixData.characters[charIndex]
        const characterPlots = matrixData.matrix[charIndex]

        // 收集该人物的所有剧情
        const plotTexts: string[] = []
        for (let chunkIndex = 0; chunkIndex < characterPlots.length; chunkIndex++) {
          const plot = characterPlots[chunkIndex]
          if (plot && plot.trim().length > 0) {
            const chunkName = matrixData.chunks[chunkIndex]?.chunkName || `第${chunkIndex + 1}节`
            plotTexts.push(`【${chunkName}】\n${plot}`)
          }
        }

        // 如果该人物没有任何剧情，跳过
        if (plotTexts.length === 0) {
          continue
        }

        // 生成文件内容
        const fileContent = `${character.displayName} 剧情合集\n${'='.repeat(80)}\n\n` +
          plotTexts.join('\n\n' + '-'.repeat(80) + '\n\n')

        // 生成文件名（处理特殊字符）
        const safeFileName = character.displayName.replace(/[<>:"/\\|?*]/g, '_')
        const filePath = path.join(characterTextsDir, `${safeFileName}.txt`)

        // 写入文件
        await fs.writeFile(filePath, fileContent, 'utf-8')
        exportedCount++
      }

      logger.info('【模型池】人物剧情TXT自动导出完成', {
        exportedCount,
        outputDir: characterTextsDir
      })

      memoryService.updateState({
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('info', `【模型池】已自动导出 ${exportedCount} 个人物的剧情到"人物TXT合集"文件夹`, {
            exportedCount,
            outputDir: characterTextsDir
          })
        ]
      })
    } catch (error) {
      logger.error('【模型池】自动导出人物剧情TXT失败', error as Error)
      memoryService.updateState({
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('warning', '【模型池】自动导出人物剧情TXT失败，可手动导出', {
            error: (error as Error).message
          })
        ]
      })
    }

    // 记录最终内存使用
    const finalMemory = process.memoryUsage()
    const memoryIncrease = Math.round((finalMemory.heapUsed - initialMemory.heapUsed) / 1024 / 1024)
    logger.info('【模型池】矩阵分析完成 - 最终内存状态', {
      heapUsed: `${Math.round(finalMemory.heapUsed / 1024 / 1024)}MB`,
      totalIncrease: `${memoryIncrease}MB`,
      charactersCount: matrixData.metadata.totalCharacters,
      chunksCount: matrixData.metadata.totalChunks,
      modelCount: models.length
    })

    if (memoryIncrease > 500) {
      logger.warn('【模型池】内存使用增长较大', {
        increase: `${memoryIncrease}MB`,
        recommendation: '考虑减小分块大小或分批处理'
      })
      memoryService.updateState({
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('warning', `【模型池】内存使用增长 ${memoryIncrease}MB，建议优化分块参数`, {
            memoryIncrease: `${memoryIncrease}MB`
          })
        ]
      })
    }

    // 发送系统通知
    try {
      new Notification({
        title: '模型池-人物志矩阵生成完成',
        body: `使用 ${models.length} 个模型，识别 ${matrixData.metadata.totalCharacters} 个角色，生成 ${outputFiles.length} 个输出文件`,
        silent: false
      }).show()
      logger.info('【模型池】Task completion notification sent', {
        characters: matrixData.metadata.totalCharacters,
        files: outputFiles.length,
        models: models.length
      })
    } catch (notifError) {
      logger.warn('Failed to show notification', notifError as Error)
    }

    // 返回结果
    return {
      merged: primaryOutput,
      chunks: [],
      characterMatrix: matrixData
    }

  } catch (error) {
    if ((error as Error).name === 'AbortError' || (error as Error).message.includes('用户取消')) {
      logger.info('【模型池】Character matrix analysis was cancelled.')
      const currentState = memoryService.getState()
      memoryService.updateState({
        isProcessing: false,
        progress: {
          current: currentState.progress?.current ?? 0,
          total: currentState.progress?.total ?? totalChunks,
          percentage: currentState.progress?.percentage ?? 0,
          stage: 'cancelled'
        }
      })
      throw new NovelCompressionError('用户取消了分析任务')
    } else {
      logger.error('【模型池】Character matrix analysis failed', error as Error)
      const currentState = memoryService.getState()

      // 收集失败摘要
      const failedChunks = currentState.chunkSummaries.filter(cs => cs.status === 'error')
      const errorSummary = {
        message: (error as Error).message,
        stack: (error as Error).stack,
        totalChunks,
        modelCount: models.length,
        completedChunks: currentState.chunkSummaries.filter(cs => cs.status === 'completed').length,
        failedChunks: failedChunks.length,
        failureDetails: failedChunks.map(cs => ({
          index: cs.index + 1,
          error: cs.errorMessage
        }))
      }

      memoryService.updateState({
        isProcessing: false,
        progress: {
          current: currentState.progress?.current ?? 0,
          total: totalChunks,
          percentage: calculatePercentage(currentState.progress?.current ?? 0, totalChunks),
          stage: 'failed'
        },
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('error', '【模型池-矩阵模式】分析任务失败', errorSummary)
        ]
      })

      // 发送失败通知
      try {
        new Notification({
          title: '模型池-矩阵分析失败',
          body: `任务失败: ${(error as Error).message.substring(0, 100)}`,
          silent: false
        }).show()
      } catch (notifError) {
        logger.warn('Failed to show error notification', notifError as Error)
      }

      throw error instanceof NovelCompressionError
        ? error
        : new NovelCompressionError('【模型池】矩阵分析过程中出现错误', error)
    }
  }
}


async function compressNovelWithModel(
  model: Model,
  providerConfig: { providerId: ProviderId; options: any },
  content: string,
  options: NovelCompressionOptions,
  outputPath?: string
): Promise<NovelCompressionResult> {
  const memoryService = novelCharacterMemoryService
  const signal = abortController.signal
  options.signal = signal
  
  // 检查是否为矩阵模式
  const state = memoryService.getState()
  if (state.characterMode === 'matrix') {
    logger.info('Switching to character matrix mode')
    
    if (!outputPath) {
      throw new NovelCompressionError('矩阵模式需要指定输出路径')
    }
    
    return analyzeNovelCharacterMatrix(
      model,
      providerConfig,
      content,
      options,
      outputPath,
      state.characterOutputFormat || 'markdown'
    )
  }
  
  // 传统模式继续原有逻辑
  logger.info('Novel compression started (traditional mode)', { modelId: model.id, providerId: providerConfig.providerId })

  if (!model) {
    throw new NovelCompressionError('未选择任何模型')
  }
  if (!content || content.trim().length === 0) {
    throw new NovelCompressionError('文本内容为空，无法阅读')
  }

  const normalizedRatio = clamp(options.ratio, 0.01, 0.9)
  const normalizedChunkSize = Math.max(500, Math.min(500000, Math.floor(options.chunkSize)))
  const normalizedOverlap = clamp(Math.floor(options.overlap), 0, normalizedChunkSize - 1)
  const normalizedTemperature = clamp(options.temperature, 0, 1.5)

  const chunks = splitTextIntoChunks(content, normalizedChunkSize, normalizedOverlap, normalizedRatio)
  const totalChunks = chunks.length

  if (totalChunks === 0) {
    throw new NovelCompressionError('无法根据当前设置生成有效的文本分块')
  }

  let outputDir = ''
  let baseName = ''
  const existingChunks: CompressionChunk[] = []
  let existingChunkIndices: Set<number> = new Set()

  if (outputPath) {
    try {
      const currentState = memoryService.getState()
      const targetCharactersForFolder = currentState.targetCharacterConfig?.enabled
        ? currentState.targetCharacterConfig.characters
        : undefined

      baseName = getTaskBaseNameFromOutputPath(outputPath, currentState.selectedFile)
      const { chunksDir } = await createOutputDirectory(
        outputPath,
        baseName,
        !!currentState.continueLatestTask,
        targetCharactersForFolder
      )
      outputDir = chunksDir
      const { existingChunks: existingSet } = await detectExistingChunks(outputDir, totalChunks)
      existingChunkIndices = existingSet

      if (existingChunkIndices.size > 0) {
        for (const chunkIndex of existingChunkIndices) {
          if (chunkIndex < chunks.length) {
            try {
              const chunkFileName = `${baseName}_output_${chunkIndex + 1}.txt`
              const chunkFilePath = path.join(outputDir, chunkFileName)
              const chunkContent = await fs.readFile(chunkFilePath, 'utf-8')
              existingChunks[chunkIndex] = { ...chunks[chunkIndex], compressed: chunkContent.trim() }
            } catch (error) {
              logger.warn(`读取块文件失败: ${chunkIndex + 1}`, error as Error)
            }
          }
        }
        const log = createLogEntry(
          'info',
          `检测到 ${existingChunkIndices.size} 个已完成块，将跳过这些块。`,
          {
            completedCount: existingChunkIndices.size,
            totalChunks,
            existingChunks: Array.from(existingChunkIndices)
              .sort((a, b) => a - b)
              .map((i) => i + 1)
          }
        )
        memoryService.updateState({ logs: [...memoryService.getState().logs, log] })
      }
    } catch (error) {
      logger.warn('检测分块文件失败，从头开始阅读', error as Error)
    }
  }

  memoryService.updateState({
    progress: {
      current: existingChunkIndices.size,
      total: totalChunks,
      percentage: calculatePercentage(existingChunkIndices.size, totalChunks),
      stage: 'initializing'
    },
    logs: [
      ...memoryService.getState().logs,
      createLogEntry('info', '已生成小说分块', {
        totalChunks,
        chunkSize: normalizedChunkSize,
        overlap: normalizedOverlap,
        ratio: normalizedRatio,
        resumedChunkCount: existingChunkIndices.size
      })
    ],
    chunkSummaries: Array.from({ length: totalChunks }, (_, index) => ({
      index,
      status: existingChunkIndices.has(index) ? 'completed' : 'pending',
      inputLength: chunks[index]?.text.length ?? 0,
      targetLength: chunks[index]?.targetLength ?? 0
    }))
  })

  try {
    // 注册AI Provider（清理后重新注册，确保状态一致性）
    clearAllProviders()
    const { providerId, options: providerOptions } = providerConfig
    await createAndRegisterProvider(providerId, providerOptions)

    memoryService.updateState({
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', '模型提供方已注册完成', { providerId, modelId: model.id })
      ]
    })

    const executor = createExecutor(providerId, { ...providerOptions, mode: 'chat' })
    const compressedChunks: CompressionChunk[] = [...existingChunks]
    const maxRetries = options.maxRetries ?? 3
    const baseRetryDelay = options.retryDelay ?? 3000

    for (let i = 0; i < totalChunks; i += 1) {
      if (existingChunkIndices.has(i)) {
        continue
      }
      const chunk = chunks[i]
      const startedAt = Date.now()

      memoryService.updateState({
        progress: {
          current: i,
          total: totalChunks,
          percentage: calculatePercentage(i, totalChunks),
          stage: 'compressing'
        },
        chunkSummaries: memoryService.getState().chunkSummaries.map((cs, idx) =>
          idx === i
            ? {
                ...cs,
                status: 'processing',
                startedAt
              }
            : cs
        ),
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('info', `开始阅读第 ${i + 1}/${totalChunks} 段`, {
            chunkIndex: i,
            chunkLength: chunk.text.length
          })
        ]
      })

      let retryCount = 0
      let success = false

      let lastError: Error | null = null
      while (!success && retryCount <= maxRetries) {
        if (signal.aborted || options.signal?.aborted) {
          memoryService.updateState({
            progress: {
              current: i,
              total: totalChunks,
              percentage: calculatePercentage(i, totalChunks),
              stage: 'cancelled'
            },
            logs: [
              ...memoryService.getState().logs,
              createLogEntry('warning', '用户取消了阅读任务', { chunkIndex: i })
            ]
          })
          throw new NovelCompressionError('用户取消了阅读任务')
        }

        try {
          if (retryCount > 0) {
            const retryDelay = baseRetryDelay * Math.pow(2, retryCount - 1)
            memoryService.updateState({
              logs: [
                ...memoryService.getState().logs,
                createLogEntry(
                  'retry',
                  `第 ${i + 1}/${totalChunks} 段重试 ${retryCount}/${maxRetries}，等待 ${Math.round(
                    retryDelay / 1000
                  )}s 后重试`,
                  { chunkIndex: i, retryCount, maxRetries, delayMs: retryDelay }
                )
              ]
            })
            await new Promise((resolve) => setTimeout(resolve, retryDelay))
          }

          const response = await createCancellablePromise<GenerateTextResponse>(
            executor.generateText({
              model: model.id,
              messages: buildCompressionMessages(
                chunk,
                normalizedRatio,
                options.customPrompt,
                i === totalChunks - 1,
                memoryService.getState().targetCharacters
              ),
              temperature: normalizedTemperature,
              signal: options.signal
            }),
            options.signal!
          )

          if (!response) throw new Error(`第${i + 1}段：模型返回空响应`)
          const compressedText = response.text?.trim() ?? ''
          if (!compressedText) {
            logger.warn(`Model returned empty text for chunk ${i + 1}. Full response:`, {
              response: JSON.stringify(response, null, 2)
            })
            throw new Error(`第${i + 1}段：模型返回空文本`)
          }

          if (signal.aborted || options.signal?.aborted) {
            throw new NovelCompressionError('用户取消了阅读任务')
          }

          const completedAt = Date.now()
          const compressedChunk: CompressionChunk = { ...chunk, compressed: compressedText }
          compressedChunks.push(compressedChunk)

          if (outputDir && baseName && compressedText) {
            try {
              await saveChunkFile(outputDir, baseName, i, compressedText)
              logger.info(`块文件已保存: ${baseName}_output_${i + 1}.txt`)
            } catch (saveError) {
              logger.warn(`保存块文件失败: ${i + 1}`, saveError as Error)
              memoryService.updateState({
                logs: [
                  ...memoryService.getState().logs,
                  createLogEntry('warning', `块文件 ${i + 1} 保存失败，但处理继续进行`, {
                    chunkIndex: i,
                    error: (saveError as Error).message
                  })
                ]
              })
            }
          }

          const usage = extractUsageMetrics(response)
          const durationMs = completedAt - startedAt

          memoryService.updateState({
            progress: {
              current: i + 1,
              total: totalChunks,
              percentage: calculatePercentage(i + 1, totalChunks),
              stage: 'compressing'
            },
            chunkSummaries: memoryService.getState().chunkSummaries.map((cs, idx) =>
              idx === i
                ? {
                    ...cs,
                    status: 'completed',
                    outputLength: compressedText.length,
                    usage,
                    durationMs,
                    finishedAt: completedAt
                  }
                : cs
            ),
            logs: [
              ...memoryService.getState().logs,
              createLogEntry(
                'info',
                `完成阅读第 ${i + 1}/${totalChunks} 段${
                  retryCount > 0 ? ` (重试${retryCount}次后成功)` : ''
                }`,
                { chunkIndex: i, durationMs, usage, retryCount }
              )
            ]
          })

          success = true
        } catch (error) {
          if ((error as Error).name === 'AbortError') {
            logger.info(`Chunk ${i + 1} processing was aborted.`)
            // 直接抛出，由外层catch处理取消状态
            throw new NovelCompressionError('用户取消了阅读任务')
          }

          lastError = error as Error
          retryCount++

          const isRateLimitError =
            lastError.message.includes('no candidates returned') ||
            lastError.message.includes('rate limit') ||
            lastError.message.includes('quota') ||
            lastError.message.includes('too many requests')

          if (isRateLimitError && retryCount <= maxRetries) {
            memoryService.updateState({
              logs: [
                ...memoryService.getState().logs,
                createLogEntry(
                  'warning',
                  `第 ${i + 1}/${totalChunks} 段遇到API限制，准备重试 ${retryCount}/${maxRetries}`,
                  { chunkIndex: i, retryCount, maxRetries, error: lastError.message }
                )
              ]
            })
          } else if (retryCount > maxRetries) {
            const errorMessage = `第 ${i + 1}/${totalChunks} 段重试 ${maxRetries} 次后仍然失败: ${
              lastError.message
            }`
            memoryService.updateState({
              progress: {
                current: i,
                total: totalChunks,
                percentage: calculatePercentage(i, totalChunks),
                stage: 'failed'
              },
              logs: [
                ...memoryService.getState().logs,
                createLogEntry('error', errorMessage + ` (可尝试从第 ${i + 1} 段断点续传)`, {
                  chunkIndex: i,
                  totalChunks,
                  resumeFromChunk: i,
                  preview: chunk.text.substring(0, 100)
                })
              ]
            })
            throw new NovelCompressionError(
              errorMessage + ` 建议稍后使用断点续传从第 ${i + 1} 段继续`,
              {
                chunkIndex: i,
                totalChunks,
                resumeFromChunk: i,
                chunkText: chunk.text.substring(0, 100) + (chunk.text.length > 100 ? '...' : ''),
                originalError: lastError
              }
            )
          } else {
            memoryService.updateState({
              logs: [
                ...memoryService.getState().logs,
                createLogEntry(
                  'warning',
                  `第 ${i + 1}/${totalChunks} 段出现错误，准备重试 ${retryCount}/${maxRetries}: ${
                    lastError.message
                  }`,
                  { chunkIndex: i, retryCount, maxRetries, error: lastError.message }
                )
              ]
            })
          }
        }
      }
    }

    memoryService.updateState({
      progress: { current: totalChunks, total: totalChunks, percentage: 100, stage: 'finalizing' },
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', '所有分段阅读完成', { totalChunks })
      ]
    })

    let finalOutput = ''
    if (outputDir && baseName && outputPath) {
      try {
        finalOutput = await mergeChunkFiles(outputDir, baseName, totalChunks, outputPath)
        memoryService.updateState({
          logs: [
            ...memoryService.getState().logs,
            createLogEntry('info', '所有块文件已合并到最终输出文件', {
              outputPath,
              totalChunks,
              outputLength: finalOutput.length
            })
          ]
        })
      } catch (mergeError) {
        logger.warn('合并块文件失败，使用内存中的结果', mergeError as Error)
        finalOutput = compressedChunks
          .map((chunk) => chunk.compressed)
          .filter(Boolean)
          .join('\n\n')
        if (outputPath) {
          try {
            await fs.writeFile(outputPath, finalOutput, 'utf-8')
          } catch (writeError) {
            logger.error('写入最终输出文件失败', writeError as Error)
          }
        }
      }
    } else {
      finalOutput = compressedChunks
        .map((chunk) => chunk.compressed)
        .filter(Boolean)
        .join('\n\n')
    }

    memoryService.updateState({
      progress: { current: totalChunks, total: totalChunks, percentage: 100, stage: 'completed' },
      // outputDir 是“分块内容”目录；这里保存其父目录作为任务根目录（带时间戳）
      outputPath: outputDir ? path.dirname(outputDir) : outputPath ? path.dirname(outputPath) : undefined,
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', '小说阅读任务完成', {
          outputLength: finalOutput.length,
          totalChunks: compressedChunks.length
        })
      ]
    })

    // 获取目标角色列表（用于通知和后续处理）
    const targetCharacters = memoryService.getState().targetCharacters

    // 发送系统通知（传统模式）
    try {
      const characterCount = targetCharacters.length
      new Notification({
        title: '小说阅读任务完成',
        body: characterCount > 0 
          ? `已完成 ${totalChunks} 个分段的阅读，生成 ${characterCount} 个角色人物志`
          : `已完成 ${totalChunks} 个分段的阅读`,
        silent: false
      }).show()
      logger.info('Traditional mode task completion notification sent', {
        chunks: totalChunks,
        characters: characterCount
      })
    } catch (notifError) {
      logger.warn('Failed to show notification', notifError as Error)
    }

    // 如果有目标角色，提取并总结角色人物志
    let characterProfiles: Record<string, string> | undefined
    
    logger.info('开始处理人物志总结', { targetCharactersCount: targetCharacters.length })
    
    if (targetCharacters.length > 0) {
      memoryService.updateState({
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('info', '开始提取角色信息片段', {
            characterCount: targetCharacters.length,
            characters: targetCharacters
          })
        ]
      })
      
      // 第一步：从合并文本中提取各角色的信息片段
      const extractedProfiles = extractCharacterProfiles(finalOutput, targetCharacters)
      
      logger.info('提取角色信息完成', { 
        extractedCount: Object.keys(extractedProfiles).length,
        profiles: Object.fromEntries(
          Object.entries(extractedProfiles).map(([name, info]) => [name, info.substring(0, 100) + '...'])
        )
      })
      
      memoryService.updateState({
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('info', '角色信息提取完成，开始生成最终人物志', {
            extractedCount: Object.keys(extractedProfiles).length
          })
        ]
      })
      
      // 第二步：对提取的信息进行最终总结，生成精炼人物志
      try {
        characterProfiles = await synthesizeFinalCharacterBios(
          extractedProfiles,
          targetCharacters,
          executor,
          model,
          normalizedTemperature,
          options.signal
        )
        
        logger.info('最终人物志生成成功', { 
          characterCount: Object.keys(characterProfiles).length 
        })
        
        // 将最终人物志追加到输出文件
        if (outputPath && characterProfiles) {
          const characterBiosText = '\n\n' + '='.repeat(80) + '\n' +
            '最终人物志总结\n' +
            '='.repeat(80) + '\n\n' +
            Object.values(characterProfiles).join('\n\n' + '-'.repeat(80) + '\n\n')
          
          const finalOutputWithBios = finalOutput + characterBiosText
          
          try {
            await fs.writeFile(outputPath, finalOutputWithBios, 'utf-8')
            logger.info('最终人物志已追加到输出文件', { outputPath })
            memoryService.updateState({
              logs: [
                ...memoryService.getState().logs,
                createLogEntry('info', '最终人物志已追加到输出文件', {
                  characterCount: Object.keys(characterProfiles).length,
                  outputPath
                })
              ]
            })
            // 更新 finalOutput 以便返回完整内容
            finalOutput = finalOutputWithBios
          } catch (writeError) {
            logger.error('追加最终人物志到文件失败', writeError as Error)
            memoryService.updateState({
              logs: [
                ...memoryService.getState().logs,
                createLogEntry('error', '追加最终人物志到文件失败', {
                  error: (writeError as Error).message
                })
              ]
            })
          }
        }
      } catch (error) {
        logger.error('Failed to synthesize final character bios, using extracted profiles', error as Error)
        memoryService.updateState({
          logs: [
            ...memoryService.getState().logs,
            createLogEntry('error', '最终人物志生成失败，使用提取信息作为降级方案', {
              error: (error as Error).message
            })
          ]
        })
        // 降级使用提取的信息
        characterProfiles = Object.fromEntries(
          Object.entries(extractedProfiles).map(([name, info]) => [name, `【${name}】\n\n${info}`])
        )
        
        // 即使降级，也要追加到输出文件
        if (outputPath && characterProfiles) {
          const characterBiosText = '\n\n' + '='.repeat(80) + '\n' +
            '最终人物志总结（降级版本）\n' +
            '='.repeat(80) + '\n\n' +
            Object.values(characterProfiles).join('\n\n' + '-'.repeat(80) + '\n\n')
          
          const finalOutputWithBios = finalOutput + characterBiosText
          
          try {
            await fs.writeFile(outputPath, finalOutputWithBios, 'utf-8')
            finalOutput = finalOutputWithBios
          } catch (writeError) {
            logger.error('追加降级人物志到文件失败', writeError as Error)
          }
        }
      }
    } else {
      logger.warn('未设置目标角色，跳过人物志总结')
      memoryService.updateState({
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('warning', '未设置目标角色，跳过人物志总结功能')
        ]
      })
    }

    return {
      merged: finalOutput,
      chunks: compressedChunks,
      characterProfiles
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError' || (error as Error).message.includes('用户取消')) {
      logger.info('Single-model compression task was cancelled.')
      const currentState = memoryService.getState()
      memoryService.updateState({
        isProcessing: false,
        progress: {
          current: currentState.progress?.current ?? 0,
          total: currentState.progress?.total ?? totalChunks,
          percentage: currentState.progress?.percentage ?? 0,
          stage: 'cancelled'
        }
      })
      throw new NovelCompressionError('用户取消了分析任务')
    } else {
      logger.error('Novel compression failed', error as Error)
      const currentState = memoryService.getState()
      
      // 收集失败摘要
      const failedChunks = currentState.chunkSummaries.filter(cs => cs.status === 'error')
      const errorSummary = {
        message: (error as Error).message,
        stack: (error as Error).stack,
        totalChunks,
        completedChunks: currentState.chunkSummaries.filter(cs => cs.status === 'completed').length,
        failedChunks: failedChunks.length,
        failureDetails: failedChunks.map(cs => ({
          index: cs.index + 1,
          error: cs.errorMessage
        }))
      }
      
      memoryService.updateState({
        progress: {
          current: currentState.progress?.current ?? 0,
          total: totalChunks,
          percentage: calculatePercentage(currentState.progress?.current ?? 0, totalChunks),
          stage: 'failed'
        },
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('error', '小说阅读任务失败', errorSummary)
        ]
      })
      
      // 发送失败通知
      try {
        new Notification({
          title: '阅读任务失败',
          body: `任务失败: ${(error as Error).message.substring(0, 100)}`,
          silent: false
        }).show()
      } catch (notifError) {
        logger.warn('Failed to show error notification', notifError as Error)
      }
      
      throw error instanceof NovelCompressionError
        ? error
        : new NovelCompressionError('阅读过程中出现错误', error)
    }
  }
}
function calculatePercentage(current: number, total: number): number {
  if (total <= 0) {
    return 0
  }
  return Math.min(100, Math.max(0, Math.round((current / total) * 100)))
}

function extractUsageMetrics(response: any): Record<string, number> | undefined {
  const usageSource = response?.usage ?? response?.response?.usage
  if (!usageSource || typeof usageSource !== 'object') {
    return undefined
  }

  const usageEntries: Record<string, number> = {}
  for (const [key, value] of Object.entries(usageSource)) {
    if (typeof value === 'number') {
      usageEntries[key] = value
    }
  }

  return Object.keys(usageEntries).length > 0 ? usageEntries : undefined
}

// clamp 函数已移至 @main/utils/novel-utils

// 进度信息相关类型和函数
// interface ProgressMetadata {
//   totalChunks: number
//   completedChunks: number
//   modelId?: string
//   providerId?: string
//   timestamp: string
//   status: 'in_progress' | 'completed' | 'failed'
//   chunkStatus?: Array<{
//     index: number
//     status: 'completed' | 'pending' | 'failed'
//     length?: number
//   }>
// }

// function generateProgressInfo(
//   allChunks: CompressionChunk[],
//   completedChunks: CompressionChunk[],
//   metadata: ProgressMetadata
// ): string {
//   const chunkStatus = allChunks.map(chunk => {
//     const completed = completedChunks.find(c => c.index === chunk.index)
//     return {
//       index: chunk.index,
//       status: completed ? 'completed' as const : 'pending' as const,
//       length: completed?.compressed?.length
//     }
//   })

//   const progressData = {
//     ...metadata,
//     chunkStatus
//   }

//   const progressJson = JSON.stringify(progressData, null, 2)
  
//   return `\n\n<!-- COMPRESSION_PROGRESS_START\n${progressJson}\nCOMPRESSION_PROGRESS_END -->`
// }

// function parseProgressInfo(content: string): ProgressMetadata | null {
//   const progressMatch = content.match(/<!-- COMPRESSION_PROGRESS_START\n([\s\S]*?)\nCOMPRESSION_PROGRESS_END -->/)
//   if (!progressMatch) {
//     return null
//   }

//   try {
//     return JSON.parse(progressMatch[1])
//   } catch (error) {
//     return null
//   }
// }

// function extractContentWithoutProgress(content: string): string {
//   return content.replace(/\n\n<!-- COMPRESSION_PROGRESS_START[\s\S]*?COMPRESSION_PROGRESS_END -->/, '')
// }

// function detectResumePointFromFile(filePath: string): Promise<number | null> {
//   return new Promise((resolve) => {
//     // 这里应该读取文件内容，但由于我们在主进程中，需要使用 Node.js 的 fs 模块
//     // 暂时返回 null，让前端处理文件读取
//     resolve(null)
//   })
// }

async function compressNovelWithMultipleModels(
  models: Model[],
  providerConfigs: { modelId: string; providerId: ProviderId; options: any }[],
  content: string,
  options: NovelCompressionOptions,
  outputPath?: string,
  targetCharacters?: string[]
): Promise<NovelCompressionResult> {
  const memoryService = novelCharacterMemoryService
  const signal = abortController.signal
  options.signal = signal
  
  // 检查是否为矩阵模式
  const state = memoryService.getState()
  if (state.characterMode === 'matrix') {
    logger.info('Matrix mode detected with multiple models, using model pool')
    
    if (!outputPath) {
      throw new NovelCompressionError('矩阵模式需要指定输出路径')
    }
    
    // 使用模型池进行矩阵分析
    return analyzeNovelCharacterMatrixWithModelPool(
      models,
      providerConfigs,
      content,
      options,
      outputPath,
      state.characterOutputFormat || 'markdown'
    )
  }
  
  // 传统多模型模式继续原有逻辑
  logger.info('Multi-model novel compression started (traditional mode)', {
    modelCount: models.length,
    modelIds: models.map((m) => m.id)
  })

  if (!models || models.length === 0) {
    throw new NovelCompressionError('未选择任何模型')
  }
  if (!content || content.trim().length === 0) {
    throw new NovelCompressionError('文本内容为空，无法阅读')
  }

  const normalizedRatio = clamp(options.ratio, 0.01, 0.9)
  const normalizedChunkSize = Math.max(500, Math.min(500000, Math.floor(options.chunkSize)))
  const normalizedOverlap = clamp(Math.floor(options.overlap), 0, normalizedChunkSize - 1)
  clamp(options.temperature, 0, 1.5)

  const chunks = splitTextIntoChunks(content, normalizedChunkSize, normalizedOverlap, normalizedRatio)
  const totalChunks = chunks.length

  if (totalChunks === 0) {
    throw new NovelCompressionError('无法根据当前设置生成有效的文本分块')
  }

  let outputDir = ''
  let baseName = ''

  if (outputPath) {
    try {
      const currentState = memoryService.getState()
      const targetCharactersForFolder = currentState.targetCharacterConfig?.enabled
        ? currentState.targetCharacterConfig.characters
        : undefined

      baseName = getTaskBaseNameFromOutputPath(outputPath, currentState.selectedFile)
      const { chunksDir } = await createOutputDirectory(
        outputPath,
        baseName,
        !!currentState.continueLatestTask,
        targetCharactersForFolder
      )
      outputDir = chunksDir
      const { existingChunks: existingChunkIndices } = await detectExistingChunks(outputDir, totalChunks)

      if (existingChunkIndices.size > 0) {
        let maxContinuousIndex = 0
        while (existingChunkIndices.has(maxContinuousIndex)) {
          maxContinuousIndex++
        }
        options.resumeFromChunk = Math.max(options.resumeFromChunk ?? 0, maxContinuousIndex)
        const log = createLogEntry(
          'info',
          `多模型压缩检测到 ${existingChunkIndices.size} 个已完成块，从第 ${
            (options.resumeFromChunk ?? 0) + 1
          } 块开始`,
          {
            resumeFromChunk: options.resumeFromChunk,
            totalChunks,
            existingChunks: Array.from(existingChunkIndices)
              .sort((a, b) => a - b)
              .map((i: number) => i + 1)
          }
        )
        memoryService.updateState({ logs: [...memoryService.getState().logs, log] })
      }
    } catch (error) {
      logger.warn('多模型阅读检测分块文件失败，从头开始阅读', error as Error)
    }
  }

  memoryService.updateState({
    progress: {
      current: 0,
      total: totalChunks,
      percentage: calculatePercentage(0, totalChunks),
      stage: 'initializing'
    },
    logs: [
      ...memoryService.getState().logs,
      createLogEntry('info', '已生成小说分块', {
        totalChunks,
        chunkSize: normalizedChunkSize,
        overlap: normalizedOverlap,
        ratio: normalizedRatio,
        modelCount: models.length
      })
    ],
    chunkSummaries: Array.from({ length: totalChunks }, (_, index) => ({
      index,
      status: 'pending',
      inputLength: chunks[index]?.text.length ?? 0,
      targetLength: chunks[index]?.targetLength ?? 0
    }))
  })

  try {
    // 清理所有已注册的 provider，确保状态一致性
    clearAllProviders()
    const modelExecutors: ModelExecutor[] = []
    for (const config of providerConfigs) {
      const model = models.find((m) => m.id === config.modelId)
      if (!model) continue

      // 注册 provider
      await createAndRegisterProvider(config.providerId, config.options)
      const executor = createExecutor(config.providerId, { ...config.options, mode: 'chat' })

      modelExecutors.push({
        model,
        provider: null as any, // Provider object is no longer needed here
        executor,
        providerId: config.providerId,
        providerOptions: config.options,
        index: modelExecutors.length  // 添加索引字段以满足类型要求
      })
    }

    if (modelExecutors.length === 0) {
      throw new NovelCompressionError('没有可用的模型执行器')
    }
    memoryService.updateState({
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', '多模型执行器已准备完成', {
          executorCount: modelExecutors.length,
          models: modelExecutors.map((e) => ({ modelId: e.model.id, providerId: e.providerId }))
        })
      ]
    })

    const compressedChunks: CompressionChunk[] = []
    const startFromChunk = options.resumeFromChunk ?? 0

    if (startFromChunk > 0) {
      memoryService.updateState({
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('info', `断点续传：从第 ${startFromChunk + 1} 段开始多模型阅读`, {
            startFromChunk,
            totalChunks,
            modelCount: modelExecutors.length
          })
        ]
      })
    }

    // --- New Dynamic Scheduling Logic ---

    const { existingChunks: existingChunkIndices } = await detectExistingChunks(outputDir, totalChunks)
    const pendingChunkIndexes: number[] = []
    for (let i = 0; i < totalChunks; i++) {
      if (!existingChunkIndices.has(i)) {
        pendingChunkIndexes.push(i)
      }
    }

    // Shared state for workers
    const availableModelExecutors = [...modelExecutors]
    const failedModelIds = new Set<string>()
    let modelRoundRobinIndex = 0

    // 并发数等于可用模型数，让每个模型都能同时工作
    const concurrency = availableModelExecutors.length
    const processingPromises: Promise<void>[] = []

    const getNextModel = (): ModelExecutor | null => {
      if (availableModelExecutors.length === 0) return null
      modelRoundRobinIndex = (modelRoundRobinIndex + 1) % availableModelExecutors.length
      return availableModelExecutors[modelRoundRobinIndex]
    }

    for (let i = 0; i < concurrency; i++) {
      processingPromises.push(
        processChunkDynamically(
          pendingChunkIndexes,
          chunks,
          availableModelExecutors,
          failedModelIds,
          getNextModel,
          options,
          compressedChunks,
          totalChunks,
          outputDir,
          baseName,
          options.customPrompt,
          targetCharacters
        )
      )
    }

    const results = await Promise.allSettled(processingPromises)

    const failedModels = new Set<string>()
    results.forEach((result) => {
      if (result.status === 'rejected') {
        logger.warn(`[NovelCompressionService] A model worker failed during compression.`, {
          reason: result.reason
        })
        if (
          result.reason instanceof NovelCompressionError &&
          typeof result.reason.detail === 'object' &&
          result.reason.detail !== null &&
          'modelId' in result.reason.detail
        ) {
          failedModels.add(result.reason.detail.modelId as string)
        }
      }
    })

    // If the number of failed models equals the total number of models, then the entire task is a failure.
    if (failedModels.size === models.length) {
      logger.error('[NovelCompressionService] All available models failed during compression task.')
      throw new NovelCompressionError(
        '所有模型均压缩失败',
        results
          .filter((r) => r.status === 'rejected')
          .map((r) => (r as PromiseRejectedResult).reason)
      )
    }

    memoryService.updateState({
      progress: { current: totalChunks, total: totalChunks, percentage: 100, stage: 'finalizing' },
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', '所有分段多模型阅读完成', {
          totalChunks,
          modelCount: modelExecutors.length
        })
      ]
    })

    const sortedChunks = compressedChunks.sort((a, b) => a.index - b.index)

    let finalOutput = ''
    if (outputDir && baseName && outputPath) {
      try {
        finalOutput = await mergeChunkFiles(outputDir, baseName, totalChunks, outputPath)
        memoryService.updateState({
          logs: [
            ...memoryService.getState().logs,
            createLogEntry('info', '多模型阅读：所有块文件已合并到最终输出文件', {
              outputPath,
              totalChunks,
              outputLength: finalOutput.length,
              modelCount: modelExecutors.length
            })
          ]
        })
      } catch (mergeError) {
        logger.warn('多模型压缩：合并块文件失败，使用内存中的结果', mergeError as Error)
        finalOutput = sortedChunks
          .map((chunk) => chunk.compressed)
          .filter(Boolean)
          .join('\n\n')
        if (outputPath) {
          try {
            await fs.writeFile(outputPath, finalOutput, 'utf-8')
          } catch (writeError) {
            logger.error('多模型阅读：写入最终输出文件失败', writeError as Error)
          }
        }
      }
    } else {
      finalOutput = sortedChunks
        .map((chunk) => chunk.compressed)
        .filter(Boolean)
        .join('\n\n')
    }

    memoryService.updateState({
      progress: { current: totalChunks, total: totalChunks, percentage: 100, stage: 'completed' },
      // outputDir 是“分块内容”目录；这里保存其父目录作为任务根目录（带时间戳）
      outputPath: outputDir ? path.dirname(outputDir) : outputPath ? path.dirname(outputPath) : undefined,
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', '多模型小说阅读任务完成', {
          outputLength: finalOutput.length,
          totalChunks: sortedChunks.length,
          modelCount: modelExecutors.length
        })
      ]
    })

    // 使用传入的 targetCharacters 参数（如果未提供则使用空数组）
    const effectiveTargetCharacters = targetCharacters || []

    // 发送系统通知（多模型模式）
    try {
      const characterCount = effectiveTargetCharacters.length
      new Notification({
        title: '多模型阅读任务完成',
        body: characterCount > 0
          ? `使用 ${modelExecutors.length} 个模型完成 ${totalChunks} 个分段，生成 ${characterCount} 个角色人物志`
          : `使用 ${modelExecutors.length} 个模型完成 ${totalChunks} 个分段的阅读`,
        silent: false
      }).show()
      logger.info('Multi-model task completion notification sent', {
        chunks: totalChunks,
        models: modelExecutors.length,
        characters: characterCount
      })
    } catch (notifError) {
      logger.warn('Failed to show notification', notifError as Error)
    }

    // 如果有目标角色，提取并总结角色人物志
    let characterProfiles: Record<string, string> | undefined

    logger.info('多模型：开始处理人物志总结', { targetCharactersCount: effectiveTargetCharacters.length })

    if (effectiveTargetCharacters.length > 0 && modelExecutors.length > 0) {
      memoryService.updateState({
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('info', '多模型：开始提取角色信息片段', {
            characterCount: effectiveTargetCharacters.length,
            characters: effectiveTargetCharacters
          })
        ]
      })

      // 第一步：从合并文本中提取各角色的信息片段
      const extractedProfiles = extractCharacterProfiles(finalOutput, effectiveTargetCharacters)

      logger.info('多模型：提取角色信息完成', { 
        extractedCount: Object.keys(extractedProfiles).length 
      })
      
      memoryService.updateState({
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('info', '多模型：角色信息提取完成，开始生成最终人物志', {
            extractedCount: Object.keys(extractedProfiles).length,
            usingModel: modelExecutors[0].model.name
          })
        ]
      })
      
      // 第二步：对提取的信息进行最终总结，生成精炼人物志（使用第一个可用模型）
      const firstExecutor = modelExecutors[0]
      try {
        characterProfiles = await synthesizeFinalCharacterBios(
          extractedProfiles,
          effectiveTargetCharacters,
          firstExecutor.executor,
          firstExecutor.model,
          options.temperature,
          options.signal
        )
        
        logger.info('多模型：最终人物志生成成功', { 
          characterCount: Object.keys(characterProfiles).length 
        })
        
        // 将最终人物志追加到输出文件
        if (outputPath && characterProfiles) {
          const characterBiosText = '\n\n' + '='.repeat(80) + '\n' +
            '最终人物志总结\n' +
            '='.repeat(80) + '\n\n' +
            Object.values(characterProfiles).join('\n\n' + '-'.repeat(80) + '\n\n')
          
          const finalOutputWithBios = finalOutput + characterBiosText
          
          try {
            await fs.writeFile(outputPath, finalOutputWithBios, 'utf-8')
            logger.info('多模型：最终人物志已追加到输出文件', { outputPath })
            memoryService.updateState({
              logs: [
                ...memoryService.getState().logs,
                createLogEntry('info', '多模型：最终人物志已追加到输出文件', {
                  characterCount: Object.keys(characterProfiles).length,
                  outputPath
                })
              ]
            })
            // 更新 finalOutput 以便返回完整内容
            finalOutput = finalOutputWithBios
          } catch (writeError) {
            logger.error('多模型：追加最终人物志到文件失败', writeError as Error)
            memoryService.updateState({
              logs: [
                ...memoryService.getState().logs,
                createLogEntry('error', '多模型：追加最终人物志到文件失败', {
                  error: (writeError as Error).message
                })
              ]
            })
          }
        }
      } catch (error) {
        logger.error('Failed to synthesize final character bios in multi-model mode, using extracted profiles', error as Error)
        memoryService.updateState({
          logs: [
            ...memoryService.getState().logs,
            createLogEntry('error', '多模型：最终人物志生成失败，使用提取信息作为降级方案', {
              error: (error as Error).message
            })
          ]
        })
        // 降级使用提取的信息
        characterProfiles = Object.fromEntries(
          Object.entries(extractedProfiles).map(([name, info]) => [name, `【${name}】\n\n${info}`])
        )
        
        // 即使降级，也要追加到输出文件
        if (outputPath && characterProfiles) {
          const characterBiosText = '\n\n' + '='.repeat(80) + '\n' +
            '最终人物志总结（降级版本）\n' +
            '='.repeat(80) + '\n\n' +
            Object.values(characterProfiles).join('\n\n' + '-'.repeat(80) + '\n\n')
          
          const finalOutputWithBios = finalOutput + characterBiosText
          
          try {
            await fs.writeFile(outputPath, finalOutputWithBios, 'utf-8')
            finalOutput = finalOutputWithBios
          } catch (writeError) {
            logger.error('多模型：追加降级人物志到文件失败', writeError as Error)
          }
        }
      }
    } else {
      logger.warn('多模型：未设置目标角色或无可用模型，跳过人物志总结')
      memoryService.updateState({
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('warning', '多模型：未设置目标角色或无可用模型，跳过人物志总结功能')
        ]
      })
    }

    return {
      merged: finalOutput,
      chunks: sortedChunks,
      characterProfiles
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError' || (error as Error).message.includes('用户取消')) {
      logger.info('Multi-model compression task was cancelled.')
      const currentState = memoryService.getState()
      memoryService.updateState({
        isProcessing: false,
        progress: {
          current: currentState.progress?.current ?? 0,
          total: currentState.progress?.total ?? totalChunks,
          percentage: currentState.progress?.percentage ?? 0,
          stage: 'cancelled'
        }
      })
      throw new NovelCompressionError('用户取消了分析任务')
    } else {
      logger.error('Multi-model novel compression failed', error as Error)
      const currentState = memoryService.getState()
      
      // 收集失败摘要
      const failedChunks = currentState.chunkSummaries.filter(cs => cs.status === 'error')
      const errorSummary = {
        message: (error as Error).message,
        stack: (error as Error).stack,
        totalChunks,
        modelCount: models.length,
        completedChunks: currentState.chunkSummaries.filter(cs => cs.status === 'completed').length,
        failedChunks: failedChunks.length,
        failureDetails: failedChunks.map(cs => ({
          index: cs.index + 1,
          error: cs.errorMessage
        }))
      }
      
      memoryService.updateState({
        progress: {
          current: currentState.progress?.current ?? 0,
          total: totalChunks,
          percentage: calculatePercentage(currentState.progress?.current ?? 0, totalChunks),
          stage: 'failed'
        },
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('error', '多模型小说阅读任务失败', errorSummary)
        ]
      })
      
      // 发送失败通知
      try {
        new Notification({
          title: '多模型阅读失败',
          body: `任务失败: ${(error as Error).message.substring(0, 100)}`,
          silent: false
        }).show()
      } catch (notifError) {
        logger.warn('Failed to show error notification', notifError as Error)
      }
      
      throw error instanceof NovelCompressionError
        ? error
        : new NovelCompressionError('多模型阅读过程中出现错误', error)
    }
  }
}

async function processChunkDynamically(
  pendingChunkIndexes: number[],
  chunks: Omit<CompressionChunk, 'compressed'>[],
  availableModelExecutors: ModelExecutor[],
  failedModelIds: Set<string>,
  getNextModel: () => ModelExecutor | null,
  options: NovelCompressionOptions,
  compressedChunks: CompressionChunk[],
  totalChunks: number,
  outputDir: string,
  baseName: string,
  customPrompt?: string,
  targetCharacters?: string[]
): Promise<void> {
  const memoryService = novelCharacterMemoryService
  const signal = options.signal

  while (true) {
    if (signal?.aborted) {
      throw new NovelCompressionError('用户取消了阅读任务')
    }

    // Atomically get the next chunk index
    let chunkIndex: number | undefined
    // Basic synchronization by simple check-then-act
    if (pendingChunkIndexes.length > 0) {
      chunkIndex = pendingChunkIndexes.shift()
    }

    if (chunkIndex === undefined) {
      break // No more chunks to process
    }

    const chunk = chunks[chunkIndex]
    const startedAt = Date.now()

    memoryService.updateState({
      chunkSummaries: memoryService
        .getState()
        .chunkSummaries.map((cs, idx) =>
          idx === chunkIndex ? { ...cs, status: 'processing', startedAt } : cs
        )
    })

    let success = false
    let attempt = 0
    const attemptedModelsThisChunk = new Set<string>()

    while (!success) {
      if (signal?.aborted) {
        // If cancelled, put the chunk back in the queue and exit
        pendingChunkIndexes.unshift(chunkIndex)
        throw new NovelCompressionError('用户取消了阅读任务')
      }

      const modelExecutor = getNextModel()

      if (!modelExecutor) {
        // No models available, put chunk back and fail
        pendingChunkIndexes.unshift(chunkIndex)
        throw new NovelCompressionError('所有可用模型均已失败，无法继续处理。')
      }

      // Avoid re-trying a chunk with a model that has already failed on it
      if (attemptedModelsThisChunk.has(modelExecutor.model.id)) {
        if (attemptedModelsThisChunk.size === availableModelExecutors.length) {
          // All available models have been tried and failed for this chunk
          break
        }
        continue
      }
      attemptedModelsThisChunk.add(modelExecutor.model.id)
      attempt++

      let retryCount = 0

      memoryService.updateState({
        logs: [
          ...memoryService.getState().logs,
          createLogEntry(
            'info',
            `开始阅读第 ${chunkIndex + 1}/${totalChunks} 段 (第${attempt}次尝试, 使用模型: ${
              modelExecutor.model.name
            })`,
            { chunkIndex, modelId: modelExecutor.model.id }
          )
        ]
      })

      const maxRetries = options.maxRetries ?? 3
      const baseRetryDelay = options.retryDelay ?? 3000
      while (retryCount <= maxRetries) {
        try {
          // ... [The core generateText and result handling logic]
          const response = await createCancellablePromise<GenerateTextResponse>(
            modelExecutor.executor.generateText({
              model: modelExecutor.model.id,
              messages: buildCompressionMessages(
                chunk,
                options.ratio,
                customPrompt,
                chunkIndex === totalChunks - 1,
                targetCharacters
              ),
              temperature: options.temperature,
              signal: options.signal
            }),
            options.signal!
          )

          if (!response) throw new Error(`第${chunkIndex + 1}段：模型返回空响应`)
          const compressedText = response.text?.trim() ?? ''
          if (!compressedText) {
            logger.warn(`Model returned empty text for chunk ${chunkIndex + 1}. Full response:`, {
              response: JSON.stringify(response, null, 2)
            })
            throw new Error(`第${chunkIndex + 1}段：模型返回空文本`)
          }

          if (signal?.aborted) {
            throw new NovelCompressionError('用户取消了阅读任务')
          }

          const completedAt = Date.now()
          const compressedChunk: CompressionChunk = { ...chunk, compressed: compressedText }
          // Synchronize access to shared compressedChunks array
          compressedChunks.push(compressedChunk)

          if (outputDir && baseName && compressedText) {
            await saveChunkFile(outputDir, baseName, chunkIndex, compressedText)
          }

          // Update global state
          const currentState = memoryService.getState()
          const updatedSummaries = currentState.chunkSummaries.map((cs, idx) =>
            idx === chunkIndex
              ? ({
                  ...cs,
                  status: 'completed',
                  outputLength: compressedText.length,
                  usage: extractUsageMetrics(response),
                  durationMs: completedAt - startedAt,
                  finishedAt: completedAt
                } as ChunkSummary)
              : cs
          )
          const completedCount = updatedSummaries.filter((cs) => cs.status === 'completed').length
          memoryService.updateState({
            progress: {
              current: completedCount,
              total: totalChunks,
              percentage: calculatePercentage(completedCount, totalChunks),
              stage: 'compressing'
            },
            chunkSummaries: updatedSummaries
          })

          success = true
          break // Exit retry loop on success
        } catch (error) {
          if ((error as Error).name === 'AbortError') {
            throw error // Propagate cancellation immediately
          }
          retryCount++
          if (retryCount > maxRetries) {
            logger.warn(
              `[NovelCompressionService] Model ${modelExecutor.model.id} failed on chunk ${
                chunkIndex + 1
              } after ${maxRetries} retries.`,
              { error }
            )
            // This model failed, remove it from the available pool
            const modelIndex = availableModelExecutors.findIndex(
              (m) => m.model.id === modelExecutor.model.id
            )
            if (modelIndex > -1) {
              availableModelExecutors.splice(modelIndex, 1)
              failedModelIds.add(modelExecutor.model.id)
              logger.error(`模型 ${modelExecutor.model.name} 已被移出可用池。`)
            }
            break // Exit retry loop, to try another model for this chunk
          }
          await new Promise((resolve) => setTimeout(resolve, baseRetryDelay * retryCount))
        }
      }
    }

    if (!success) {
      // If loop finished without success, all models failed for this chunk.
      // Put it back in the queue to be potentially picked up if a model recovers (not implemented)
      // or to mark it as finally failed at the end.
      logger.error(`块 ${chunkIndex + 1} 使用所有可用模型尝试后均失败。`)
      pendingChunkIndexes.unshift(chunkIndex) // Re-queue it
    }
  }
}

ipcMain.on(IpcChannel.NovelCharacter_Cancel, () => {
  logger.info('Cancellation request received, aborting current character analysis task.')
  abortController.abort()
})

// 最大自动重试次数
const MAX_AUTO_RESUME_ATTEMPTS = 10

// 内部执行函数（支持自动重试）
async function executeCharacterAnalysis(
  providerConfigs: { modelId: string; providerId: ProviderId; options: any }[],
  customPrompt?: string,
  startOptions?: StartOptions
): Promise<void> {
  currentStartOptions = startOptions ?? {}

  const state = novelCharacterMemoryService.getState()
  if (!state.selectedFile && !state.inputText) {
    logger.warn('Compression start requested but no file or input text is available.')
    return
  }
  if (!providerConfigs || providerConfigs.length === 0) {
    logger.error('Compression start requested but no provider configs were provided.')
    return
  }

  try {
      const startTime = Date.now()
      novelCharacterMemoryService.updateState({ isProcessing: true, result: null, debugInfo: null })

      // 性能优化：避免重复读取文件，缓存读取结果
      let content: string
      if (state.inputText) {
        content = state.inputText
      } else {
        const fileReadResult = await readTextFileWithAutoEncoding(state.selectedFile!.path)
        content = fileReadResult.content
        logger.info(`File read with detected encoding: ${fileReadResult.encoding}`)
      }

      const options: NovelCompressionOptions = {
        ratio: state.ratioPercent / 100,
        chunkSize: state.chunkSize,
        overlap: state.overlap,
        temperature: state.temperature,
        maxConcurrency: state.maxConcurrency,
        customPrompt
      }

      let result: NovelCompressionResult
      if (state.enableMultiModel && state.selectedModels.length > 0) {
        result = await compressNovelWithMultipleModels(
          state.selectedModels,
          providerConfigs,
          content,
          options,
          state.outputPath,
          state.targetCharacters
        )
      } else if (state.selectedModel) {
        const config = providerConfigs.find((c) => c.modelId === state.selectedModel!.id)
        if (!config) {
          throw new Error(`无法找到模型 ${state.selectedModel.name} 对应的提供商配置。`)
        }
        result = await compressNovelWithModel(
          state.selectedModel,
          config,
          content,
          options,
          state.outputPath
        )
      } else {
        throw new Error('未选择任何模型用于阅读。')
      }

      const endTime = Date.now()
      const totalDuration = endTime - startTime
      const finalState = novelCharacterMemoryService.getState()

      novelCharacterMemoryService.updateState({
        result,
        debugInfo: {
          totalDuration,
          model: state.selectedModel?.name,
          models: state.selectedModels.map((m) => m.name),
          provider: providerConfigs[0]?.providerId,
          chunkSize: options.chunkSize,
          overlap: options.overlap,
          ratio: options.ratio,
          temperature: options.temperature,
          totalChunks: finalState.chunkSummaries.length,
          completedChunks: finalState.chunkSummaries.filter((c) => c.status === 'completed').length
        }
      })
  } catch (error) {
    if ((error as Error).name === 'AbortError' || (error as Error).message.includes('用户取消')) {
      logger.info('Compression task aborted by user.')
      const currentState = novelCharacterMemoryService.getState()
      novelCharacterMemoryService.updateState({
        isProcessing: false,
        progress: {
          current: currentState.progress?.current ?? 0,
          total: currentState.progress?.total ?? 0,
          percentage: currentState.progress?.percentage ?? 0,
          stage: 'cancelled'
        }
      })
    } else {
      logger.error('Compression task failed', { error })
      const logEntry = createLogEntry('error', '阅读任务失败', {
        message: (error as Error).message,
        stack: (error as Error).stack
      })
      const currentState = novelCharacterMemoryService.getState()
      novelCharacterMemoryService.updateState({
        progress: {
          current: currentState.progress?.current ?? 0,
          total: currentState.progress?.total ?? 0,
          percentage: currentState.progress?.percentage ?? 0,
          stage: 'failed'
        },
        logs: [...novelCharacterMemoryService.getState().logs, logEntry]
      })

      // 检查是否需要失败自动重试
      const stateAfterFailure = novelCharacterMemoryService.getState()
      if (stateAfterFailure.enableAutoResume && stateAfterFailure.autoResumeAttempts < MAX_AUTO_RESUME_ATTEMPTS) {
        const nextAttempt = stateAfterFailure.autoResumeAttempts + 1
        logger.info(`失败自动重试已启用，将通知前端进行第${nextAttempt}次重试...`)

        novelCharacterMemoryService.updateState({
          autoResumeAttempts: nextAttempt,
          logs: [
            ...novelCharacterMemoryService.getState().logs,
            createLogEntry('info', `失败自动重试：将在3秒后进行第${nextAttempt}次重试...`, {
              attempt: nextAttempt,
              maxAttempts: MAX_AUTO_RESUME_ATTEMPTS
            })
          ]
        })

        // 通知前端触发失败自动重试
        const allWindows = BrowserWindow.getAllWindows()
        allWindows.forEach((window) => {
          window.webContents.send(IpcChannel.NovelCharacter_AutoResumeTriggered, {
            attempt: nextAttempt,
            maxAttempts: MAX_AUTO_RESUME_ATTEMPTS
          })
        })
      } else if (stateAfterFailure.enableAutoResume) {
        logger.warn(`已达到最大失败自动重试次数限制（${MAX_AUTO_RESUME_ATTEMPTS}次）`)
        novelCharacterMemoryService.updateState({
          logs: [
            ...novelCharacterMemoryService.getState().logs,
            createLogEntry('warning', `已达到最大失败自动重试次数限制（${MAX_AUTO_RESUME_ATTEMPTS}次），自动重试停止`, {
              attempts: stateAfterFailure.autoResumeAttempts
            })
          ]
        })
      }
    }
  } finally {
    currentStartOptions = {}
    novelCharacterMemoryService.updateState({ isProcessing: false })
  }
}

ipcMain.handle(
  IpcChannel.NovelCharacter_Start,
  async (
    _,
    providerConfigs: { modelId: string; providerId: ProviderId; options: any }[],
    customPrompt?: string,
    startOptions?: StartOptions
  ): Promise<void> => {
    // 如果之前的任务已被取消，则创建一个新的 AbortController
    if (abortController.signal.aborted) {
      abortController = new AbortController()
    }

    // 重置失败自动重试计数器
    const currentState = novelCharacterMemoryService.getState()
    if (currentState.progress?.stage !== 'failed') {
      novelCharacterMemoryService.updateState({ autoResumeAttempts: 0 })
    }

    // 性能优化：使用即时返回+异步处理模式，避免阻塞渲染进程
    // 立即设置处理状态，让前端知道任务已开始
    novelCharacterMemoryService.updateState({ isProcessing: true })

    // 异步执行分析任务，不等待完成
    executeCharacterAnalysis(providerConfigs, customPrompt, startOptions).catch((error) => {
      logger.error('Character analysis task failed:', error)
    })

    // 立即返回，渲染进程不会阻塞
    return
  }
)

const NovelCharacterSecondaryGenerateSchema = z.object({
  providerConfigs: z.array(z.object({
    modelId: z.string().min(1),
    providerId: z.string().min(1),
    options: z.any()
  })).min(1),
  outputDir: z.string().min(1),
  plotFilePath: z.string().min(1),
  characterName: z.string().min(1),
  kind: z.enum(['bio', 'monologue'])
})

type SecondaryPromptTemplates = {
  bio: string
  monologue: string
}

const SECONDARY_PROMPT_TEMPLATES: SecondaryPromptTemplates = {
  bio: `根据以上文本，写一篇主题为“XXX人物志”的文案。请使用第三人称视角，以“XXX”的主观时间线为主线，描述 XXX 从出场到结局的完整经历，并自然体现其关键心态变化。可以在不违背原文设定与整体风格前提下，补充合理的成长经历与转折情节。文风要求幽默但不过度轻佻，逻辑清晰、通俗易懂，不要使用小标题和分节，适合短视频口播场景，目标长度约 1500 字。`,
  monologue: `根据以上文本，请以“XXX”第一人称写一篇心理独白。要求围绕其关键经历与情绪变化展开，体现人物在重要节点的内心冲突、价值判断与情感转折。可在不违背原文设定与整体风格前提下进行合理补充，文风口语化、真诚、有画面感，适合短视频口播场景，目标长度约 1500 字，不要使用小标题和分节。`
}

function sanitizeSecondaryFileStem(raw: string): string {
  const trimmed = raw.trim()
  const safe = trimmed.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
  return safe.length > 0 ? safe : '未命名人物'
}

ipcMain.handle(
  IpcChannel.NovelCharacter_GenerateSecondary,
  async (_, params: unknown): Promise<{ success: true; outputPath: string }> => {
    const { providerConfigs, outputDir, plotFilePath, characterName, kind } =
      NovelCharacterSecondaryGenerateSchema.parse(params)

    const providerConfig = providerConfigs[0]
    if (!providerConfig) {
      throw new Error('缺少模型配置 providerConfigs')
    }

    const plotTextRaw = await readTextFileWithAutoEncoding(plotFilePath)
    const plotText = (plotTextRaw ?? '').toString().trim()
    if (!plotText) {
      throw new Error('人物剧情为空，无法生成二次总结')
    }

    const basePrompt = kind === 'bio' ? SECONDARY_PROMPT_TEMPLATES.bio : SECONDARY_PROMPT_TEMPLATES.monologue
    const prompt = basePrompt.replace(/XXX/g, characterName)

    // 保护模型上下文：对超长人物剧情做上限截断（只影响生成，不影响源文件）
    const MAX_PLOT_CHARS = 60000
    const clippedPlot = plotText.length > MAX_PLOT_CHARS ? plotText.slice(0, MAX_PLOT_CHARS) : plotText
    if (plotText.length > MAX_PLOT_CHARS) {
      logger.info('人物剧情过长，已截断后再生成二次总结', { plotChars: plotText.length, clippedChars: clippedPlot.length })
    }

    clearAllProviders()
    await createAndRegisterProvider(providerConfig.providerId as ProviderId, providerConfig.options)
    const executor = createExecutor(providerConfig.providerId as ProviderId, { ...providerConfig.options, mode: 'chat' })

    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: `${clippedPlot}\n\n${prompt}`
      }
    ]

    const response = (await executor.generateText({
      model: providerConfig.modelId,
      messages,
      temperature: 0.8
    })) as GenerateTextResponse

    const text = response?.text?.trim() ?? ''
    if (!text) {
      throw new Error('模型返回空文本')
    }

    const safeStem = sanitizeSecondaryFileStem(characterName)
    const kindDirName = kind === 'bio' ? '人物志' : '心理独白'
    const outputPath = path.join(outputDir, '二次总结', kindDirName, `${safeStem}.txt`)
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, text, 'utf-8')

    return { success: true, outputPath }
  }
)

// 导出所有人物的剧情到TXT
ipcMain.handle(
  IpcChannel.NovelCharacter_ExportAllCharacters,
  async (_, { matrixData, outputPath }: { matrixData: CharacterPlotMatrix; outputPath?: string }) => {
    try {
      logger.info('开始导出所有人物剧情', {
        characterCount: matrixData.characters.length,
        outputPath
      })

      if (!outputPath) {
        throw new Error('缺少输出路径参数')
      }

      // 检查路径是文件还是文件夹
      let characterTextsDir: string
      const stat = await fs.stat(outputPath).catch(() => null)

      if (stat && stat.isDirectory()) {
        // 如果是文件夹，直接在该文件夹下创建"人物TXT合集"
        characterTextsDir = path.join(outputPath, '人物TXT合集')
      } else {
        // 如果是文件路径：导出到“最新任务目录”的人物TXT合集（避免覆盖旧结果）
        const currentState = novelCharacterMemoryService.getState()
        const targetCharactersForFolder = currentState.targetCharacterConfig?.enabled
          ? currentState.targetCharacterConfig.characters
          : undefined
        const baseName = getTaskBaseNameFromOutputPath(outputPath, currentState.selectedFile)
        const { characterTextsDir: resolvedCharacterTextsDir } = await createOutputDirectory(
          outputPath,
          baseName,
          true,
          targetCharactersForFolder
        )
        characterTextsDir = resolvedCharacterTextsDir
      }

      // 确保目录存在
      await fs.mkdir(characterTextsDir, { recursive: true })

      // 为每个人物生成TXT文件
      for (let charIndex = 0; charIndex < matrixData.characters.length; charIndex++) {
        const character = matrixData.characters[charIndex]
        const characterPlots = matrixData.matrix[charIndex]

        // 收集该人物的所有剧情
        const plotTexts: string[] = []
        for (let chunkIndex = 0; chunkIndex < characterPlots.length; chunkIndex++) {
          const plot = characterPlots[chunkIndex]
          if (plot && plot.trim().length > 0) {
            const chunkName = matrixData.chunks[chunkIndex]?.chunkName || `第${chunkIndex + 1}节`
            plotTexts.push(`【${chunkName}】\n${plot}`)
          }
        }

        // 如果该人物没有任何剧情，跳过
        if (plotTexts.length === 0) {
          logger.debug(`跳过无剧情的人物: ${character.displayName}`)
          continue
        }

        // 生成文件内容
        const fileContent = `${character.displayName} 剧情合集\n${'='.repeat(80)}\n\n` +
          plotTexts.join('\n\n' + '-'.repeat(80) + '\n\n')

        // 生成文件名（处理特殊字符）
        const safeFileName = character.displayName.replace(/[<>:"/\\|?*]/g, '_')
        const filePath = path.join(characterTextsDir, `${safeFileName}.txt`)

        // 写入文件
        await fs.writeFile(filePath, fileContent, 'utf-8')
        logger.debug(`已导出人物: ${character.displayName} -> ${filePath}`)
      }

      logger.info('所有人物剧情导出完成', {
        totalCharacters: matrixData.characters.length,
        outputDir: characterTextsDir
      })

      return { success: true, outputDir: characterTextsDir }
    } catch (error) {
      logger.error('导出所有人物剧情失败', error as Error)
      throw error
    }
  }
)

// 导出单个人物的剧情到TXT
ipcMain.handle(
  IpcChannel.NovelCharacter_ExportSingleCharacter,
  async (_, { matrixData, characterIndex, outputPath }: {
    matrixData: CharacterPlotMatrix
    characterIndex: number
    outputPath?: string
  }) => {
    try {
      logger.info('开始导出单个人物剧情', {
        characterIndex,
        outputPath
      })

      if (!outputPath) {
        throw new Error('缺少输出路径参数')
      }

      if (characterIndex < 0 || characterIndex >= matrixData.characters.length) {
        throw new Error(`无效的人物索引: ${characterIndex}`)
      }

      // 检查路径是文件还是文件夹
      let characterTextsDir: string
      const stat = await fs.stat(outputPath).catch(() => null)

      if (stat && stat.isDirectory()) {
        // 如果是文件夹，直接在该文件夹下创建"人物TXT合集"
        characterTextsDir = path.join(outputPath, '人物TXT合集')
      } else {
        // 如果是文件路径：导出到“最新任务目录”的人物TXT合集（避免覆盖旧结果）
        const currentState = novelCharacterMemoryService.getState()
        const targetCharactersForFolder = currentState.targetCharacterConfig?.enabled
          ? currentState.targetCharacterConfig.characters
          : undefined
        const baseName = getTaskBaseNameFromOutputPath(outputPath, currentState.selectedFile)
        const { characterTextsDir: resolvedCharacterTextsDir } = await createOutputDirectory(
          outputPath,
          baseName,
          true,
          targetCharactersForFolder
        )
        characterTextsDir = resolvedCharacterTextsDir
      }

      // 确保目录存在
      await fs.mkdir(characterTextsDir, { recursive: true })

      const character = matrixData.characters[characterIndex]
      const characterPlots = matrixData.matrix[characterIndex]

      // 收集该人物的所有剧情
      const plotTexts: string[] = []
      for (let chunkIndex = 0; chunkIndex < characterPlots.length; chunkIndex++) {
        const plot = characterPlots[chunkIndex]
        if (plot && plot.trim().length > 0) {
          const chunkName = matrixData.chunks[chunkIndex]?.chunkName || `第${chunkIndex + 1}节`
          plotTexts.push(`【${chunkName}】\n${plot}`)
        }
      }

      if (plotTexts.length === 0) {
        throw new Error(`${character.displayName} 没有任何剧情内容`)
      }

      // 生成文件内容
      const fileContent = `${character.displayName} 剧情合集\n${'='.repeat(80)}\n\n` +
        plotTexts.join('\n\n' + '-'.repeat(80) + '\n\n')

      // 生成文件名（处理特殊字符）
      const safeFileName = character.displayName.replace(/[<>:"/\\|?*]/g, '_')
      const filePath = path.join(characterTextsDir, `${safeFileName}.txt`)

      // 写入文件
      await fs.writeFile(filePath, fileContent, 'utf-8')
      logger.info(`已导出人物: ${character.displayName} -> ${filePath}`)

      return { success: true, filePath }
    } catch (error) {
      logger.error('导出单个人物剧情失败', error as Error)
      throw error
    }
  }
)

// 解析章节 - 任务 9.2
ipcMain.handle(
  IpcChannel.NovelCharacter_ParseChapters,
  async (_, { filePath }: { filePath: string }) => {
    try {
      logger.info('开始解析章节', { filePath })

      // 读取文件内容
      const { content } = await readTextFileWithAutoEncoding(filePath)
      
      if (!content || content.trim().length === 0) {
        return {
          success: false,
          totalChapters: 0,
          chapters: [],
          usedRule: '',
          error: '文件内容为空'
        } as ChapterParseResult
      }

      // 解析章节
      const result = parseChapters(content)
      
      logger.info('章节解析完成', {
        success: result.success,
        totalChapters: result.totalChapters,
        usedRule: result.usedRule
      })

      return result
    } catch (error) {
      logger.error('解析章节失败', error as Error)
      return {
        success: false,
        totalChapters: 0,
        chapters: [],
        usedRule: '',
        error: (error as Error).message
      } as ChapterParseResult
    }
  }
)

function createCancellablePromise<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      return reject(new NovelCompressionError('用户取消了阅读任务'))
    }

    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(new NovelCompressionError('用户取消了阅读任务'))
    }

    signal.addEventListener('abort', onAbort)

    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      }
    )
  })
}
