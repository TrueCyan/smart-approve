#!/usr/bin/env node
// 백그라운드에서 실행되어 명령어의 readonly 여부를 LLM으로 판단하고 캐시에 저장
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

const command = process.argv[2];
if (!command) process.exit(1);

const CACHE_PATH = resolve(homedir(), '.claude', 'smart-approve-readonly-cache.json');
const LOG_PATH = resolve(homedir(), '.claude', 'smart-approve-debug.log');
const DEBUG = process.env.SMART_APPROVE_DEBUG !== '0';

function debug(msg) {
  if (!DEBUG) return;
  try {
    const ts = new Date().toISOString();
    appendFileSync(LOG_PATH, `[${ts}] [async-check] ${msg}\n`);
  } catch { /* ignore */ }
}

// 명령어 정규화: base command + subcommands + flags (경로/파일 인자 제외)
function normalizeCommand(cmd) {
  const parts = cmd.trim().split(/\s+/);
  const base = parts[0];
  const rest = parts.slice(1);
  const flags = rest.filter(p => p.startsWith('-')).sort();
  const subcommands = rest.filter(p => !p.startsWith('-') && !p.includes('/') && !p.includes('.'));
  return [base, ...subcommands, ...flags].join(' ').trim();
}

const prompt = `You are a command classifier. Classify the following shell command as READONLY or MODIFYING.

READONLY: Commands that only read data, display information, or query state without changing anything.
Examples:
- Version checks: --version, -V, --help, -h
- Info queries: info, status, list, show, view, describe, ls, ps
- Read operations: cat, head, tail, less, find, grep, diff, log, blame
- API queries: GET requests, SELECT queries
- Build tools: tsc, webpack, vite build, esbuild (they generate output but are safe dev operations)
- Local git: git add, git commit, git status, git log, git diff, git stash

MODIFYING: Commands that write, delete, install, or change system/network state.
Examples:
- File operations: rm, mv, cp, mkdir, touch, chmod
- Package management: install, uninstall, add, remove, upgrade
- State changes: push, deploy, restart, stop, kill, reboot
- Network mutations: POST, PUT, DELETE, PATCH requests
- Dangerous git: git push, git reset, git clean, git rebase

Command: ${command}

Respond with ONLY one word: READONLY or MODIFYING`;

try {
  debug(`Starting LLM check for: "${command}"`);

  const result = execSync(
    'claude -p --model haiku --max-turns 1 --no-session-persistence',
    {
      input: prompt,
      timeout: 30000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );

  const answer = result.trim().toUpperCase();
  const isReadonly = answer === 'READONLY' || answer.includes('READONLY');

  if (isReadonly) {
    // readonly만 캐시에 저장
    let cache = { commands: {} };
    try {
      if (existsSync(CACHE_PATH)) {
        cache = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
      }
    } catch { /* ignore */ }

    const normalized = normalizeCommand(command);
    cache.commands[normalized] = {
      type: 'readonly',
      source: 'llm',
      original: command,
      addedAt: new Date().toISOString(),
    };

    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
    debug(`Cached as readonly: "${normalized}" (original: "${command}")`);
  } else {
    debug(`LLM judged as not readonly (not cached): "${command}" → ${answer}`);
  }
} catch (err) {
  debug(`LLM error for "${command}": ${err.message}`);
}
