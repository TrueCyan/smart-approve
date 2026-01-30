import { readFileSync, existsSync, appendFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, isAbsolute, dirname } from 'path';
import { homedir } from 'os';
import {
  READONLY_PATTERNS,
  MODIFYING_PATTERNS,
  SCRIPT_WRITE_PATTERNS,
  extractScriptPath,
  extractNpmScript,
  getLanguage,
} from './patterns.mjs';

// --- 디버그 로깅 (항상 켜짐, SMART_APPROVE_DEBUG=0 으로 끌 수 있음) ---
const DEBUG = process.env.SMART_APPROVE_DEBUG !== '0';
const LOG_PATH = resolve(homedir(), '.claude', 'smart-approve-debug.log');

function debug(msg) {
  if (!DEBUG) return;
  try {
    const ts = new Date().toISOString();
    appendFileSync(LOG_PATH, `[${ts}] ${msg}\n`);
  } catch { /* ignore */ }
}

// --- 승인 캐시 ---
const CACHE_PATH = resolve(homedir(), '.claude', 'smart-approve-cache.json');

function loadCache() {
  try {
    if (!existsSync(CACHE_PATH)) return {};
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  try {
    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch { /* ignore */ }
}

function getCacheKey(cmd) {
  // 경로 부분을 정규화하여 같은 의미의 명령이 매칭되도록
  // cd "path" && npm run dev → npm run dev@path
  const cdMatch = cmd.match(/^cd\s+["']?([^"'&;|]+?)["']?\s*(?:&&|;|\|\|)\s*(.+)/);
  if (cdMatch) {
    return `${cdMatch[2].trim()}@${cdMatch[1].trim()}`;
  }
  return cmd;
}

function checkCache(sessionId, cmd) {
  const cache = loadCache();
  const key = getCacheKey(cmd);
  const entry = cache[key];
  if (!entry) return null;

  // 같은 세션이면 캐시 히트
  if (entry.sessionId === sessionId) {
    return entry.decision;
  }

  // 다른 세션이라도 24시간 이내면 캐시 히트
  const age = Date.now() - entry.timestamp;
  if (age < 24 * 60 * 60 * 1000) {
    return entry.decision;
  }

  return null;
}

function updateCache(sessionId, cmd, decision) {
  const cache = loadCache();
  const key = getCacheKey(cmd);
  cache[key] = { sessionId, decision, timestamp: Date.now() };

  // 오래된 항목 정리 (7일 이상)
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [k, v] of Object.entries(cache)) {
    if (v.timestamp < cutoff) delete cache[k];
  }

  saveCache(cache);
}

// --- stdin 읽기 ---
let input;
try {
  const raw = readFileSync(0, 'utf8');
  input = JSON.parse(raw);
} catch {
  process.exit(0); // 파싱 실패 → 기본 플로우
}

const toolName = input.tool_name;
const command = input.tool_input?.command?.trim();

if (toolName !== 'Bash' || !command) {
  process.exit(0);
}

debug(`Command: ${command}`);

// --- 1단계: 규칙 기반 판단 ---
const ruleResult = analyzeByRules(command);
debug(`Step 1 (rules): ${ruleResult}`);

if (ruleResult === 'readonly') {
  outputAllow('Rule-based: read-only command');
  process.exit(0);
}

// modifying이면 캐시/LLM 유저 의도 확인으로 넘김 (유저가 요청했을 수 있음)
// readonly도 ambiguous도 아닌 경우 → 2~3단계 스킵하고 4단계(캐시/LLM)로 직행
if (ruleResult === 'modifying') {
  debug('Step 1: modifying detected, checking user intent...');
  // 캐시 확인
  const cached = checkCache(input.session_id, command);
  debug(`Step 1→cache: ${cached ?? 'miss'}`);
  if (cached === 'approve') {
    outputAllow('Cached: previously approved command');
    process.exit(0);
  }
  // LLM 유저 의도 확인
  const userContext = getRecentUserMessages(input.transcript_path);
  debug(`Step 1→LLM: userContext="${userContext?.slice(0, 100)}..."`);
  const llmResult = askClaude(command, null, input.cwd, userContext);
  debug(`Step 1→LLM result: ${llmResult}`);
  if (llmResult === 'approve') {
    updateCache(input.session_id, command, 'approve');
    outputAllow('LLM: user-consented modifying command');
    process.exit(0);
  }
  // LLM도 approve 안 함 → 기본 플로우 (사용자 확인)
  process.exit(0);
}

// --- 2단계: npm/yarn/pnpm scripts 분석 ---
// compound 명령(cd ... && npm run dev)에서 각 서브커맨드를 확인
const subCommands = command.split(/\s*&&\s*|\s*\|\|\s*|\s*;\s*/).map(s => s.trim()).filter(Boolean);
let npmScript = null;
for (const sub of subCommands) {
  npmScript = extractNpmScript(sub);
  if (npmScript) break;
}
if (npmScript) {
  const effectiveCwd = resolveCdTarget(command, input.cwd) || input.cwd;
  debug(`Step 2 (npm): script="${npmScript}", cwd="${effectiveCwd}"`);
  const npmResult = analyzeNpmScript(npmScript, effectiveCwd);
  if (npmResult === 'readonly') {
    updateCache(input.session_id, command, 'approve');
    outputAllow(`npm script analysis: "${npmScript}" resolved to read-only command`);
    process.exit(0);
  }
  if (npmResult === 'modifying') {
    process.exit(0);
  }
  // ambiguous → 3단계로 계속
}

// --- 3단계: 스크립트 파일 내용 정적 분석 ---
const scriptPath = extractScriptPath(command);
if (scriptPath) {
  const staticResult = analyzeScriptContent(scriptPath, input.cwd);
  if (staticResult === 'readonly') {
    outputAllow('Static analysis: no write operations found in script');
    process.exit(0);
  }
  if (staticResult === 'modifying') {
    process.exit(0);
  }
}

// --- 4단계: 승인 캐시 확인 ---
const cached = checkCache(input.session_id, command);
debug(`Step 4 (cache): ${cached ?? 'miss'}`);
if (cached === 'approve') {
  outputAllow('Cached: previously approved command');
  process.exit(0);
}

// --- 5단계: Claude에게 판단 위임 (애매한 경우만) ---
const userContext = getRecentUserMessages(input.transcript_path);
debug(`Step 5 (LLM): transcript="${input.transcript_path}", userContext="${userContext?.slice(0, 100)}..."`);
const llmResult = askClaude(command, scriptPath, input.cwd, userContext);
debug(`Step 5 result: ${llmResult}`);
if (llmResult === 'approve') {
  updateCache(input.session_id, command, 'approve');
  outputAllow('LLM analysis: approved (read-only or user-consented)');
  process.exit(0);
}

// modifying이거나 판단 불가 → 기본 플로우
process.exit(0);

// ============================================================
// 함수 정의
// ============================================================

function resolveCdTarget(cmd, fallbackCwd) {
  // cd "path" && ... 에서 path를 추출
  const match = cmd.match(/^cd\s+["']?([^"'&;|]+?)["']?\s*(?:&&|;|\|\|)/);
  if (match) {
    const target = match[1].trim();
    if (isAbsolute(target)) return target;
    if (fallbackCwd) return resolve(fallbackCwd, target);
  }
  return null;
}

function analyzeNpmScript(scriptName, cwd) {
  // package.json을 찾아서 scripts 필드에서 실제 명령어를 읽어온다
  const pkgPath = findPackageJson(cwd);
  if (!pkgPath) return 'ambiguous';

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    return 'ambiguous';
  }

  const actualCommand = pkg.scripts?.[scriptName];
  if (!actualCommand) return 'ambiguous';

  // 실제 명령어를 규칙 기반으로 분석
  return analyzeByRules(actualCommand);
}

