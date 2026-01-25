import { loggerService } from '@logger'
import type { ChapterInfo, ChapterParseResult } from '@shared/types'

const logger = loggerService.withContext('ChapterParser')

/**
 * 章节识别正则规则（参考 Legado 阅读器）
 */
export const CHAPTER_RULES = [
  {
    name: '第X章/节/卷',
    pattern: /^[ 　\t]{0,4}(?:序章|楔子|正文(?!完|结)|终章|后记|尾声|番外|第\s{0,4}[\d〇零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+?\s{0,4}(?:章|节(?!课)|卷|集(?![合和])|部(?![分赛游])|篇(?!张))).{0,30}$/m
  },
  {
    name: '数字分隔符',
    pattern: /^[ 　\t]{0,4}\d{1,5}[:：,.，、_—-]\s*.{1,30}$/m
  },
  {
    name: 'Chapter X',
    pattern: /^[ 　\t]{0,4}(?:Chapter|CHAPTER|Section|SECTION|Part|PART)\s{0,4}\d{1,4}.{0,30}$/im
  },
  {
    name: '特殊符号包裹',
    pattern: /^[ 　\t]{0,4}[【〔〖「『〈［[](?:第|Chapter|chapter)[\d零一二两三四五六七八九十百千万]+[章节卷集部篇].{0,20}[】〕〗」』〉］\]]?\s*$/m
  },
  {
    name: '纯数字章节',
    pattern: /^[ 　\t]{0,4}\d{3,4}[ 　\t]+.{1,30}$/m
  }
] as const

/**
 * 选择最佳匹配规则
 */
export function selectBestRule(text: string): { rule: RegExp; name: string } | null {
  const sampleLength = Math.min(text.length * 0.3, 100000)
  const sample = text.slice(0, sampleLength)

  let bestRule: { rule: RegExp; name: string } | null = null
  let maxMatches = 0

  for (const { name, pattern } of CHAPTER_RULES) {
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g')
    const matches = sample.match(globalPattern)
    const matchCount = matches?.length ?? 0

    if (matchCount > maxMatches) {
      maxMatches = matchCount
      bestRule = { rule: pattern, name }
    }
  }

  if (maxMatches < 3) {
    return null
  }

  return bestRule
}

/**
 * 解析章节
 */
export function parseChapters(text: string): ChapterParseResult {
  const bestRule = selectBestRule(text)

  if (!bestRule) {
    return {
      success: false,
      totalChapters: 0,
      chapters: [],
      usedRule: '',
      error: '未能识别到有效的章节结构，建议使用按字数分块模式'
    }
  }

  const { rule, name } = bestRule
  const chapters: ChapterInfo[] = []
  const globalPattern = new RegExp(rule.source, rule.flags.includes('g') ? rule.flags : rule.flags + 'g')

  let match: RegExpExecArray | null
  const titlePositions: { title: string; start: number }[] = []

  while ((match = globalPattern.exec(text)) !== null) {
    titlePositions.push({
      title: match[0].trim(),
      start: match.index
    })
  }

  for (let i = 0; i < titlePositions.length; i++) {
    const current = titlePositions[i]
    const next = titlePositions[i + 1]

    chapters.push({
      index: i,
      title: current.title,
      startOffset: current.start,
      endOffset: next ? next.start : text.length
    })
  }

  return {
    success: true,
    totalChapters: chapters.length,
    chapters,
    usedRule: name
  }
}

/**
 * 按章节分块
 */
export function splitTextByChapters<T extends { text: string; targetLength: number; index: number }>(
  text: string,
  chapters: ChapterInfo[],
  chaptersPerChunk: number,
  ratio: number,
  clamp: (value: number, min: number, max: number) => number
): (T & { chapterTitles?: string[] })[] {
  const normalizedChaptersPerChunk = Math.max(1, Math.floor(chaptersPerChunk))
  const normalizedRatio = clamp(ratio, 0.01, 0.9)
  const chunks: (T & { chapterTitles?: string[] })[] = []

  for (let i = 0; i < chapters.length; i += normalizedChaptersPerChunk) {
    const chunkChapters = chapters.slice(i, i + normalizedChaptersPerChunk)
    const startOffset = chunkChapters[0].startOffset
    const endOffset = chunkChapters[chunkChapters.length - 1].endOffset
    const chunkText = text.slice(startOffset, endOffset).trim()

    if (chunkText.length > 0) {
      const targetLength = Math.max(120, Math.round(chunkText.length * normalizedRatio))
      chunks.push({
        index: chunks.length,
        text: chunkText,
        targetLength,
        chapterTitles: chunkChapters.map((c) => c.title)
      } as T & { chapterTitles?: string[] })
    }
  }

  logger.info('按章节分块完成', {
    totalChunks: chunks.length,
    chaptersPerChunk: normalizedChaptersPerChunk,
    totalChapters: chapters.length
  })

  return chunks
}
