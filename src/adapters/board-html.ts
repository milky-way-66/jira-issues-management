/**
 * Renders a `Board` as one self-contained HTML file.
 *
 * Self-contained is a requirement, not a convenience: the file sits inside a
 * workspace that holds a customer's ticket titles. A stylesheet, font or script
 * fetched from someone else's host would announce every open of the board — and
 * the URL of a `file://` page leaks the local path in the referrer. So there is
 * nothing here to fetch: no `<script src>`, no `<link href>`, no image, no
 * network call of any kind. TC-I-BOARD-10 enforces exactly that.
 *
 * Presentation only. Which cards exist and what order the columns go in are
 * decided in `core/use-cases/board.ts`.
 */

import type { Board, BoardCard, BoardView } from '../core/use-cases/board.js'

/**
 * Escapes text for use in element content or a quoted attribute.
 *
 * Ticket titles are written by other people in the tracker, so they are
 * untrusted input to this renderer. Both quote styles are escaped so the same
 * function is safe in either position.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** A stable hue per name, so the same person keeps the same colour. */
function hue(name: string): number {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}

function initials(name: string): string {
  const parts = name.split(/[\s._-]+/).filter(Boolean)
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : name.slice(0, 2)
  return letters.toUpperCase()
}

function renderCard(card: BoardCard): string {
  const link = card.url
    ? `<a class="key" href="${escapeHtml(card.url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(card.id)}</a>`
    : `<span class="key local">${escapeHtml(card.id)}</span>`

  // The title goes to the tracker, because that is where you act on a ticket.
  // The file is one click away rather than zero — `.md` at the end of the card.
  const title = card.url
    ? `<a class="title" href="${escapeHtml(card.url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(card.title)}</a>`
    : `<a class="title" href="${escapeHtml(card.path)}">${escapeHtml(card.title)}</a>`

  const assignee = card.assignee
    ? `<span class="who" style="--h:${hue(card.assignee)}" title="${escapeHtml(card.assignee)}">${escapeHtml(initials(card.assignee))}</span>`
    : '<span class="who none" title="Unassigned">··</span>'

  const meta = [
    card.parent ? `<span class="tag parent">↑ ${escapeHtml(card.parent)}</span>` : '',
    card.priority ? `<span class="tag">${escapeHtml(card.priority)}</span>` : '',
    ...card.labels.map((l) => `<span class="tag label">${escapeHtml(l)}</span>`),
  ].join('')

  // The search box matches against this attribute, so everything searchable has
  // to be in it — including fields not otherwise shown on the card.
  const haystack = [card.id, card.title, card.assignee ?? 'unassigned', card.type, card.parent ?? '', ...card.labels]
    .join(' ')
    .toLowerCase()

  return `<article class="card${card.conflict ? ' conflict' : ''}" draggable="true" data-id="${escapeHtml(card.id)}" data-status="${escapeHtml(card.status)}" data-find="${escapeHtml(haystack)}">
        <div class="row">${link}<span class="type t-${escapeHtml(card.type.toLowerCase().replace(/[^a-z]+/g, '-'))}">${escapeHtml(card.type)}</span>${assignee}</div>
        ${title}
        ${meta ? `<div class="meta">${meta}</div>` : ''}
        <div class="row foot"><a class="file" href="${escapeHtml(card.path)}">${escapeHtml(card.id)}.md</a></div>
        ${card.conflict ? '<div class="warn">conflict — run <code>mgmt resolve</code></div>' : ''}
      </article>`
}

function renderView(view: BoardView, empty: string): string {
  if (view.total === 0) {
    return `<section class="board" id="${view.key}" hidden><p class="empty">${escapeHtml(empty)}</p></section>`
  }

  const columns = view.columns
    .map(
      (col) => `<section class="col" data-status="${escapeHtml(col.status)}">
      <h2>${escapeHtml(col.status)}<span class="count">${col.cards.length}</span></h2>
      <div class="drop">
      ${col.cards.map(renderCard).join('\n      ')}
      </div>
    </section>`,
    )
    .join('\n    ')

  return `<section class="board" id="${view.key}" hidden>
    ${columns}
  </section>`
}

