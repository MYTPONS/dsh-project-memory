/**
 * dsh-project-memory — 项目操作记忆插件。
 *
 * 目标：给每个被操作的项目建立一份 .dsh 记忆（记录 / 日志 / 文档 / 功能清单），
 * 同时在主 .dsh 下保留一份**权威存档**；模型只提供“要记什么”，位置、日期、备份策略由插件决定。
 *
 * 设计要点（owner 需求）：
 * - 三类内容：record（记录）/ log（日志）/ doc（文档+功能清单）。分离存放。
 * - 项目级：<项目根>/.dsh/records|logs|docs；主存档：<DSH_HOME>/project-memory/<projectKey>/。
 *   **主存档是权威**：项目被删/项目级 .dsh 被清后，主存档仍在，可 list/restore/forget。
 * - 用户主目录（其 .dsh 即 DSH 本体）或 DSH 本体目录本身 → 只写主记录，项目级不落盘。
 * - 记录/日志自动加时间戳（默认 Asia/Shanghai）；模型不提供日期/路径。
 * - 支持**跨项目操作**：所有工具都接受 project=目标项目根，可在 A 项目里给 B 项目建档/记录/提交。
 * - **兼容与自愈**：目录/子目录/META 缺失时自动补齐；读文档在项目级缺失时回退到主存档；
 *   project_restore 可从主存档重建项目级 .dsh（或反向初次导入）。
 * - 关键词 + 日期/日期窗口检索，机械搜索返回有界结果，避免模型翻上下文。
 * - 备份：仅“覆盖或删除既有文档”才备份；追加记录/日志与 git 不备份；备份写系统临时目录（重启自动清理），
 *   按文件保留最近 backupMaxPerFile（默认 6）份。
 * - git 提交内置；默认只提交不推送。
 *
 * 本包以 link 安装，只依赖 Node 内置模块与 DSH_HOME，不 import 任何 @deepseek-ai/* 运行期包。
 */

import {
  mkdirSync, existsSync, readFileSync, appendFileSync, writeFileSync,
  readdirSync, statSync, copyFileSync, rmSync,
} from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const pExecFile = promisify(execFile)

export const name = 'project-memory'
export const inject = ['tools', 'workingDirectory', 'systemPrompt']

const DEFAULT_CONFIG = {
  mainDir: '',
  backupMode: 'docs-only', // off | docs-only | all
  backupMaxPerFile: 6,
  backupTempDir: '',
  gitEnabled: true,
  timeZone: 'Asia/Shanghai',
  maxEntryBytes: 120000,
  searchLimitDefault: 20,
  autoRestore: false, // 项目级 .dsh 缺失且主存档存在时，是否在下次操作时自动回灌
  detectRoot: false, // true=从 cwd 向上找最近的 .git/.dsh/package.json 作为项目根；false=直接用 cwd
  rootMarkers: ['.git', '.dsh', 'package.json'],
  scaffoldDocs: false, // true=为新项目首次建档时创建 direction.md / features.md 模板
}

function resolveDshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim().length > 0) return resolve(env)
  return join(homedir(), '.dsh')
}

// ─────────────────────────── 时间 ───────────────────────────

function nowInfo(timeZone) {
  const d = new Date()
  let date, time, offset
  try {
    const p = new Intl.DateTimeFormat('sv-SE', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      timeZoneName: 'longOffset',
    }).formatToParts(d)
    const g = (t) => p.find((x) => x.type === t)?.value ?? ''
    date = `${g('year')}-${g('month')}-${g('day')}`
    time = `${g('hour')}:${g('minute')}:${g('second')}`
    offset = (g('timeZoneName') || 'GMT+00:00').replace('GMT', '') || '+00:00'
  } catch {
    const iso = d.toISOString()
    date = iso.slice(0, 10); time = iso.slice(11, 19); offset = '+00:00'
  }
  return { date, stamp: `${date} ${time} ${offset}`, epoch: d.getTime() }
}

function dateShift(dateKey, days) {
  const t = Date.parse(`${dateKey}T00:00:00Z`)
  if (Number.isNaN(t)) return dateKey
  return new Date(t + days * 86400000).toISOString().slice(0, 10)
}
function isDateKey(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) }

// ─────────────────────────── 路径 / 存储 ───────────────────────────

function sanitizeSegment(input) {
  const s = String(input).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
  return s.length > 0 ? s : 'root'
}

function projectKeyOf(root) {
  const clean = resolve(root).replace(/^\/+/, '')
  const readable = clean.split('/').map(sanitizeSegment).join('__').slice(0, 120)
  const h = createHash('sha1').update(resolve(root)).digest('hex').slice(0, 8)
  return `${readable || 'root'}--${h}`
}

/** 从 cwd 向上查找项目根：命中任一 rootMarkers 的最近目录即项目根；找不到返回 cwd。 */
function detectProjectRoot(cwd, markers) {
  let dir = resolve(cwd)
  const root = resolve('/')
  while (true) {
    for (const m of markers) {
      try { if (existsSync(join(dir, m))) return dir } catch { /* ignore */ }
    }
    if (dir === root) return resolve(cwd)
    const parent = dir.slice(0, dir.lastIndexOf('/')) || '/'
    if (parent === dir) return resolve(cwd)
    dir = parent
  }
}

function readMeta(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'META.json'), 'utf8')) } catch { return null }
}

