#!/usr/bin/env node
// Fail if the public repository contains likely secrets, local paths, or memory data.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const TEXT_EXTENSIONS = new Set([
  '.md', '.js', '.mjs', '.cjs', '.json', '.yml', '.yaml',
  '.svg', '.txt', '.sh', '.toml',
])
const SKIP_DIRS = new Set(['.git', 'node_modules', '.dsh', 'out', 'coverage', 'pnpm-store'])
const ALLOWED_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'www.w3.org',
  'app.example.test',
  'example.test',
  'example.com',
  'www.example.com',
])
const ALLOWED_EMAIL_DOMAINS = new Set(['example.test', 'example.com', 'example.org'])
const LOOPBACK = new Set(['127.0.0.1', '0.0.0.0', '255.255.255.255'])
const PUBLIC_IP = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
const SECRET_PATTERNS = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['bearer-literal', /\bBearer\s+(?!<redacted>)[A-Za-z0-9._~+/-]{20,}/g],
  ['literal-secret', /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"'<>]{12,}["']/gi],
]

function lineNumber(text, index) {
  return text.slice(0, index).split('\n').length
}

export function scanText(text, relativeFile = '<memory>') {
  const findings = []
  const add = (rule, index, message) => findings.push({ file: relativeFile, line: lineNumber(text, index), rule, message })

  for (const [rule, pattern] of SECRET_PATTERNS) {
    for (const match of text.matchAll(pattern)) add(rule, match.index || 0, 'possible secret material')
  }

  for (const match of text.matchAll(PUBLIC_IP)) {
    if (!LOOPBACK.has(match[0])) add('public-ip', match.index || 0, `IP literal: ${match[0]}`)
  }

  for (const match of text.matchAll(/https?:\/\/[^\s"'`<>)]*/g)) {
    if (match[0].includes('${')) continue
    try {
      const host = new URL(match[0]).hostname.toLowerCase()
      if (!ALLOWED_HOSTS.has(host)) add('unapproved-host', match.index || 0, `URL host is not a placeholder: ${host}`)
    } catch {
      // Ignore non-URL fragments.
    }
  }

  for (const match of text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
    const domain = match[0].split('@')[1].toLowerCase()
    if (!ALLOWED_EMAIL_DOMAINS.has(domain)) add('unapproved-email', match.index || 0, `email domain is not a placeholder: ${domain}`)
  }

  const homePath = text.indexOf('/home/')
  if (homePath >= 0) add('absolute-home-path', homePath, 'absolute home path may identify an operator')

  return findings
}

function walk(rootDir) {
  const files = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) || entry.name === '.gitignore' || entry.name === '.editorconfig') {
        files.push(full)
      }
    }
  }
  visit(rootDir)
  return files
}

export function scanDirectory(rootDir = '.') {
  const root = path.resolve(rootDir)
  const findings = []
  if (fs.existsSync(path.join(root, '.dsh'))) {
    findings.push({ file: '.dsh', line: 1, rule: 'memory-data', message: 'project memory directory must not be published' })
  }
  for (const file of walk(root)) {
    const relative = path.relative(root, file)
    if (relative === path.join('scripts', 'privacy_scan.mjs')) continue
    findings.push(...scanText(fs.readFileSync(file, 'utf8'), relative))
  }
  return findings
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (invokedAsScript) {
  const findings = scanDirectory(process.argv[2] || '.')
  if (findings.length === 0) {
    console.log('privacy-scan: clean')
  } else {
    for (const finding of findings) {
      console.error(`${finding.file}:${finding.line}: ${finding.rule}: ${finding.message}`)
    }
    process.exit(1)
  }
}
