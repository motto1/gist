/**
 * 小说处理相关工具函数
 * 从 NovelCompressionService, NovelCharacterService, NovelOutlineService 中提取
 */

/**
 * 将数值限制在指定范围内
 */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    return min
  }
  return Math.min(Math.max(value, min), max)
}

/**
 * 基础文本分块结果
 */
export interface TextChunk {
  index: number
  text: string
  targetLength?: number
}

/**
 * 将文本分割成块（通用版本）
 * @param text 要分割的文本
 * @param chunkSize 每块的最大字符数
 * @param overlap 块之间的重叠字符数
 * @param ratio 可选的压缩比率（用于计算目标长度）
 * @returns 分块数组
 */
export function splitTextIntoChunks(
  text: string,
  chunkSize: number,
  overlap: number,
  ratio?: number
): TextChunk[] {
  const normalizedChunkSize = Math.max(500, Math.min(500000, Math.floor(chunkSize)))
  const normalizedOverlap = clamp(Math.floor(overlap), 0, normalizedChunkSize - 1)
  const normalizedRatio = ratio !== undefined ? clamp(ratio, 0.01, 0.9) : undefined

  const chunks: TextChunk[] = []
  let start = 0
  let index = 0

  while (start < text.length) {
    const end = Math.min(text.length, start + normalizedChunkSize)
    const chunkText = text.slice(start, end).trim()

    if (chunkText.length > 0) {
      const chunk: TextChunk = { index, text: chunkText }
      if (normalizedRatio !== undefined) {
        chunk.targetLength = Math.max(120, Math.round(chunkText.length * normalizedRatio))
      }
      chunks.push(chunk)
      index += 1
    }

    if (end >= text.length) break

    const nextStart = end - normalizedOverlap
    start = nextStart > start ? nextStart : end
  }

  return chunks
}

/**
 * 将文本分割成简单的字符串数组（用于 NovelOutlineService）
 */
export function splitTextIntoStringChunks(
  text: string,
  chunkSize: number,
  overlap: number
): string[] {
  return splitTextIntoChunks(text, chunkSize, overlap).map(chunk => chunk.text)
}

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
    name: '纯数字标题',
    pattern: /^[ 　\t]{0,4}\d{1,4}[ 　\t]{1,4}.{1,30}$/m
  }
] as const

/**
 * 章节信息
 */
export interface ChapterInfo {
  title: string
  startIndex: number
  endIndex: number
  content: string
}

/**
 * 章节解析结果
 */
export interface ChapterParseResult {
  chapters: ChapterInfo[]
  ruleName: string
  totalChapters: number
}

/**
 * 检测文本中使用的章节规则
 */
export function detectChapterRule(text: string): { name: string; pattern: RegExp } | null {
  for (const { name, pattern } of CHAPTER_RULES) {
    const matches = text.match(new RegExp(pattern, 'gm'))
    if (matches && matches.length >= 3) {
      return { name, pattern }
    }
  }
  return null
}

/**
 * 解析文本中的章节
 */
export function parseChapters(text: string): ChapterParseResult | null {
  const rule = detectChapterRule(text)
  if (!rule) return null

  const globalPattern = new RegExp(rule.pattern, 'gm')
  const matches: { title: string; index: number }[] = []
  let match: RegExpExecArray | null

  while ((match = globalPattern.exec(text)) !== null) {
    matches.push({
      title: match[0].trim(),
      index: match.index
    })
  }

  if (matches.length === 0) return null

  const chapters: ChapterInfo[] = matches.map((m, i) => {
    const startIndex = m.index
    const endIndex = i < matches.length - 1 ? matches[i + 1].index : text.length
    return {
      title: m.title,
      startIndex,
      endIndex,
      content: text.slice(startIndex, endIndex)
    }
  })

  return {
    chapters,
    ruleName: rule.name,
    totalChapters: chapters.length
  }
}

/**
 * 日志条目类型
 */
export interface LogEntry {
  timestamp: string
  level: 'info' | 'warning' | 'error'
  message: string
  context?: Record<string, unknown>
}

/**
 * 创建日志条目
 */
export function createLogEntry(
  level: 'info' | 'warning' | 'error',
  message: string,
  context?: Record<string, unknown>
): LogEntry {
  return {
    timestamp: new Date().toISOString(),
    level,
    message,
    context
  }
}