/** 幂等补齐目录与 META；缺失的 records/logs/docs 会自动创建。 */
function ensureStore(dir, meta) {
  mkdirSync(join(dir, 'records'), { recursive: true })
  mkdirSync(join(dir, 'logs'), { recursive: true })
  mkdirSync(join(dir, 'docs'), { recursive: true })
  const metaFile = join(dir, 'META.json')
  const prev = existsSync(metaFile) ? readMeta(dir) : null
  const next = {
    version: 1,
    root: (meta && meta.root) || (prev && prev.root) || null,
    key: (meta && meta.key) || (prev && prev.key) || null,
    createdAt: (prev && prev.createdAt) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  try { writeFileSync(metaFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8') } catch { /* ignore */ }
}

function resolveLayout(root, opts) {
  const home = resolve(homedir())
  const dshHome = resolve(opts.dshHome)
  const r = resolve(root)
  const rootExists = existsSync(r)
  let skipProject = false
  let skipReason = null
  if (r === home) { skipProject = true; skipReason = 'home' }
  else if (r === dshHome) { skipProject = true; skipReason = 'dsh-home' }
  else if (!rootExists) { skipProject = true; skipReason = 'root-missing' }
  const key = projectKeyOf(r)
  const mainDir = join(opts.mainDir, key)
  const projectDir = skipProject ? null : join(r, '.dsh')
  return { root: r, key, home, dshHome, rootExists, skipProject, skipReason, mainDir, projectDir }
}

function storesOf(layout) {
  const list = [layout.mainDir]
  if (layout.projectDir) list.push(layout.projectDir)
  return list
}

function projectStoreExists(layout) {
  return layout.projectDir ? existsSync(join(layout.projectDir, 'docs')) || existsSync(layout.projectDir) : false
}

// ─────────────────────────── 备份 ───────────────────────────

function pruneBackups(dir, base, max) {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.`))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const { f } of files.slice(max)) { try { rmSync(join(dir, f), { force: true }) } catch { /* ignore */ } }
  } catch { /* ignore */ }
}

function backupFile(filePath, opts) {
  if (opts.backupMode === 'off') return null
  if (!existsSync(filePath)) return null
  try {
    const segs = filePath.split('/').filter(Boolean)
    const base = segs[segs.length - 1]
    const dir = join(opts.backupTempDir, segs.slice(0, -1).join('/'))
    mkdirSync(dir, { recursive: true })
    const uniq = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const target = join(dir, `${base}.${uniq}.bak`)
    copyFileSync(filePath, target)
    pruneBackups(dir, base, Math.max(1, opts.backupMaxPerFile))
    return target
  } catch { return null }
}

// ─────────────────────────── 写记录 / 日志 ───────────────────────────

function oneLine(s) { return String(s).replace(/\s*\n\s*/g, ' ').trim() }

function appendEntry(storeDir, kind, ts, title, content, tags, meta) {
  const sub = kind === 'log' ? 'logs' : 'records'
  ensureStore(storeDir, meta)
  const file = join(storeDir, sub, `${ts.date}.md`)
  let text
  if (kind === 'log') {
    const tagstr = tags && tags.length ? ` [${tags.join(',')}]` : ''
    text = `- ${ts.stamp}${tagstr} ${oneLine(content)}\n`
  } else {
    text = `## ${ts.stamp}${title ? ` — ${title}` : ''}\n${String(content).trim()}\n\n`
  }
  appendFileSync(file, text, 'utf8')
  return file
}

// ─────────────────────────── 文档 / 功能清单 ───────────────────────────

function docPath(storeDir, docName) {
  const safe = sanitizeSegment(docName || 'direction')
  return join(storeDir, 'docs', safe.endsWith('.md') ? safe : `${safe}.md`)
}

const FEATURES_DOC = 'features'

function parseFeatures(text) {
  const items = []
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*-\s*\[([ xX])\]\s+(.*)$/)
    if (m) items.push({ done: m[1].toLowerCase() === 'x', text: m[2].trim() })
  }
  return items
}

function formatFeatures(items) {
  const lines = ['# 功能清单', '']
  for (const it of items) lines.push(`- [${it.done ? 'x' : ' '}] ${it.text}`)
  lines.push('')
  return lines.join('\n')
}

function writeFeatures(storeDir, items, meta) {
  ensureStore(storeDir, meta)
  const file = docPath(storeDir, FEATURES_DOC)
  writeFileSync(file, formatFeatures(items), 'utf8')
  return file
}

/** 读取文档：先项目级，缺失回退主存档。 */
function readDocWithFallback(layout, docName) {
  const stores = storesOf(layout)
  for (const store of stores) {
    const f = docPath(store, docName)
    if (existsSync(f)) return { file: f, store, content: readFileSync(f, 'utf8') }
  }
  return null
}

function featuresWithFallback(layout) {
  for (const store of storesOf(layout)) {
    const f = docPath(store, FEATURES_DOC)
    if (existsSync(f)) return parseFeatures(readFileSync(f, 'utf8'))
  }
  return []
}

// ─────────────────────────── 检索 ───────────────────────────

function readDocs(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue
    const full = join(dir, f)
    try { if (statSync(full).isFile()) out.push({ name: f, full }) } catch { /* ignore */ }
  }
  return out
}

function searchStore(storeDir, { query, kinds, from, to, limit }) {
  const results = []
  const dirs = []
  if (!kinds || kinds.includes('record')) dirs.push(['record', join(storeDir, 'records'), 'records'])
  if (!kinds || kinds.includes('log')) dirs.push(['log', join(storeDir, 'logs'), 'logs'])
  if (!kinds || kinds.includes('doc')) dirs.push(['doc', join(storeDir, 'docs'), 'docs'])
  const q = query.toLowerCase()
  for (const [kind, dir, sub] of dirs) {
    for (const { name, full } of readDocs(dir)) {
      let dateKey = null
      const dm = name.match(/^(\d{4}-\d{2}-\d{2})\.md$/)
      if (dm) dateKey = dm[1]
      if (from && dateKey && dateKey < from) continue
      if (to && dateKey && dateKey > to) continue
      if (from && !dateKey && kind !== 'doc') continue
      let text
      try { text = readFileSync(full, 'utf8') } catch { continue }
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          results.push({ kind, date: dateKey, file: `${sub}/${name}`, line: i + 1, text: lines[i].trim().slice(0, 300) })
        }
      }
    }
  }
  results.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
  const total = results.length
  return { total, truncated: total > limit, hits: results.slice(0, limit) }
}

// ─────────────────────────── 档案 / 自愈 ───────────────────────────

