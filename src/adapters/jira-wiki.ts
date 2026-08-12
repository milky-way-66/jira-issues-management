/**
 * Markdown ↔ Jira wiki markup.
 *
 * Lives in the adapter on purpose: the core only ever handles canonical
 * Markdown, which is what makes a Jira Cloud adapter (ADF instead of wiki
 * markup) an adapter-only change.
 *
 * The property that matters is not fidelity but *stability*: `wiki → md → wiki`
 * must be a fixed point. If it is not, every sync sees a body difference that
 * is not there, rewrites the ticket, and buries real changes in noise.
 * Constructs are therefore converted only when the mapping is reversible;
 * anything else is left as literal text.
 */

const H = /^h([1-6])\.\s*(.*)$/
const MD_H = /^(#{1,6})\s+(.*)$/

export function wikiToMarkdown(wiki: string): string {
  const lines = wiki.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let inCode = false

  /**
   * Wiki ordered items carry no number — every one of them is `#`, and the
   * position is implicit. Markdown's are explicit, so the number has to be
   * reconstructed here, per indent level, resetting when the list ends.
   *
   * Emitting `1.` for every item instead would be a correctness bug rather than
   * a cosmetic one: the body would differ from the file on the very next read,
   * so every sync would see a change that nobody made, forever.
   */
  const ordinals = new Map<string, number>()

  for (const line of lines) {
    const codeOpen = line.match(/^\{code(?::([^}]*))?\}\s*$/)
    if (codeOpen) {
      ordinals.clear() // a code block ends any list before it
      if (inCode) {
        out.push('```')
        inCode = false
      } else {
        out.push('```' + languageOf(codeOpen[1]))
        inCode = true
      }
      continue
    }
    if (line.trim() === '{noformat}') {
      out.push('```')
      inCode = !inCode
      continue
    }
    if (inCode) {
      out.push(line)
      continue
    }

    let s = line

    const heading = s.match(H)
    if (heading) {
      ordinals.clear()
      s = `${'#'.repeat(Number(heading[1]))} ${heading[2]}`
    } else {
      const ordered = s.match(/^(\s*)#\s+(.*)$/)
      if (ordered) {
        const indent = ordered[1] ?? ''
        const n = (ordinals.get(indent) ?? 0) + 1
        ordinals.set(indent, n)
        // A deeper level restarting means the shallower one continues, but a
        // shallower item ends every list nested under it.
        for (const key of [...ordinals.keys()]) {
          if (key.length > indent.length) ordinals.delete(key)
        }
        s = `${indent}${n}. ${ordered[2]}`
      } else {
        if (s.trim() !== '') ordinals.clear() // a paragraph ends the list
        s = s.replace(/^(\s*)\*\s+/, '$1- ') // unordered list
      }
    }

    s = inlineWikiToMd(s)
    out.push(s)
  }

  return out.join('\n').replace(/\s+$/, '')
}

export function markdownToWiki(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let inCode = false

  for (const line of lines) {
    const fence = line.match(/^```\s*(\S*)\s*$/)
    if (fence) {
      if (inCode) {
        out.push('{code}')
        inCode = false
      } else {
        out.push(fence[1] ? `{code:${fence[1]}}` : '{code}')
        inCode = true
      }
      continue
    }
    if (inCode) {
      out.push(line)
      continue
    }

    let s = line

    const heading = s.match(MD_H)
    if (heading) {
      s = `h${heading[1]?.length}. ${heading[2]}`
    } else {
      s = s.replace(/^(\s*)\d+\.\s+/, '$1# ')
      s = s.replace(/^(\s*)[-*]\s+/, '$1* ')
    }

    s = inlineMdToWiki(s)
    out.push(s)
  }

  return out.join('\n').replace(/\s+$/, '')
}

function languageOf(lang: string | undefined): string {
  return lang && lang !== 'none' ? lang : ''
}

// ── Inline ──────────────────────────────────────────────────────────────────
// Inline conversion runs outside `{{monospace}}` / `` `code` `` spans, so markup
// characters inside code are never reinterpreted.

/**
 * Emphasis runs are rewritten in a *single* pass, never as chained replaces.
 * Chaining is what breaks the fixed point: `**bold**` becomes `*bold*`, and the
 * next rule in the chain immediately reads its own output as italic and emits
 * `_bold_`.
 *
 * The delimited text may not begin or end with whitespace, which keeps prose
 * like `2 * 3 * 4` from being mistaken for markup.
 */
const RUN = '(?:[^*_\\s\\n][^*_\\n]*[^*_\\s\\n]|[^*_\\s\\n])'
const BEFORE = '(^|[\\s(])'
const AFTER = '(?=[\\s).,;:!?]|$)'

const WIKI_EMPH = new RegExp(`${BEFORE}([*_])(${RUN})\\2${AFTER}`, 'g')
const MD_EMPH = new RegExp(`${BEFORE}(\\*\\*|\\*)(${RUN})\\2${AFTER}`, 'g')

function inlineWikiToMd(s: string): string {
  return mapOutsideCode(s, /\{\{([^}]*)\}\}/g, (t) => '`' + t + '`', (text) =>
    text
      .replace(/\[([^\]|]+)\|([^\]]+)\]/g, '[$1]($2)') // [label|url]
      .replace(WIKI_EMPH, (_m, pre: string, delim: string, inner: string) =>
        delim === '*' ? `${pre}**${inner}**` : `${pre}*${inner}*`,
      ),
  )
}

function inlineMdToWiki(s: string): string {
  return mapOutsideCode(s, /`([^`]*)`/g, (t) => '{{' + t + '}}', (text) =>
    text
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '[$1|$2]')
      .replace(MD_EMPH, (_m, pre: string, delim: string, inner: string) =>
        delim === '**' ? `${pre}*${inner}*` : `${pre}_${inner}_`,
      ),
  )
}

/**
 * Splits a line into code spans and prose, converts the code delimiters, and
 * applies `transform` only to the prose between them.
 */
function mapOutsideCode(
  line: string,
  codePattern: RegExp,
  wrapCode: (inner: string) => string,
  transform: (text: string) => string,
): string {
  let out = ''
  let last = 0

  for (const m of line.matchAll(codePattern)) {
    const start = m.index ?? 0
    out += transform(line.slice(last, start))
    out += wrapCode(m[1] ?? '')
    last = start + m[0].length
  }

  return out + transform(line.slice(last))
}
