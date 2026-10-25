/**
 * Two short sentences: what collides, and what to do about it. No scores,
 * no categories, no "AI-powered".
 */

function owners(list) {
  return list.join('、')
}

function zhLine(finding) {
  const who = owners(finding.owners ?? [])
  switch (finding.kind) {
    case 'row':
      return `加载行 ${finding.key} 和 ${who} 同名，后装的会覆盖前者`
    case 'service':
      return `和 ${who} 都提供 ${finding.key} 服务，后装的会顶掉它`
    case 'tool':
      return `和 ${who} 都注册工具 ${finding.key}，模型只会看到一个`
    case 'route':
      return `和 ${who} 都占用路由 ${finding.key}`
    case 'slot':
      return `和 ${who} 都往 ${finding.key} 里加内容`
    case 'peer':
      return `还需要 ${finding.key}，现在没装`
    default:
      return ''
  }
}

function enLine(finding) {
  const who = owners(finding.owners ?? [])
  switch (finding.kind) {
    case 'row':
      return `loader row ${finding.key} is also used by ${who}; the later one wins`
    case 'service':
      return `provides ${finding.key}, which ${who} already provides`
    case 'tool':
      return `registers tool ${finding.key}, which ${who} already registers`
    case 'route':
      return `claims route ${finding.key}, which ${who} already claims`
    case 'slot':
      return `fills ${finding.key}, which ${who} already fills`
    case 'peer':
      return `needs ${finding.key}, which is not installed`
    default:
      return ''
  }
}

function zhVerdict(result) {
  if (result.hard.length) {
    const who = owners([...new Set(result.hard.flatMap((finding) => finding.owners ?? []))])
    return `装好了，重启才生效。想留原样就停用 ${who}；留着它就用它顶掉 ${who}。`
  }
  return '装好了，可以用；功能有重叠，坏不了。'
}

function enVerdict(result) {
  if (result.hard.length) {
    const who = owners([...new Set(result.hard.flatMap((finding) => finding.owners ?? []))])
    return `Installed; it takes effect on restart. Disable ${who} to keep the old one.`
  }
  return 'Installed and usable; features overlap but nothing breaks.'
}

/**
 * @param {object} candidate scanned candidate
 * @param {{findings: object[], hard: object[], warn: object[]}} result
 */
export function render(candidate, result) {
  const findings = result.findings.slice(0, 3)
  const zhLines = findings.map(zhLine).filter(Boolean)
  const enLines = findings.map(enLine).filter(Boolean)
  const extra = result.findings.length > findings.length ? `（还有 ${result.findings.length - findings.length} 处）` : ''

  const zh = [...zhLines, `${zhVerdict(result)}${extra}`].join('\n')
  const en = [...enLines, `${enVerdict(result)}${extra ? ` (${result.findings.length - findings.length} more)` : ''}`].join('\n')
  return { zh, en }
}

export function summary(candidate, result) {
  if (result.ok) return `${candidate.name}：没撞上已装的插件。`
  return `${candidate.name}：${result.findings.length} 处需要你定。`
}