function findPackageJson(startDir) {
  if (!startDir) return null;
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(dir, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function analyzeByRules(cmd) {
  // 파이프/체인 명령은 개별 명령 모두 확인
  const subCommands = cmd.split(/\s*[|&;]\s*/).map(s => s.trim()).filter(Boolean);

  let hasModifying = false;
  for (const sub of subCommands) {
    if (MODIFYING_PATTERNS.some(p => p.test(sub))) {
      hasModifying = true;
      break;
    }
  }
  if (hasModifying) return 'modifying';

  // 모든 서브커맨드가 readonly여야 readonly
  const allReadonly = subCommands.every(sub =>
    READONLY_PATTERNS.some(p => p.test(sub))
  );
  if (allReadonly) return 'readonly';

  return 'ambiguous';
}

function analyzeScriptContent(scriptFile, cwd) {
  const fullPath = resolveScriptPath(scriptFile, cwd);
  if (!fullPath || !existsSync(fullPath)) return 'ambiguous';

  const lang = getLanguage(fullPath);
  if (!lang) return 'ambiguous';

  let content;
  try {
    content = readFileSync(fullPath, 'utf8');
  } catch {
    return 'ambiguous';
  }

  // 로컬 import도 재귀적으로 수집
  const allContent = collectLocalImports(fullPath, content, lang);

  const patterns = SCRIPT_WRITE_PATTERNS[lang];
  if (!patterns) return 'ambiguous';

  const hasWriteOp = patterns.some(p => p.test(allContent));
  return hasWriteOp ? 'modifying' : 'readonly';
}

function collectLocalImports(filePath, content, lang, visited = new Set()) {
  if (visited.has(filePath)) return '';
  visited.add(filePath);

  let allContent = content;

  if (lang === 'js') {
    const importPatterns = [
      /require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
      /import\s+.*?from\s+['"](\.[^'"]+)['"]/g,
      /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    ];

    const dir = filePath.replace(/[/\\][^/\\]+$/, '');
    for (const pattern of importPatterns) {
      for (const match of content.matchAll(pattern)) {
        const importPath = match[1];
        const resolved = resolveImport(dir, importPath);
        if (resolved && existsSync(resolved)) {
          try {
            const sub = readFileSync(resolved, 'utf8');
            allContent += '\n' + collectLocalImports(resolved, sub, lang, visited);
          } catch { /* skip */ }
        }
      }
    }
  }

  if (lang === 'py') {
    const fromImport = /from\s+(\.[^\s]+)\s+import/g;
    const dir = filePath.replace(/[/\\][^/\\]+$/, '');
    for (const match of content.matchAll(fromImport)) {
      const modulePath = match[1].replace(/\./g, '/').replace(/^\//, '') + '.py';
      const resolved = resolve(dir, modulePath);
      if (existsSync(resolved)) {
        try {
          const sub = readFileSync(resolved, 'utf8');
          allContent += '\n' + collectLocalImports(resolved, sub, lang, visited);
        } catch { /* skip */ }
      }
    }
  }

  return allContent;
}

function resolveScriptPath(scriptFile, cwd) {
  if (isAbsolute(scriptFile)) return scriptFile;
  if (cwd) return resolve(cwd, scriptFile);
  return resolve(scriptFile);
}

function resolveImport(dir, importPath) {
  const candidates = [
    resolve(dir, importPath),
    resolve(dir, importPath + '.js'),
    resolve(dir, importPath + '.mjs'),
    resolve(dir, importPath + '.ts'),
    resolve(dir, importPath, 'index.js'),
    resolve(dir, importPath, 'index.mjs'),
    resolve(dir, importPath, 'index.ts'),
  ];
  return candidates.find(c => existsSync(c)) || null;
}

function getRecentUserMessages(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return '';

  try {
    const content = readFileSync(transcriptPath, 'utf8');
    // JSONL: 파일 끝에서 최근 메시지를 추출
    const lines = content.trim().split('\n');

    // 최근 20줄만 확인 (성능)
    const recentLines = lines.slice(-20);
    const userMessages = [];

    for (const line of recentLines) {
      try {
        const entry = JSON.parse(line);
        // transcript 형식: entry.type === 'user', 텍스트는 entry.message.content
        if (entry.type !== 'user') continue;

        const content = entry.message?.content ?? entry.content;
        let text = '';

        if (typeof content === 'string') {
          // XML 태그로 시작하면 시스템/커맨드 메시지이므로 스킵
          if (content.startsWith('<')) continue;
          text = content;
        } else if (Array.isArray(content)) {
          // [{type: 'text', text: '...'}, ...] 형식
          text = content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .filter(t => !t.startsWith('<'))
            .join(' ');
        }

        if (text.trim()) {
          userMessages.push(text.trim());
        }
      } catch { /* skip malformed lines */ }
    }

    // 최근 3개 유저 메시지만 반환
    return userMessages.slice(-3).join('\n');
  } catch {
    return '';
  }
}

function askClaude(cmd, scriptFile, cwd, userContext) {
  let prompt = `You are a bash command classifier for a permission system. Determine if a command should be auto-approved.

## Classification Rules

A command is APPROVE if ANY of the following is true:
1. It is purely read-only (reads data, displays output, searches, prints info)
2. The user EXPLICITLY requested this exact action in their recent messages

A command is DENY (requires manual confirmation) if ALL of the following are true:
1. It has side effects (writes files, installs packages, starts processes, modifies system state, makes network requests)
2. The user did NOT explicitly request this action

## Key Principle
- "Side effects" includes: starting servers/processes, writing files, installing packages, deploying, network mutations
- Starting a dev server IS a side effect — but if the user said "start the server", they already consented
- Claude autonomously deciding to run a modifying command without the user asking → DENY
- Claude running exactly what the user asked for → APPROVE

## Examples
- Command: "ls -la" → APPROVE (read-only)
- Command: "git status" → APPROVE (read-only)
- Command: "npm run dev", user said: "서버 켜줘" → APPROVE (user consented)
- Command: "npm run dev", user said: "코드 리뷰해줘" → DENY (user didn't ask to start server)
- Command: "npm install express", user said: "express 설치해줘" → APPROVE (user consented)
- Command: "npm install lodash", user said: "코드 최적화해줘" → DENY (user didn't ask to install)
- Command: "rm -rf node_modules", user said: "node_modules 지워줘" → APPROVE (user consented)
- Command: "rm -rf dist" (no user request) → DENY

Command: ${cmd}`;

  if (userContext) {
    prompt += `\n\nRecent user messages:\n"""${userContext}"""`;
  } else {
    prompt += `\n\nRecent user messages: (none available)`;
  }

  // 스크립트 파일이 있으면 내용도 첨부
  if (scriptFile) {
    const fullPath = resolveScriptPath(scriptFile, cwd);
    if (fullPath && existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, 'utf8');
        if (content.length <= 5000) {
          prompt += `\n\nScript file content (${scriptFile}):\n\`\`\`\n${content}\n\`\`\``;
        } else {
          prompt += `\n\nScript file content (${scriptFile}, truncated to 5000 chars):\n\`\`\`\n${content.slice(0, 5000)}\n\`\`\``;
        }
      } catch { /* skip */ }
    }
  }

  prompt += `\n\nRespond with ONLY one word: "APPROVE" or "DENY".`;

  try {
    // stdin으로 프롬프트 전달 (이스케이핑 문제 방지)
    const result = execSync(
      `claude -p --model haiku --max-turns 1 --no-session-persistence`,
      {
        input: prompt,
        timeout: 15000,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    const answer = result.trim().toUpperCase();
    if (answer === 'APPROVE' || answer.includes('APPROVE')) return 'approve';
    if (answer === 'DENY' || answer.includes('DENY')) return 'deny';
    return 'ambiguous';
  } catch (err) {
    debug(`LLM error: ${err.message}`);
    return 'ambiguous';
  }
}

function outputAllow(reason) {
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: reason,
    },
  };
  console.log(JSON.stringify(output));
}
