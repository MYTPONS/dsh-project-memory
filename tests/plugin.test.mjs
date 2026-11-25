import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'

const execFileAsync = promisify(execFile)

async function tempDir(name) {
  return await mkdtemp(join(tmpdir(), `dsh-project-memory-${name}-`))
}

async function listFiles(root) {
  const out = []
  async function walk(dir) {
    let entries = []
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out.push(full)
    }
  }
  await walk(root)
  return out
}

function createHarness(cwd, mainDir, backupTempDir, extra = {}) {
  const tools = new Map()
  const sections = []
  const ctx = {
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => {}
      },
    },
    effect(fn) { return fn() },
    workingDirectory: {
      defaultDirectory: cwd,
      ensure: async () => cwd,
      get: () => cwd,
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    logger: { info() {} },
  }
  apply(ctx, {
    mainDir,
    backupTempDir,
    autoRestore: false,
    detectRoot: false,
    ...extra,
  })
  return { tools, sections, ctx }
}

async function withHarness(name, fn) {
  const project = await tempDir(`${name}-project`)
  const mainDir = await tempDir(`${name}-main`)
  const backup = await tempDir(`${name}-backup`)
  const h = createHarness(project, mainDir, backup)
  try {
    await fn({ project, mainDir, backup, ...h })
  } finally {
    await rm(project, { recursive: true, force: true })
    await rm(mainDir, { recursive: true, force: true })
    await rm(backup, { recursive: true, force: true })
  }
}

test('registers the ten project-memory tools and guide section', async () => {
  await withHarness('register', async ({ tools, sections }) => {
    assert.deepEqual([...tools.keys()], [
      'project_status',
      'project_write',
      'project_doc',
      'project_feature',
      'project_read',
      'project_search',
      'project_git',
      'project_archive',
      'project_restore',
      'project_forget',
    ])
    assert.equal(sections.length, 1)
    assert.equal(sections[0].order, 60)
    assert.match(sections[0].text({}), /项目操作记忆/)
  })
})

test('writes records and logs to project and main stores', async () => {
  await withHarness('write', async ({ project, tools }) => {
    const written = await tools.get('project_write').execute({
      kind: 'record',
      title: 'Checkpoint',
      content: 'Decision: keep the local cache.',
      tags: ['decision'],
    })
    assert.equal(written.ok, true)
    assert.equal(written.writtenTo.length, 2)
    for (const file of written.writtenTo) {
      assert.match(await readFile(file, 'utf8'), /Decision: keep the local cache/)
    }
    await tools.get('project_write').execute({ kind: 'log', content: 'cache warmed', tags: ['ops'] })
    const read = await tools.get('project_read').execute({ limit: 10 })
    assert.equal(read.ok, true)
    assert.equal(read.returned, 2)
    assert.match(read.files.find((f) => f.kind === 'log').content, /cache warmed/)
    const status = await tools.get('project_status').execute({})
    assert.equal(status.projectRoot, project)
    assert.equal(status.counts.recordFiles, 1)
    assert.equal(status.counts.logFiles, 1)
  })
})

test('document writes are mirrored, readable with fallback, and backed up on replace/delete', async () => {
  await withHarness('docs', async ({ project, backup, tools }) => {
    await tools.get('project_doc').execute({ action: 'write', name: 'context', content: 'first version' })
    const listed = await tools.get('project_doc').execute({ action: 'list' })
    assert.deepEqual(listed.docs, ['context.md'])

    const replaced = await tools.get('project_doc').execute({ action: 'write', name: 'context', content: 'second version' })
    assert.equal(replaced.ok, true)
    assert.equal(replaced.backups.length, 2)
    for (const file of replaced.writtenTo) assert.equal(await readFile(file, 'utf8'), 'second version\n')

    const projectDoc = join(project, '.dsh', 'docs', 'context.md')
    await rm(projectDoc)
    const fallback = await tools.get('project_doc').execute({ action: 'read', name: 'context' })
    assert.equal(fallback.source, 'main')
    assert.equal(fallback.content, 'second version\n')

    const deleted = await tools.get('project_doc').execute({ action: 'delete', name: 'context' })
    assert.equal(deleted.ok, true)
    assert.equal(deleted.backups.length, 1)
    const backups = (await listFiles(backup)).filter((file) => file.includes('context.md.'))
    assert.ok(backups.length >= 2)
  })
})

test('feature changes update the checklist and create backups', async () => {
  await withHarness('features', async ({ backup, tools }) => {
    const added = await tools.get('project_feature').execute({ action: 'add', items: ['Login flow', 'Export data'] })
    assert.equal(added.total, 2)
    const checked = await tools.get('project_feature').execute({ action: 'check', item: 'login' })
    assert.equal(checked.done, 1)
    const listed = await tools.get('project_feature').execute({ action: 'list' })
    assert.equal(listed.total, 2)
    assert.equal(listed.done, 1)
    const backups = (await listFiles(backup)).filter((file) => file.includes('features.md.'))
    assert.ok(backups.length >= 2)
  })
})

