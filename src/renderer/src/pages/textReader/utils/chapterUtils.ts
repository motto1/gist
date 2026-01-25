/**
 * 章节相关工具函数
 * 用于处理中文数字转换、章节编号提取等
 */

/**
 * 将中文数字或阿拉伯数字字符串转换为整数
 * @param raw 原始字符串，如 "一", "二十三", "123"
 * @returns 解析后的整数，失败返回 null
 */
export const chineseNumberToInt = (raw: string): number | null => {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10)

  const digitMap: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9
  }
  const unitMap: Record<string, number> = {
    十: 10,
    百: 100,
    千: 1000,
    万: 10000
  }

  let total = 0
  let section = 0
  let number = 0

  for (const ch of trimmed) {
    const digit = digitMap[ch]
    if (digit !== undefined) {
      number = digit
      continue
    }
    const unit = unitMap[ch]
    if (unit !== undefined) {
      if (unit === 10000) {
        section = (section + (number || 0)) * unit
        total += section
        section = 0
        number = 0
      } else {
        const n = number === 0 ? 1 : number
        section += n * unit
        number = 0
      }
    }
  }

  const result = total + section + number
  return Number.isFinite(result) && result > 0 ? result : null
}

/**
 * 从章节标题中提取章节编号
 * @param title 章节标题，如 "第一章 开始"
 * @returns 章节编号整数，失败返回 null
 */
export const extractChapterNoFromTitle = (title: string): number | null => {
  const m = title.match(/第\s*([0-9〇零一二两三四五六七八九十百千万]+)\s*(?:章|节|回|卷|部|篇)/)
  if (!m?.[1]) return null
  return chineseNumberToInt(m[1])
}

/**
 * 估算分块数量
 * @param totalChapters 总章节数
 * @param chaptersPerChunk 每块章节数
 * @returns 预估分块数
 */
export const estimateChunkCount = (totalChapters: number, chaptersPerChunk: number): number => {
  const total = Number.isFinite(totalChapters) ? Math.max(0, totalChapters) : 0
  const per = Number.isFinite(chaptersPerChunk) ? Math.max(1, chaptersPerChunk) : 1
  if (total === 0) return 0
  return Math.ceil(total / per)
}