function listArchives(opts) {
  const base = opts.mainDir
  if (!existsSync(base)) return []
  const out = []
  for (const key of readdirSync(base)) {
    const dir = join(base, key)
    try { if (!statSync(dir).isDirectory()) continue } catch { continue }
    const meta = readMeta(dir) || {}
    const root = meta.root || null
    out.push({
      key,
      root,
      createdAt: meta.createdAt || null,
      updatedAt: meta.updatedAt || null,
      projectStoreExists: root && root !== resolve(homedir()) && root !== opts.dshHome ? existsSync(join(root, '.dsh')) : false,
      rootExists: root ? existsSync(root) : false,
      counts: {
        records: readDocs(join(dir, 'records')).length,
        logs: readDocs(join(dir, 'logs')).length,
        docs: readDocs(join(dir, 'docs')).map((d) => d.name),
      },
    })
  }
  return out
}

function copyMd(srcDir, dstDir, overwrite = true) {
  let n = 0
  if (!existsSync(srcDir)) return n
  mkdirSync(dstDir, { recursive: true })
  for (const f of readdirSync(srcDir)) {
    if (!f.endsWith('.md')) continue
    const source = join(srcDir, f)
    const target = join(dstDir, f)
    if (!overwrite && existsSync(target)) continue
    try { if (statSync(source).isFile()) { copyFileSync(source, target); n++ } } catch { /* ignore */ }
  }
  return n
}

/** 用主存档重建项目级 .dsh（或主存档缺失时反向从项目级导入）。返回各目录复制条数。 */
function syncStores(layout, meta) {
  const main = layout.mainDir
  const proj = layout.projectDir
  if (!proj) return { ok: false, reason: '无项目级目录（主目录/DSH本体/项目根不存在）' }
  const mainHasAny = existsSync(main) && (readDocs(join(main, 'records')).length + readDocs(join(main, 'docs')).length + readDocs(join(main, 'logs')).length) > 0
  const projHasAny = existsSync(proj) && (readDocs(join(proj, 'records')).length + readDocs(join(proj, 'docs')).length + readDocs(join(proj, 'logs')).length) > 0
  let src, dst, direction
  if (mainHasAny && !projHasAny) { src = main; dst = proj; direction = 'main->project' }
  else if (!mainHasAny && projHasAny) { src = proj; dst = main; direction = 'project->main' }
  else if (mainHasAny && projHasAny) { src = main; dst = proj; direction = 'main->project(fill)' }
  else return { ok: false, reason: '两边都没有内容，无需恢复' }
  ensureStore(dst, meta)
  const overwrite = direction !== 'main->project(fill)'
  const copied = {
    records: copyMd(join(src, 'records'), join(dst, 'records'), overwrite),
    logs: copyMd(join(src, 'logs'), join(dst, 'logs'), overwrite),
    docs: copyMd(join(src, 'docs'), join(dst, 'docs'), overwrite),
  }
  ensureStore(main, meta)
  return { ok: true, direction, copied, mainDir: main, projectDir: proj }
}

// ─────────────────────────── git ───────────────────────────

async function runGit(cwd, args) {
  const { stdout, stderr } = await pExecFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 })
  return { stdout: stdout.trim(), stderr: stderr.trim() }
}

async function doGitCommit(cwd, { message, addAll, files, push, dryRun }) {
  await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (Array.isArray(files) && files.length > 0) await runGit(cwd, ['add', '--', ...files])
  else if (addAll !== false) await runGit(cwd, ['add', '-A'])
  const staged = await runGit(cwd, ['diff', '--cached', '--name-only'])
  if (staged.stdout.length === 0) return { ok: true, committed: false, reason: 'nothing-to-commit', message }
  if (dryRun) { const stat = await runGit(cwd, ['diff', '--cached', '--stat']); return { ok: true, committed: false, dryRun: true, stat: stat.stdout } }
  const commit = await runGit(cwd, ['commit', '-m', message])
  const head = await runGit(cwd, ['rev-parse', '--short', 'HEAD'])
  let pushed = false
  if (push === true) { await runGit(cwd, ['push']); pushed = true }
  return { ok: true, committed: true, hash: head.stdout, pushed, summary: commit.stdout.split('\n').slice(0, 3).join('\n') }
}

// ─────────────────────────── 输出 ───────────────────────────

function asRender(value) { return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }
const OUT = { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => asRender(v) }

// ─────────────────────── 自动注入（会话开头就把项目记忆塞进上下文） ───────────────────────
// 目的：解决「DSH 记不住项目改造细节」——不靠模型主动 project_read，
// 每个会话/每一步都自动把当前项目的需求文档、功能清单、最近一条记录渲染进系统提示。
// 只在「当前 cwd 确实是某个项目」时注入；home / DSH 本体 / 不存在的目录一律不注入。
const AUTO_DOCS = ['requirements', 'direction']
const AUTO_INJECT_MAX_CHARS = 6000   // 总预算
const AUTO_DOC_MAX_CHARS = 2200      // 单篇文档上限
const AUTO_RECORD_TAIL_CHARS = 2000  // 最近记录尾部

function latestRecordFile(layout) {
  for (const store of storesOf(layout)) {
    const dir = join(store, 'records')
    if (!existsSync(dir)) continue
    let best = null
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.md')) continue
        const full = join(dir, f)
        let t = 0
        try { t = statSync(full).mtimeMs } catch { continue }
        if (!best || t > best.t) best = { full, t, name: f }
      }
    } catch { /* ignore */ }
    if (best) return best
  }
  return null
}

