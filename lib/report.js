/**
 * Verdict first, then the reason, then the one action. Two or three lines,
 * no mechanism talk ("the model only sees one"), no scores, no categories.
 */

const MAX_NAMES = 3

function list(items, locale) {
  const shown = items.slice(0, MAX_NAMES)
  const rest = items.length - shown.length
  const joiner = locale === 'zh' ? '、' : ', '
  const tail = rest > 0 ? (locale === 'zh' ? ` 等 ${items.length} 个` : ` and ${rest} more`) : ''
  return `${shown.join(joiner)}${tail}`
}

function unique(items) {
  return [...new Set(items)]
}

function keysOf(result, kind) {
  return unique(result.breaks.filter((finding) => finding.kind === kind).map((finding) => finding.key))
}

/** The reason, in plain nouns: same tool name, same service, same slot in the list. */
function because(result, locale) {
  const parts = []
  const tools = keysOf(result, 'tool')
  const services = keysOf(result, 'service')
  if (tools.length) {
    parts.push(locale === 'zh' ? `用同一个工具名 ${list(tools, locale)}` : `uses the same tool name ${list(tools, locale)}`)
  }
  if (services.length) {
    parts.push(locale === 'zh' ? `用同一个服务 ${list(services, locale)}` : `provides the same service ${list(services, locale)}`)
  }
  if (keysOf(result, 'row').length) {
    parts.push(locale === 'zh' ? '装在同一个位置' : 'installs in the same row')
  }
  return parts.join(locale === 'zh' ? '，' : ', ')
}

function owners(result) {
  return unique(result.breaks.flatMap((finding) => finding.owners ?? []))
}

/**
 * @param {object} candidate scanned candidate
 * @param {{findings: object[], breaks: object[], missing: object[]}} result
 */
export function render(candidate, result) {
  const zh = []
  const en = []

  if (result.breaks.length) {
    const who = list(owners(result), 'zh')
    zh.push(`冲突：和 ${who} ${because(result, 'zh')}，两个只能留一个。`)
    zh.push(`两个都想要，先停用 ${who} 再重启。`)

    const whoEn = list(owners(result), 'en')
    en.push(`Conflict: it ${because(result, 'en')} as ${whoEn}; only one can be live.`)
    en.push(`To keep both, disable ${whoEn} and restart.`)
  }

  if (result.missing.length) {
    const names = list(result.missing.map((finding) => finding.key), 'zh')
    zh.push(`缺 ${names}，装上它之前这个插件起不来。`)
    en.push(`Missing ${names}; the plugin cannot start until it is installed.`)
  }

  return { zh: zh.join('\n'), en: en.join('\n') }
}

export function summary(candidate, result) {
  if (result.ok) return `${candidate.name}：没撞上已装的插件。`
  if (result.breaks.length) return `${candidate.name}：和已装插件冲突，只能留一个。`
  return `${candidate.name}：还缺依赖。`
}
