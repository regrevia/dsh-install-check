/**
 * What happens, then what to do about it. Two lines at most, no mechanism,
 * no scores, no categories.
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

/** Keys a person would recognise; a loader row is described, not named. */
function sharedKeys(result, locale) {
  const keys = unique(result.breaks.filter((finding) => finding.kind !== 'row').map((finding) => finding.key))
  if (keys.length) return list(keys, locale)
  return locale === 'zh' ? '同一条加载行' : 'the same loader row'
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
    zh.push(`冲突：和 ${who} 撞了 ${sharedKeys(result, 'zh')}，只能留一个。`)
    zh.push(`想用新装这个，先停用 ${who} 再重启。`)

    const whoEn = list(owners(result), 'en')
    en.push(`Conflict: shares ${sharedKeys(result, 'en')} with ${whoEn}; only one can be live.`)
    en.push(`To use the new one, disable ${whoEn} and restart.`)
  }

  if (result.missing.length) {
    const names = list(result.missing.map((finding) => finding.key), 'zh')
    zh.push(`缺 ${names}，装上它之前这个插件起不来。`)
    en.push(`Missing ${names}; this plugin cannot start until it is installed.`)
  }

  return { zh: zh.join('\n'), en: en.join('\n') }
}

export function summary(candidate, result) {
  if (result.ok) return `${candidate.name}：没撞上已装的插件。`
  if (result.breaks.length) return `${candidate.name}：和已装插件冲突，只能留一个。`
  return `${candidate.name}：还缺依赖。`
}