function buildProjectDigest(context, ctx, opts) {
  let cwd = null
  // 优先用 workingDirectory.get(agent.session)：这是已提交的权威目录（切换工作目录后也准确）。
  try {
    const agent = context?.agent
    if (agent && ctx.workingDirectory && typeof ctx.workingDirectory.get === 'function') {
      cwd = ctx.workingDirectory.get(agent.session)
    }
  } catch { /* ignore */ }
  if (!cwd) { try { cwd = context?.agent?.session?.header?.cwd ?? null } catch { /* ignore */ } }
  if (!cwd) cwd = ctx.workingDirectory?.defaultDirectory ?? process.cwd()
  let root
  try { root = opts.detectRoot ? detectProjectRoot(cwd, opts.rootMarkers) : resolve(cwd) } catch { return '' }
  const layout = resolveLayout(root, opts)
  if (layout.skipProject) return ''   // home / dsh-home / 不存在 → 不注入

  const parts = []
  const seen = new Set()
  for (const name of AUTO_DOCS) {
    const hit = readDocWithFallback(layout, name)
    if (!hit || !hit.content.trim()) continue
    seen.add(hit.file)
    let body = hit.content.trim()
    if (body.length > AUTO_DOC_MAX_CHARS) body = body.slice(0, AUTO_DOC_MAX_CHARS) + '\n…(截断，完整见 ' + hit.file + ')'
    parts.push(`### ${name}.md\n${body}`)
  }
  const feats = featuresWithFallback(layout)
  if (feats.length) {
    const done = feats.filter((i) => i.done)
    const todo = feats.filter((i) => !i.done)
    const lines = []
    if (todo.length) lines.push('未完成：' + todo.slice(0, 15).map((i) => i.text).join('；'))
    if (done.length) lines.push('已完成：' + done.slice(-10).map((i) => i.text).join('；'))
    parts.push('### 功能清单\n' + lines.join('\n'))
  }
  const rec = latestRecordFile(layout)
  if (rec && !seen.has(rec.full)) {
    try {
      let body = readFileSync(rec.full, 'utf8').trim()
      if (body.length > AUTO_RECORD_TAIL_CHARS) body = '…' + body.slice(-AUTO_RECORD_TAIL_CHARS)
      parts.push(`### 最近记录（${rec.name}）\n${body}`)
    } catch { /* ignore */ }
  }
  if (!parts.length) return ''
  let text = `## 本项目已有记忆（自动加载，不用再问用户）\n项目根：${layout.root}\n` + parts.join('\n\n')
  if (text.length > AUTO_INJECT_MAX_CHARS) text = text.slice(0, AUTO_INJECT_MAX_CHARS) + '\n…(项目记忆已截断，用 project_read 看全部)'
  return text
}

const PROJECT_PARAM = { type: 'string', description: '目标项目根目录（绝对路径，或相对当前目录）。省略=当前会话工作目录。用于跨项目操作：在 A 项目里给 B 项目建档/记录/提交。' }