const STYLE = `
:root {
  --bg: #f6f7f9; --panel: #fff; --ink: #14161a; --dim: #666e7a;
  --line: #e2e5ea; --accent: #2f6feb; --warn: #b4451c;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a; --panel: #1c1f25; --ink: #e8eaee; --dim: #98a0ad;
    --line: #2a2e36; --accent: #6f9bff; --warn: #e08a5a;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 14px/1.5 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
}
header {
  position: sticky; top: 0; z-index: 2; background: var(--bg);
  border-bottom: 1px solid var(--line); padding: 14px 20px;
  display: flex; gap: 14px; align-items: center; flex-wrap: wrap;
}
h1 { font-size: 15px; margin: 0; font-weight: 600; }
.tabs { display: flex; gap: 4px; }
.tabs button {
  font: inherit; cursor: pointer; padding: 5px 12px; border-radius: 999px;
  border: 1px solid var(--line); background: var(--panel); color: var(--dim);
}
.tabs button[aria-selected="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
input[type="search"] {
  font: inherit; padding: 5px 10px; border-radius: 6px; margin-left: auto;
  border: 1px solid var(--line); background: var(--panel); color: var(--ink); min-width: 200px;
}
.stamp { color: var(--dim); font-size: 12px; }
.board { display: flex; gap: 14px; padding: 18px 20px 40px; align-items: flex-start; overflow-x: auto; }
.board[hidden] { display: none; }
.col { flex: 0 0 300px; display: flex; flex-direction: column; gap: 10px; }
.col h2 {
  font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim);
  margin: 0; display: flex; gap: 8px; align-items: center;
}
.count { background: var(--line); color: var(--dim); border-radius: 999px; padding: 0 7px; font-size: 11px; }
.card {
  background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  padding: 10px 12px; display: flex; flex-direction: column; gap: 6px;
}
.card.hide { display: none; }
.card.conflict { border-color: var(--warn); }
.row { display: flex; gap: 8px; align-items: center; }
.key { font: 600 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--accent); text-decoration: none; }
.key.local { color: var(--dim); }
.type { font-size: 11px; color: var(--dim); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; }
.t-epic { color: #8b5cf6; border-color: #8b5cf6; }
.t-sub-task { opacity: .75; }
.who {
  margin-left: auto; width: 22px; height: 22px; border-radius: 50%; flex: none;
  display: grid; place-items: center; font-size: 10px; font-weight: 600; color: #fff;
  background: hsl(var(--h) 55% 42%);
}
.who.none { background: transparent; border: 1px dashed var(--line); color: var(--dim); }
.title { color: inherit; text-decoration: none; font-weight: 500; }
.title:hover { text-decoration: underline; }
.meta { display: flex; flex-wrap: wrap; gap: 4px; }
.tag { font-size: 11px; color: var(--dim); background: var(--bg); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; }
.tag.parent { color: var(--accent); }
.warn { font-size: 11px; color: var(--warn); }
.foot { margin-top: 2px; }
.file { font: 11px ui-monospace, Menlo, monospace; color: var(--dim); text-decoration: none; }
.file:hover { text-decoration: underline; }
.drop { display: flex; flex-direction: column; gap: 10px; min-height: 44px; border-radius: 8px; }
.col.over .drop { outline: 2px dashed var(--accent); outline-offset: 3px; }
.card.moving { opacity: .45; }
.card.busy { pointer-events: none; opacity: .6; }
#toast {
  position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%);
  background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--accent);
  border-radius: 6px; padding: 9px 14px; max-width: 70ch; box-shadow: 0 6px 24px #0003;
}
#toast[hidden] { display: none; }
#toast.bad { border-left-color: var(--warn); color: var(--warn); }
.mode { font-size: 12px; color: var(--dim); }
.mode.live { color: var(--accent); }
.empty { color: var(--dim); padding: 40px 0; }
code { font: 11px ui-monospace, Menlo, monospace; }
`

