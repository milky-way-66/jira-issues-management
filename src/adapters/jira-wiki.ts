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

  for (const line of lines) {
    const codeOpen = line.match(/^\{code(?::([^}]*))?\}\s*$/)
    if (codeOpen) {
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
      s = `${'#'.repeat(Number(heading[1]))} ${heading[2]}`
    } else {
      s = s.replace(/^(\s*)#\s+/, '$11. ') // ordered list
      s = s.replace(/^(\s*)\*\s+/, '$1- ') // unordered list
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