test('search supports keyword and all-project scope', async () => {
  await withHarness('search', async ({ project, tools }) => {
    const other = await tempDir('search-other')
    try {
      await mkdir(other, { recursive: true })
      await tools.get('project_write').execute({ kind: 'record', content: 'alpha contract decision' })
      await tools.get('project_write').execute({ kind: 'log', content: 'beta cache event' })
      const local = await tools.get('project_search').execute({ query: 'contract' })
      assert.equal(local.total, 1)
      assert.equal(local.projectRoot, project)

      await tools.get('project_write').execute({ project: other, kind: 'record', content: 'gamma project marker' })
      const global = await tools.get('project_search').execute({ query: 'marker', allProjects: true })
      assert.equal(global.total, 1)
      assert.equal(global.hits[0].projectRoot, other)
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })
})

test('restore from main does not overwrite newer project documents, but fills missing files', async () => {
  await withHarness('restore-fill', async ({ project, tools }) => {
    const status = await tools.get('project_status').execute({})
    const mainDocs = join(status.mainStore, 'docs')
    const projectDocs = join(project, '.dsh', 'docs')
    await mkdir(mainDocs, { recursive: true })
    await mkdir(projectDocs, { recursive: true })
    await writeFile(join(mainDocs, 'main-only.md'), 'main only\n')
    await writeFile(join(mainDocs, 'shared.md'), 'main version\n')
    await writeFile(join(projectDocs, 'shared.md'), 'project newer\n')

    const restored = await tools.get('project_restore').execute({ project })
    assert.equal(restored.ok, true)
    assert.equal(restored.direction, 'main->project(fill)')
    assert.equal(await readFile(join(projectDocs, 'shared.md'), 'utf8'), 'project newer\n')
    assert.equal(await readFile(join(projectDocs, 'main-only.md'), 'utf8'), 'main only\n')
  })
})

test('restore rebuilds a deleted project .dsh from the authoritative main archive', async () => {
  await withHarness('restore-delete', async ({ project, tools }) => {
    await tools.get('project_write').execute({ kind: 'record', content: 'recoverable record' })
    await rm(join(project, '.dsh'), { recursive: true, force: true })
    const restored = await tools.get('project_restore').execute({ project })
    assert.equal(restored.ok, true)
    assert.equal(restored.direction, 'main->project')
    const files = await listFiles(join(project, '.dsh'))
    assert.ok(files.some((file) => file.endsWith('.md')))
  })
})

test('archive lists projects and forget removes only the main archive', async () => {
  await withHarness('archive', async ({ project, tools }) => {
    await tools.get('project_write').execute({ kind: 'record', content: 'archive me' })
    const archived = await tools.get('project_archive').execute({})
    assert.equal(archived.ok, true)
    assert.equal(archived.archives.length, 1)

    await assert.rejects(() => tools.get('project_forget').execute({ project, confirm: false }), /confirm=true/)
    const forgotten = await tools.get('project_forget').execute({ project, confirm: true })
    assert.equal(forgotten.deleted, true)
    const after = await tools.get('project_archive').execute({})
    assert.equal(after.archives.length, 0)
    assert.ok((await stat(project)).isDirectory())
  })
})

test('git status, log, diff and commit work in a temporary repository', async () => {
  const project = await tempDir('git-project')
  const mainDir = await tempDir('git-main')
  const backup = await tempDir('git-backup')
  const h = createHarness(project, mainDir, backup)
  const oldEnv = {
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
  }
  try {
    await execFileAsync('git', ['init'], { cwd: project })
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: project })
    await execFileAsync('git', ['config', 'user.email', 'test@example.test'], { cwd: project })
    await writeFile(join(project, 'file.txt'), 'one\n')
    await execFileAsync('git', ['add', 'file.txt'], { cwd: project })
    await execFileAsync('git', ['-c', 'user.name=Test User', '-c', 'user.email=test@example.test', 'commit', '-m', 'initial'], { cwd: project })
    await writeFile(join(project, 'file.txt'), 'one changed\n')
    process.env.GIT_AUTHOR_NAME = 'Test User'
    process.env.GIT_AUTHOR_EMAIL = 'test@example.test'
    process.env.GIT_COMMITTER_NAME = 'Test User'
    process.env.GIT_COMMITTER_EMAIL = 'test@example.test'

    const status = await h.tools.get('project_git').execute({ action: 'status', project })
    assert.match(status.status, /file\.txt/)
    const diff = await h.tools.get('project_git').execute({ action: 'diff', project })
    assert.match(diff.diff, /file\.txt/)
    const commit = await h.tools.get('project_git').execute({ action: 'commit', project, message: 'test commit' })
    assert.equal(commit.committed, true)
    const log = await h.tools.get('project_git').execute({ action: 'log', project })
    assert.match(log.log, /test commit/)
  } finally {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(project, { recursive: true, force: true })
    await rm(mainDir, { recursive: true, force: true })
    await rm(backup, { recursive: true, force: true })
  }
})