// ─────────────────────────── 插件入口 ───────────────────────────

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}) }
  const dshHome = resolveDshHome()
  const opts = {
    dshHome,
    mainDir: config.mainDir && String(config.mainDir).trim() ? resolve(config.mainDir) : join(dshHome, 'project-memory'),
    backupMode: ['off', 'docs-only', 'all'].includes(config.backupMode) ? config.backupMode : 'docs-only',
    backupMaxPerFile: Number.isInteger(config.backupMaxPerFile) && config.backupMaxPerFile > 0 ? config.backupMaxPerFile : 6,
    backupTempDir: config.backupTempDir && String(config.backupTempDir).trim() ? resolve(config.backupTempDir) : join(tmpdir(), 'dsh-project-memory', 'backups'),
    gitEnabled: config.gitEnabled !== false,
    timeZone: typeof config.timeZone === 'string' && config.timeZone ? config.timeZone : 'Asia/Shanghai',
    maxEntryBytes: Number.isInteger(config.maxEntryBytes) && config.maxEntryBytes > 0 ? config.maxEntryBytes : 120000,
    searchLimitDefault: Number.isInteger(config.searchLimitDefault) && config.searchLimitDefault > 0 ? config.searchLimitDefault : 20,
    autoRestore: config.autoRestore === true,
    detectRoot: config.detectRoot === true,
    rootMarkers: Array.isArray(config.rootMarkers) && config.rootMarkers.length ? config.rootMarkers.map(String) : ['.git', '.dsh', 'package.json'],
    scaffoldDocs: config.scaffoldDocs === true,
  }

  const cwdOf = async (exec) => {
    if (exec && exec.agent) return await ctx.workingDirectory.ensure(exec.agent, exec.signal)
    return ctx.workingDirectory ? ctx.workingDirectory.defaultDirectory : process.cwd()
  }

  const targetRoot = async (exec, args) => {
    const cwd = await cwdOf(exec)
    if (args && typeof args.project === 'string' && args.project.trim()) {
      return isAbsolute(args.project.trim()) ? resolve(args.project.trim()) : resolve(cwd, args.project.trim())
    }
    return opts.detectRoot ? detectProjectRoot(cwd, opts.rootMarkers) : cwd
  }

  const layoutOf = async (exec, args) => {
    const layout = resolveLayout(await targetRoot(exec, args), opts)
    const meta = { root: layout.root, key: layout.key }
    // 兼容：主存档存在但项目级缺失 → 视 autoRestore 决定是否自动回灌
    if (layout.projectDir && opts.autoRestore && !projectStoreExists(layout) && existsSync(layout.mainDir)) {
      try { syncStores(layout, meta) } catch { /* ignore */ }
    }
    return layout
  }

  const maybeScaffold = (layout) => {
    if (!opts.scaffoldDocs || !layout.projectDir) return
    const meta = { root: layout.root, key: layout.key }
    for (const store of storesOf(layout)) {
      ensureStore(store, meta)
      const dir = docPath(store, 'direction')
      if (!existsSync(dir)) writeFileSync(dir, `# 项目方向\n\n（在这里写这个项目要做什么、方向、背景。）\n`, 'utf8')
      const feat = docPath(store, FEATURES_DOC)
      if (!existsSync(feat)) writeFileSync(feat, '# 功能清单\n\n', 'utf8')
    }
  }

  const writeBoth = (layout, kind, ts, title, content, tags) => {
    maybeScaffold(layout)
    const meta = { root: layout.root, key: layout.key }
    const files = []
    for (const store of storesOf(layout)) files.push(appendEntry(store, kind, ts, title, content, tags, meta))
    return files
  }

  const writeFeaturesBoth = (layout, items) => {
    maybeScaffold(layout)
    const meta = { root: layout.root, key: layout.key }
    const files = []
    for (const store of storesOf(layout)) {
      const file = docPath(store, FEATURES_DOC)
      if (existsSync(file) && opts.backupMode !== 'off') backupFile(file, opts)
      files.push(writeFeatures(store, items, meta))
    }
    return files
  }

  const writeDocBoth = (layout, docName, content, mode) => {
    maybeScaffold(layout)
    const meta = { root: layout.root, key: layout.key }
    const written = []
    const backups = []
    for (const store of storesOf(layout)) {
      ensureStore(store, meta)
      const file = docPath(store, docName)
      const existed = existsSync(file)
      if (existed && mode === 'replace' && (opts.backupMode === 'docs-only' || opts.backupMode === 'all')) {
        const b = backupFile(file, opts); if (b) backups.push(b)
      }
      if (mode === 'append') appendFileSync(file, `\n${String(content).trim()}\n`, 'utf8')
      else writeFileSync(file, String(content).endsWith('\n') ? String(content) : `${content}\n`, 'utf8')
      written.push(file)
    }
    return { written, backups }
  }

  const reg = (def, label) => ctx.effect(() => ctx.tools.register(def), label)

  // ── 概览 ──
  reg({
    name: 'project_status',
    description: '查看项目记忆状态：项目根、项目级/主存档路径、是否“用户主目录只写主记录”、项目根是否存在、项目级 .dsh 是否缺失（可 restore）、备份策略、文档与功能概览。支持 project= 指定别处项目。',
    parameters: { type: 'object', properties: { project: PROJECT_PARAM } },
    output: OUT,
    async execute(args, exec) {
      const layout = await layoutOf(exec, args)
      const store = layout.mainDir
      const mainExists = existsSync(store)
      const docFiles = readDocs(join(store, 'docs')).map((d) => d.name)
      const featItems = featuresWithFallback(layout)
      const recFiles = readDocs(join(store, 'records')).sort((a, b) => b.name.localeCompare(a.name))
      const recent = []
      for (const f of recFiles.slice(0, 3)) {
        try {
          const hs = readFileSync(f.full, 'utf8').split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3).trim())
          recent.push(...hs.reverse())
        } catch { /* ignore */ }
      }
      const metaMain = readMeta(store)
      return {
        projectRoot: layout.root,
        projectKey: layout.key,
        rootExists: layout.rootExists,
        projectStore: layout.projectDir || null,
        projectStoreExists: layout.projectDir ? projectStoreExists(layout) : false,
        mainStore: store,
        mainArchiveExists: mainExists,
        lastUpdated: (metaMain && metaMain.updatedAt) || null,
        homeException: layout.skipProject,
        skipReason: layout.skipReason,
        warn: layout.skipReason === 'root-missing' ? '项目根不存在：只写主存档，项目级不落盘。' : (layout.projectDir && !projectStoreExists(layout) && mainExists ? '项目级 .dsh 缺失/为空，但主存档存在；可用 project_restore 从主存档重建。' : null),
        backup: { mode: opts.backupMode, tempDir: opts.backupTempDir, maxPerFile: opts.backupMaxPerFile, note: '追加记录/日志不备份；仅覆盖文档时备份；备份在系统临时目录，重启自动清理。' },
        gitEnabled: opts.gitEnabled,
        autoRestore: opts.autoRestore,
        detectRoot: opts.detectRoot,
        timeZone: opts.timeZone,
        counts: { recordFiles: recFiles.length, logFiles: readDocs(join(store, 'logs')).length },
        recentRecords: recent.slice(0, 5),
        docs: { files: docFiles, features: featItems.length ? { total: featItems.length, done: featItems.filter((i) => i.done).length, pending: featItems.filter((i) => !i.done).length } : null },
      }
    },
  }, 'project-memory: project_status')

  // ── 写记录 / 日志 ──
  reg({
    name: 'project_write',
    description: '把一条操作记录或操作日志写入项目记忆（自动加时间戳，并同时写项目 .dsh 与主存档；主目录/DSH本体下只写主记录）。你只需给出要记的内容。kind=record 记“做了什么/结论/决定”，kind=log 记过程性事件。支持 project= 指定别处项目（跨项目记录）。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['record', 'log'], description: 'record=操作记录（多行要点）；log=操作日志（一行一条）。' },
        content: { type: 'string', description: '要记录的内容。记录可多行；日志会被压成一行。' },
        title: { type: 'string', description: '记录标题（仅 record 用），如“完成登录接口”。' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选标签，便于检索。' },
        project: PROJECT_PARAM,
      },
      required: ['kind', 'content'],
    },
    output: OUT,
    async execute(args, exec) {
      const content = String(args.content ?? '')
      if (content.trim().length === 0) throw new Error('content 不能为空')
      if (Buffer.byteLength(content, 'utf8') > opts.maxEntryBytes) throw new Error(`内容过大（>${opts.maxEntryBytes} 字节），请精简后再记`)
      const layout = await layoutOf(exec, args)
      const ts = nowInfo(opts.timeZone)
      const kind = args.kind === 'log' ? 'log' : 'record'
      const files = writeBoth(layout, kind, ts, args.title, content, args.tags)
      return { ok: true, kind, stamp: ts.stamp, projectRoot: layout.root, writtenTo: files, projectWide: layout.projectDir ? '已写项目 .dsh 与主存档' : `仅写主存档（原因: ${layout.skipReason}）` }
    },
  }, 'project-memory: project_write')

  // ── 文档 ──
  reg({
    name: 'project_doc',
    description: '管理项目文档（存放于项目 .dsh/docs，不入项目根，避免乱套）。用于记录项目方向、背景、规范等。action=list/read/write/append；read 在项目级缺失时回退主存档；write 覆盖会先备份旧文件。支持 project= 指定别处项目。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'write', 'append', 'delete'], description: '操作类型。delete 删除文档（会先备份）。' },
        name: { type: 'string', description: '文档名（不带 .md 亦可），默认 direction。' },
        content: { type: 'string', description: 'write/append 时的正文。' },
        project: PROJECT_PARAM,
      },
      required: ['action'],
    },
    output: OUT,
    async execute(args, exec) {
      const layout = await layoutOf(exec, args)
      const nm = args.name || 'direction'
      if (args.action === 'list') {
        const store = layout.projectDir || layout.mainDir
        ensureStore(store, { root: layout.root, key: layout.key })
        return { ok: true, store, docs: readDocs(join(store, 'docs')).map((d) => d.name) }
      }
      if (args.action === 'read') {
        const hit = readDocWithFallback(layout, nm)
        if (!hit) return { ok: false, reason: 'not-found', name: nm, available: readDocs(join(layout.mainDir, 'docs')).map((d) => d.name) }
        return { ok: true, file: hit.file, source: hit.store === layout.mainDir ? 'main' : 'project', content: hit.content.slice(0, 20000) }
      }
      if (args.action === 'delete') {
        const removed = []
        const backups = []
        for (const store of storesOf(layout)) {
          const file = docPath(store, nm)
          if (!existsSync(file)) continue
          if (opts.backupMode === 'docs-only' || opts.backupMode === 'all') { const b = backupFile(file, opts); if (b) backups.push(b) }
          rmSync(file, { force: true })
          removed.push(file)
        }
        if (removed.length === 0) return { ok: false, reason: 'not-found', name: nm }
        return { ok: true, action: 'delete', name: nm, removed, backups }
      }
      const content = String(args.content ?? '')
      if (content.trim().length === 0) throw new Error('write/append 需要 content')
      const mode = args.action === 'append' ? 'append' : 'replace'
      const r = writeDocBoth(layout, nm, content, mode)
      return { ok: true, action: args.action, name: nm, writtenTo: r.written, backups: r.backups }
    },
  }, 'project-memory: project_doc')

  // ── 功能清单 ──
  reg({
    name: 'project_feature',
    description: '维护项目功能清单（features.md，位于项目 .dsh/docs，不依赖模型记忆，可直接读文档核对）。action=list/add/check/uncheck/remove；功能真正实现后才 check。支持 project= 指定别处项目。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'check', 'uncheck', 'remove'], description: '操作类型。remove 删除匹配条目。' },
        items: { type: 'array', items: { type: 'string' }, description: 'add 时新增的功能描述列表。' },
        item: { type: 'string', description: 'check/uncheck/remove 时要匹配的功能文本（子串，不区分大小写）。' },
        project: PROJECT_PARAM,
      },
      required: ['action'],
    },
    output: OUT,
    async execute(args, exec) {
      const layout = await layoutOf(exec, args)
      const meta = { root: layout.root, key: layout.key }
      const existing = featuresWithFallback(layout)
      if (args.action === 'list') {
        return { ok: true, file: docPath(layout.projectDir || layout.mainDir, FEATURES_DOC), total: existing.length, done: existing.filter((i) => i.done).length, pending: existing.filter((i) => !i.done).length, items: existing.map((i) => ({ done: i.done, text: i.text })) }
      }
      if (args.action === 'add') {
        const add = Array.isArray(args.items) ? args.items : (args.item ? [args.item] : [])
        if (add.length === 0) throw new Error('add 需要 items')
        for (const it of add) {
          const t = String(it).trim()
          if (t && !existing.some((e) => e.text.toLowerCase() === t.toLowerCase())) existing.push({ done: false, text: t })
        }
        writeFeaturesBoth(layout, existing)
        return { ok: true, total: existing.length, done: existing.filter((i) => i.done).length, pending: existing.filter((i) => !i.done).length }
      }
      const target = String(args.item ?? '').trim()
      if (!target) throw new Error(`${args.action} 需要 item`)
      if (args.action === 'remove') {
        const kept = existing.filter((e) => !e.text.toLowerCase().includes(target.toLowerCase()))
        const removed = existing.length - kept.length
        if (removed === 0) throw new Error(`功能清单里找不到匹配「${target}」的条目`)
        writeFeaturesBoth(layout, kept)
        return { ok: true, action: 'remove', removed, total: kept.length, done: kept.filter((i) => i.done).length, pending: kept.filter((i) => !i.done).length }
      }
      const want = args.action === 'check'
      let hit = 0
      for (const e of existing) { if (e.text.toLowerCase().includes(target.toLowerCase())) { e.done = want; hit++ } }
      if (hit === 0) throw new Error(`功能清单里找不到匹配「${target}」的条目`)
      writeFeaturesBoth(layout, existing)
      return { ok: true, action: args.action, matched: hit, total: existing.length, done: existing.filter((i) => i.done).length, pending: existing.filter((i) => !i.done).length }
    },
  }, 'project-memory: project_feature')

  // ── 按日期读取记录/日志（无需关键词）──
  reg({
    name: 'project_read',
    description: '按日期/日期区间直接读取记录或日志原文（不需要关键词），用于“看今天/昨天/某天做了什么”。kind=record|log|both；date 单日或 from/to 区间或 date+days 窗口；默认读最近若干天。支持 project= 指定别处项目。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['record', 'log', 'both'], description: '读取类型，默认 both。' },
        date: { type: 'string', description: '单日 YYYY-MM-DD。' },
        from: { type: 'string', description: '起始日期 YYYY-MM-DD。' },
        to: { type: 'string', description: '结束日期 YYYY-MM-DD。' },
        days: { type: 'integer', description: '围绕 date 的窗口天数（前后各 N），默认 0。' },
        limit: { type: 'integer', description: '最多返回的文件数，默认 10。' },
        maxCharsPerFile: { type: 'integer', description: '每个文件最多返回字符数，默认 6000。' },
        project: PROJECT_PARAM,
      },
    },
    output: OUT,
    async execute(args, exec) {
      const layout = await layoutOf(exec, args)
      const kinds = args.kind === 'record' ? ['record'] : args.kind === 'log' ? ['log'] : ['record', 'log']
      let from = isDateKey(args.from) ? args.from : undefined
      let to = isDateKey(args.to) ? args.to : undefined
      if (isDateKey(args.date)) { const d = Number.isInteger(args.days) ? Math.abs(args.days) : 0; from = dateShift(args.date, -d); to = dateShift(args.date, d) }
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 100) : 10
      const cap = Number.isInteger(args.maxCharsPerFile) && args.maxCharsPerFile > 0 ? args.maxCharsPerFile : 6000
      const files = []
      for (const kind of kinds) {
        const dir = join(layout.mainDir, kind === 'log' ? 'logs' : 'records')
        for (const { name, full } of readDocs(dir)) {
          const dm = name.match(/^(\d{4}-\d{2}-\d{2})\.md$/)
          const dateKey = dm ? dm[1] : null
          if (!dateKey) continue
          if (from && dateKey < from) continue
          if (to && dateKey > to) continue
          files.push({ kind, date: dateKey, name, full })
        }
      }
      files.sort((a, b) => b.date.localeCompare(a.date) || (a.kind < b.kind ? 1 : -1))
      const total = files.length
      const out = files.slice(0, limit).map((f) => {
        let content = ''
        try { content = readFileSync(f.full, 'utf8') } catch { /* ignore */ }
        const truncated = content.length > cap
        return { kind: f.kind, date: f.date, file: `${f.kind === 'log' ? 'logs' : 'records'}/${f.name}`, truncated, content: truncated ? content.slice(0, cap) : content }
      })
      return { ok: true, projectRoot: layout.root, window: from || to ? { from: from || null, to: to || null } : null, totalFiles: total, returned: out.length, truncated: total > limit, files: out }
    },
  }, 'project-memory: project_read')

  // ── 检索 ──
  reg({
    name: 'project_search',
    description: '在项目记忆里机械检索（关键词 + 可选日期/日期窗口），只返回命中的少数行，避免模型翻聊天记录把上下文撑爆。默认搜当前项目主存档；allProjects=true 时跨所有项目档案搜索。支持 project= 指定别处项目。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词（不区分大小写）。' },
        kind: { type: 'string', enum: ['all', 'record', 'log', 'doc'], description: '限定类型，默认 all。' },
        from: { type: 'string', description: '起始日期 YYYY-MM-DD。' },
        to: { type: 'string', description: '结束日期 YYYY-MM-DD。' },
        date: { type: 'string', description: '中心日期 YYYY-MM-DD；配合 days 形成窗口。' },
        days: { type: 'integer', description: '围绕 date 的天数窗口（前后各 N 天），默认 3。' },
        limit: { type: 'integer', description: '最多返回条数，默认配置值。' },
        allProjects: { type: 'boolean', description: 'true=在主存档里跨所有项目搜索，每条命中带 projectRoot；忽略 project/cwd。' },
        project: PROJECT_PARAM,
      },
      required: ['query'],
    },
    output: OUT,
    async execute(args, exec) {
      const query = String(args.query ?? '').trim()
      if (!query) throw new Error('query 不能为空')
      let from = isDateKey(args.from) ? args.from : undefined
      let to = isDateKey(args.to) ? args.to : undefined
      if (isDateKey(args.date)) { const d = Number.isInteger(args.days) ? Math.abs(args.days) : 3; from = dateShift(args.date, -d); to = dateShift(args.date, d) }
      const kinds = args.kind && args.kind !== 'all' ? [args.kind] : undefined
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 200) : opts.searchLimitDefault
      if (args.allProjects === true) {
        const archives = listArchives(opts)
        const all = []
        for (const a of archives) {
          const r = searchStore(join(opts.mainDir, a.key), { query, kinds, from, to, limit: 1000 })
          for (const h of r.hits) all.push({ projectRoot: a.root, projectKey: a.key, ...h })
        }
        all.sort((x, y) => String(y.date || '').localeCompare(String(x.date || '')))
        return { ok: true, query, scope: 'all-projects', window: from || to ? { from: from || null, to: to || null } : null, total: all.length, truncated: all.length > limit, hits: all.slice(0, limit) }
      }
      const layout = await layoutOf(exec, args)
      const r = searchStore(layout.mainDir, { query, kinds, from, to, limit })
      return { ok: true, query, projectRoot: layout.root, window: from || to ? { from: from || null, to: to || null } : null, store: layout.mainDir, total: r.total, truncated: r.truncated, hits: r.hits }
    },
  }, 'project-memory: project_search')

  // ── git ──
  reg({
    name: 'project_git',
    description: '项目 git 操作。action=commit（默认，git add -A 后提交，不推送除非 push=true）/ status（看工作区）/ log（最近提交）/ diff（改动统计）。支持 project= 指定别处项目的仓库。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['commit', 'status', 'log', 'diff'], description: '操作，默认 commit。' },
        message: { type: 'string', description: '提交信息（action=commit 必填）。' },
        addAll: { type: 'boolean', description: '是否 git add -A（默认 true）。与 files 互斥优先 files。' },
        files: { type: 'array', items: { type: 'string' }, description: '只提交指定文件/目录。' },
        push: { type: 'boolean', description: '提交后是否推送（默认 false）。' },
        dryRun: { type: 'boolean', description: '只查将要提交的改动，不实际提交。' },
        maxLines: { type: 'integer', description: 'action=log 时的最大提交条数，默认 20。' },
        project: PROJECT_PARAM,
      },
    },
    output: OUT,
    async execute(args, exec) {
      if (!opts.gitEnabled) throw new Error('git 操作在本插件配置中被禁用（gitEnabled=false）')
      const cwd = await targetRoot(exec, args)
      try { await runGit(cwd, ['rev-parse', '--is-inside-work-tree']) } catch { throw new Error(`目标不是 git 仓库：${cwd}`) }
      const action = ['commit', 'status', 'log', 'diff'].includes(args.action) ? args.action : 'commit'
      if (action === 'status') { const s = await runGit(cwd, ['status', '--short', '--branch']); return { ok: true, action, status: s.stdout || '(working tree clean)', cwd } }
      if (action === 'log') { const n = Number.isInteger(args.maxLines) && args.maxLines > 0 ? Math.min(args.maxLines, 200) : 20; const l = await runGit(cwd, ['log', '--oneline', '-n', String(n)]); return { ok: true, action, log: l.stdout || '(no commits)', cwd } }
      if (action === 'diff') { const d = await runGit(cwd, ['diff', '--stat']); return { ok: true, action, diff: d.stdout || '(no unstaged changes)', cwd } }
      const message = String(args.message ?? '').trim()
      if (!message) throw new Error('action=commit 需要 message')
      const r = await doGitCommit(cwd, { message, addAll: args.addAll, files: args.files, push: args.push === true, dryRun: args.dryRun === true })
      return { ...r, action, cwd }
    },
  }, 'project-memory: project_git')

  // ── 档案：列出所有项目的主存档 ──
  reg({
    name: 'project_archive',
    description: '列出主存档里所有项目的档案（顶级档案）：项目根、key、记录/日志/文档数量、项目根是否还在、项目级 .dsh 是否还在。用于删项目后仍能查到全部项目档案。',
    parameters: { type: 'object', properties: {} },
    output: OUT,
    async execute() {
      return { ok: true, mainDir: opts.mainDir, archives: listArchives(opts) }
    },
  }, 'project-memory: project_archive')

  // ── 档案：从主存档重建项目级 .dsh（自愈）──
  reg({
    name: 'project_restore',
    description: '以主存档为准重建某项目的项目级 .dsh（补齐缺失的 records/logs/docs）。主存档缺失而项目级有时反向导入。用于“项目级 .dsh 被删/缺文档”的修复。必填 project= 目标项目根。',
    parameters: { type: 'object', properties: { project: { type: 'string', description: '目标项目根目录（绝对路径，或相对当前目录）。' } }, required: ['project'] },
    output: OUT,
    async execute(args, exec) {
      if (!args.project || !String(args.project).trim()) throw new Error('project_restore 需要 project（目标项目根）')
      const layout = await layoutOf(exec, args)
      if (!layout.projectDir) throw new Error(`无法恢复：目标 ${layout.root} 无项目级目录（原因: ${layout.skipReason}）`)
      const r = syncStores(layout, { root: layout.root, key: layout.key })
      if (!r.ok) return { ok: false, reason: r.reason, mainDir: layout.mainDir, projectDir: layout.projectDir }
      return { ok: true, projectRoot: layout.root, ...r }
    },
  }, 'project-memory: project_restore')

  // ── 档案：删除某个项目的主存档（显式、破坏性）──
  reg({
    name: 'project_forget',
    description: '删除某个项目在主存档中的全部档案（records/logs/docs），破坏性且不可恢复；项目级 .dsh 不受影响。用于确实想彻底清掉某项目记忆时。必须 confirm=true 且 project= 目标项目根。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '目标项目根目录（绝对路径，或相对当前目录）。' },
        confirm: { type: 'boolean', description: '必须为 true 才会执行删除。' },
      },
      required: ['project', 'confirm'],
    },
    output: OUT,
    async execute(args, exec) {
      if (args.confirm !== true) throw new Error('project_forget 需要 confirm=true 才会执行（破坏性操作）')
      const layout = await layoutOf(exec, args)
      if (!existsSync(layout.mainDir)) return { ok: true, deleted: false, reason: '主存档不存在', mainStore: layout.mainDir }
      rmSync(layout.mainDir, { recursive: true, force: true })
      return { ok: true, deleted: true, mainStore: layout.mainDir, projectRoot: layout.root, note: '已删除主存档；项目级 .dsh 未动。' }
    },
  }, 'project-memory: project_forget')

  // ── 系统提示 ──
  const GUIDE =
    '## 项目操作记忆（.dsh）\n' +
    '本项目有一套持久记忆，工具会自动决定写入位置与日期，你只提供“记什么”，不要自己推算路径或时间：\n' +
    '- `project_write(kind=record|log, content, title?, tags?)`：完成一步重要操作后记要点（record）或过程事件（log）。\n' +
    '- `project_read(kind?, date?/from?/to?)`：按日期看做了什么，无需关键词。\n' +
    '- `project_doc`：维护项目方向/背景/规范等文档（list/read/write/append/delete）。\n' +
    '- `project_feature`：维护功能清单（list/add/check/uncheck/remove）；功能真正实现后才 `check`。\n' +
    '- `project_search(query, date?/from?/to?, kind?, allProjects?)`：查历史用检索，不要翻聊天记录；allProjects=true 跨所有项目。\n' +
    '- `project_git(action?, message?, push?)`：commit（默认）/status/log/diff；默认不推送。\n' +
    '- `project_status()` / `project_archive()` / `project_restore(project)` / `project_forget(project, confirm)`：状态、全部档案、从主存档重建、彻底删除主存档。\n' +
    '所有工具都支持 `project=` 指定别处项目（跨项目建档/记录/提交/恢复）。记录同时写入项目 `.dsh` 与主存档；主目录或 DSH 本体目录下只写主记录。\n' +
    '**做完任何一步重要改动，立刻 project_write 记要点（含决策/数字/路径），不要等用户提醒。**'

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'project-memory:guide',
    order: 60,
    // text 支持函数：每步组装提示时传入 assembly context（含 agent），据此注入当前项目记忆。
    text: (context) => {
      const digest = buildProjectDigest(context, ctx, opts)
      return digest ? GUIDE + '\n\n' + digest : GUIDE
    },
  }), 'project-memory: guide')

  ctx.logger?.info?.(`project-memory: ready (mainDir=${opts.mainDir}, backup=${opts.backupMode}/${opts.backupMaxPerFile}@${opts.backupTempDir}, autoRestore=${opts.autoRestore})`)
}