// No external anything, and no framework: the whole interaction is two class
// toggles. Keeping it this small is what makes "the board still opens in five
// years" a safe claim.
const SCRIPT = `
const boards = [...document.querySelectorAll('.board')];
const live = document.body.dataset.live === '1';
const nonce = document.body.dataset.nonce || '';
const tabs = [...document.querySelectorAll('.tabs button')];
function show(key) {
  boards.forEach(b => { b.hidden = b.id !== key; });
  tabs.forEach(t => t.setAttribute('aria-selected', String(t.dataset.for === key)));
  location.hash = key;
}
tabs.forEach(t => t.addEventListener('click', () => show(t.dataset.for)));
show(location.hash.slice(1) === 'mine' ? 'mine' : 'project');

const search = document.querySelector('input[type=search]');
search.addEventListener('input', () => {
  const q = search.value.trim().toLowerCase();
  document.querySelectorAll('.card').forEach(c => {
    c.classList.toggle('hide', q !== '' && !c.dataset.find.includes(q));
  });
  document.querySelectorAll('.col').forEach(col => {
    const shown = col.querySelectorAll('.card:not(.hide)').length;
    col.querySelector('.count').textContent = shown;
  });
});

// ── drag to move ───────────────────────────────────────────────────────────
// The card moves in the DOM only after the tracker confirms it. An optimistic
// move that silently reverted would leave the board disagreeing with Jira, and
// this board's whole claim is that it never shows something untrue.

const toast = document.getElementById('toast');
let hideAt = null;
function say(message, bad) {
  toast.textContent = message;
  toast.classList.toggle('bad', !!bad);
  toast.hidden = false;
  clearTimeout(hideAt);
  hideAt = setTimeout(() => { toast.hidden = true; }, bad ? 9000 : 3500);
}

let dragged = null;

document.querySelectorAll('.card').forEach(card => {
  card.addEventListener('dragstart', e => {
    dragged = card;
    card.classList.add('moving');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox will not start a drag without data on the transfer.
    e.dataTransfer.setData('text/plain', card.dataset.id);
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('moving');
    document.querySelectorAll('.col.over').forEach(c => c.classList.remove('over'));
    dragged = null;
  });
});

function recount(col) {
  col.querySelector('.count').textContent = col.querySelectorAll('.card:not(.hide)').length;
}

document.querySelectorAll('.col').forEach(col => {
  col.addEventListener('dragover', e => {
    if (!dragged) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    col.classList.add('over');
  });
  col.addEventListener('dragleave', e => {
    if (!col.contains(e.relatedTarget)) col.classList.remove('over');
  });
  col.addEventListener('drop', async e => {
    e.preventDefault();
    col.classList.remove('over');
    const card = dragged;
    if (!card) return;

    const to = col.dataset.status;
    const from = card.dataset.status;
    if (to === from) return;

    if (!live) {
      say('This board is a file, so it cannot move anything. Run "mgmt board --serve --apply" to drag tickets into a new status.', true);
      return;
    }

    card.classList.add('busy');
    try {
      const res = await fetch('/api/move', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mgmt-nonce': nonce },
        body: JSON.stringify({ id: card.dataset.id, to }),
      });
      const result = await res.json();
      if (!res.ok) { say(result.error || ('move refused (' + res.status + ')'), true); return; }

      // Land it where the tracker says it landed, which a workflow
      // post-function can make different from where it was dropped.
      const target = [...document.querySelectorAll('.col')]
        .filter(c => c.dataset.status === result.to);
      const from_col = card.closest('.col');

      document.querySelectorAll('.card[data-id="' + CSS.escape(card.dataset.id) + '"]').forEach(twin => {
        const source = twin.closest('.col');
        const board = twin.closest('.board');
        const dest = target.find(c => c.closest('.board') === board);
        twin.dataset.status = result.to;
        if (dest) dest.querySelector('.drop').appendChild(twin);
        if (source) recount(source);
        if (dest) recount(dest);
      });

      say(result.to === to
        ? card.dataset.id + ' → ' + result.to
        : card.dataset.id + ' → ' + result.to + ' (the workflow moved it there, not to ' + to + ')');
      if (from_col) recount(from_col);
    } catch (err) {
      say('Could not reach mgmt: ' + err.message + '. Is it still running?', true);
    } finally {
      card.classList.remove('busy');
    }
  });
});
`

export interface RenderOptions {
  project: string
  /** Authorises writes for this run; see board-server.ts. */
  nonce: string
  /** Whether a drag may reach the tracker, i.e. whether `--apply` was given. */
  apply: boolean
}

export function renderBoardHtml(board: Board, opts: RenderOptions): string {
  const mineEmpty =
    board.me === null
      ? 'No identity resolved, so no board can be filtered. Set MGMT_ME in .env, or run `mgmt board` with a reachable tracker so it can ask who the token belongs to.'
      : `Nothing is assigned to ${board.me} right now.`

  const who = board.me ? `My tasks (${escapeHtml(board.me)})` : 'My tasks'

  // Serving is not consenting to writes, so a board started without --apply
  // says so in the header rather than failing at the end of a drag.
  const writable = opts.apply

  const mode = writable
    ? '<span class="mode live">drag to move</span>'
    : '<span class="mode">read-only — restart with --apply to drag</span>'

  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.project)} board</title>
<style>${STYLE}</style>
<body data-live="${writable ? '1' : '0'}" data-nonce="${escapeHtml(opts.nonce)}">
<header>
  <h1>${escapeHtml(opts.project)}</h1>
  <div class="tabs">
    <button data-for="project" aria-selected="true">Project tasks<span class="count">${board.project.total}</span></button>
    <button data-for="mine" aria-selected="false">${who}<span class="count">${board.mine.total}</span></button>
  </div>
  <input type="search" placeholder="Filter by key, title, assignee…" aria-label="Filter cards">
  ${mode}
  <span class="stamp">generated ${escapeHtml(board.generated)}</span>
</header>
${renderView(board.project, 'No tickets in this workspace yet.')}
${renderView(board.mine, mineEmpty)}
<div id="toast" hidden></div>
<script>${SCRIPT}</script>
`
}
