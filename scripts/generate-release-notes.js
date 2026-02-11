const { execSync } = require('child_process')

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const value = argv[i + 1]
    if (!value || value.startsWith('--')) {
      args[key] = true
      continue
    }
    args[key] = value
    i += 1
  }
  return args
}

function run(command) {
  return execSync(command, { encoding: 'utf8' }).trim()
}

function getCommits(from, to) {
  const range = from ? `${from}..${to}` : to
  const output = run(`git log --no-merges --format=%H%x09%s ${range}`)
  if (!output) return []

  return output
    .split('\n')
    .map((line) => {
      const [hash, ...rest] = line.split('\t')
      return {
        hash,
        subject: rest.join('\t').trim()
      }
    })
    .filter((item) => item.hash && item.subject)
}

function classifyCommit(subject) {
  const conventional = /^([a-z]+)(\([^)]+\))?(!)?:\s*(.+)$/i.exec(subject)

  if (conventional) {
    const type = conventional[1].toLowerCase()
    const bang = Boolean(conventional[3])

    if (bang) return 'breaking'
    if (type === 'feat') return 'feature'
    if (type === 'fix') return 'fix'
    if (['refactor', 'perf', 'chore', 'docs', 'test', 'build', 'ci', 'style', 'revert'].includes(type)) {
      return 'maintain'
    }
    return 'other'
  }

  if (/breaking change/i.test(subject)) return 'breaking'
  return 'other'
}

function shouldSkip(subject) {
  return /^ci\(release\): bump version to v\d+\.\d+\.\d+/i.test(subject)
}

function formatLine(repo, hash, subject) {
  const shortHash = hash.slice(0, 7)
  return `- ${subject} ([\`${shortHash}\`](https://github.com/${repo}/commit/${hash}))`
}

function renderSection(title, items) {
  if (items.length === 0) return ''
  return `\n### ${title}\n${items.join('\n')}\n`
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const from = typeof args.from === 'string' ? args.from : ''
  const to = typeof args.to === 'string' ? args.to : 'HEAD'
  const tag = typeof args.version === 'string' ? args.version : ''
  const repo = typeof args.repo === 'string' ? args.repo : ''

  if (!tag) {
    throw new Error('Missing required argument: --version (e.g. v1.1.2)')
  }
  if (!repo) {
    throw new Error('Missing required argument: --repo (e.g. owner/repo)')
  }

  const commits = getCommits(from, to).filter((commit) => !shouldSkip(commit.subject))

  const buckets = {
    breaking: [],
    feature: [],
    fix: [],
    maintain: [],
    other: []
  }

  for (const commit of commits) {
    const bucket = classifyCommit(commit.subject)
    buckets[bucket].push(formatLine(repo, commit.hash, commit.subject))
  }

  let body = `## ${tag} 更新内容\n`

  if (commits.length === 0) {
    body += '\n- 本次发布无代码差异（仅版本发布或元数据变更）。\n'
  } else {
    body += renderSection('⚠️ Breaking Changes', buckets.breaking)
    body += renderSection('🚀 新功能', buckets.feature)
    body += renderSection('🐛 修复', buckets.fix)
    body += renderSection('🔧 维护', buckets.maintain)
    body += renderSection('📦 其他变更', buckets.other)
  }

  if (from) {
    body += `\n**Full Changelog**: https://github.com/${repo}/compare/${from}...${tag}\n`
  } else {
    body += `\n**Commits**: https://github.com/${repo}/commits/${tag}\n`
  }

  process.stdout.write(body)
}

main()
