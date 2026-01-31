const getDisplayNames = (type: 'language' | 'region') => {
  try {
    return new Intl.DisplayNames(['zh-CN'], { type })
  } catch {
    return null
  }
}

const LANGUAGE_SUBTAG_ZH: Record<string, string> = {
  zh: '中文',
  en: '英语',
  ja: '日语',
  ko: '韩语',
  de: '德语',
  fr: '法语',
  es: '西班牙语',
  it: '意大利语',
  ru: '俄语',
  pt: '葡萄牙语',
  ar: '阿拉伯语'
}

// 常见国家/地区在中文语境下更友好的称呼（尤其中文多区域场景）。
const REGION_SUBTAG_ZH: Record<string, string> = {
  CN: '中国大陆',
  HK: '中国香港',
  MO: '中国澳门',
  TW: '中国台湾',
  SG: '新加坡',
  MY: '马来西亚'
}

// locale 里的额外分段（方言/省份等），允许多段映射。
const EXTRA_SUBTAG_ZH: Record<string, string> = {
  liaoning: '辽宁',
  henan: '河南',
  shandong: '山东',
  shaanxi: '陕西',
  guangxi: '广西',
  sichuan: '四川'
}

export const getLocaleLabelZh = (locale: string) => {
  const trimmed = (locale || '').trim()
  if (!trimmed) return locale

  const parts = trimmed.split('-').filter(Boolean)
  const lang = parts[0]
  // BCP47: language-script-region-variant-...
  // 语言永远是第 1 段；script（4 字母）如果存在，则为第 2 段；
  // region（2 字母或 3 数字）只能从其后开始匹配，避免把 "zh" 误判为 region。
  const startIndex = (() => {
    const second = parts[1]
    if (second && /^[A-Za-z]{4}$/.test(second)) return 2
    return 1
  })()
  const regionIndex = parts.findIndex((p, idx) => {
    if (idx < startIndex) return false
    return /^[A-Za-z]{2}$/.test(p) || /^[0-9]{3}$/.test(p)
  })
  const region = regionIndex >= 0 ? parts[regionIndex] : null
  const extraParts = regionIndex >= 0 ? parts.slice(regionIndex + 1) : parts.slice(startIndex)

  const langDisplay =
    LANGUAGE_SUBTAG_ZH[lang] ||
    getDisplayNames('language')?.of(lang) ||
    lang

  // 没有 region 的时候，只显示语言（例如 "en"）
  if (!region) return langDisplay

  const regionKey = /^[0-9]{3}$/.test(region) ? region : region.toUpperCase()
  const regionDisplay =
    REGION_SUBTAG_ZH[regionKey] ||
    getDisplayNames('region')?.of(regionKey) ||
    regionKey

  const extras = extraParts
    .map((p) => {
      const key = p.toLowerCase()
      return EXTRA_SUBTAG_ZH[key] || p
    })
    .filter(Boolean)

  // 对中文的默认区域（CN）不显示“中国大陆”，避免冗余：
  // - zh-CN           -> 中文
  // - zh-CN-liaoning  -> 中文（辽宁）
  if (lang.toLowerCase() === 'zh' && regionKey === 'CN') {
    if (extras.length === 0) return langDisplay
    return `${langDisplay}（${extras.join(' / ')}）`
  }

  // 支持多段映射：例如 zh-HK -> 中文（中国香港）；zh-CN-liaoning -> 中文（辽宁）(由上面的分支处理)
  const segments = [regionDisplay, ...extras]
  return `${langDisplay}（${segments.join(' / ')}）`
}

export const STYLE_LABEL_ZH: Record<string, string> = {
  // Core
  assistant: '通用助手风格 (Assistant)',
  chat: '聊天式风格 (Chat)',
  customerservice: '客服风格 (Customer Service)',
  newscast: '新闻播报风格 (Newscast)',

  // Emotion
  angry: '愤怒风格 (Angry)',
  cheerful: '开心风格 (Cheerful)',
  sad: '伤心风格 (Sad)',
  excited: '兴奋风格 (Excited)',
  friendly: '友好风格 (Friendly)',
  hopeful: '充满希望风格 (Hopeful)',
  terrified: '惊恐风格 (Terrified)',
  shouting: '大喊风格 (Shouting)',
  unfriendly: '不友好风格 (Unfriendly)',
  whispering: '耳语风格 (Whispering)',

  // Scenario / Narrative
  affectionate: '亲昵风格 (Affectionate)',
  empathetic: '共情风格 (Empathetic)',
  'poetry-reading': '诗歌朗读风格 (Poetry Reading)',
  story: '故事讲述风格 (Story)',
  advertisement_upbeat: '广告活力风格 (Advertisement Upbeat)',

  // Language-Specific
  calm: '平静风格 (Calm)',
  disgruntled: '抱怨风格 (Disgruntled)',
  fearful: '恐惧风格 (Fearful)',
  gentle: '温柔风格 (Gentle)',
  lyrical: '抒情风格 (Lyrical)',
  serious: '严肃风格 (Serious)',
  depressed: '抑郁风格 (Depressed)',

  // Utility
  default: '默认风格 (Default)',
  sorry: '道歉风格 (Sorry)',

  // 常见兜底
  general: '通用 (general)'
}

export const getStyleLabelZh = (style: string) => {
  const key = (style || '').trim()
  if (!key) return style
  return STYLE_LABEL_ZH[key] ?? key
}
