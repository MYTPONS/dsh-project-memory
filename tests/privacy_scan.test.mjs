import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scanDirectory, scanText } from '../scripts/privacy_scan.mjs'

test('accepts the public repository placeholders', () => {
  assert.deepEqual(scanText('https://github.com/MYTPONS/dsh-project-memory\nreader@example.test'), [])
})

test('rejects unapproved hosts, IPs, and memory directories', async () => {
  const badHost = ['https://', 'target', '.example', '.net'].join('')
  const publicIp = ['203', '0', '113', '10'].join('.')
  const findings = scanText(`${badHost}\n${publicIp}`)
  assert.ok(findings.some((item) => item.rule === 'unapproved-host'))
  assert.ok(findings.some((item) => item.rule === 'public-ip'))

  const root = await mkdtemp(join(tmpdir(), 'dsh-pm-scan-'))
  try {
    await mkdir(join(root, '.dsh'), { recursive: true })
    await writeFile(join(root, '.dsh', 'record.md'), 'private memory\n')
    const directoryFindings = scanDirectory(root)
    assert.ok(directoryFindings.some((item) => item.rule === 'memory-data'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
