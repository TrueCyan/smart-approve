import { readFileSync, existsSync, appendFileSync, writeFileSync, unlinkSync } from 'fs';
import { execSync, spawnSync, spawn } from 'child_process';
import { resolve, isAbsolute, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import {
  SCRIPT_WRITE_PATTERNS,
  extractScriptPath,
  extractNpmScript,
  getLanguage,
  splitShellCommand,
} from './patterns.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

// --- LLM 호출 락 (동시 호출 방지) ---
const LOCK_PATH = resolve(homedir(), '.claude', 'smart-approve-llm.lock');
const LOCK_STALE_MS = 30000;   // 30초 이상 된 락은 stale
const LOCK_WAIT_MS = 1000;     // 대기 간격 1초
const LOCK_MAX_WAIT_MS = 10000; // 최대 대기 10초

function acquireLock() {
  const maxAttempts = Math.floor(LOCK_MAX_WAIT_MS / LOCK_WAIT_MS);
  for (let i = 0; i < maxAttempts; i++) {
    try {
      if (existsSync(LOCK_PATH)) {
        const content = readFileSync(LOCK_PATH, 'utf8').trim();
        const lockTime = parseInt(content, 10);
        if (!isNaN(lockTime) && Date.now() - lockTime < LOCK_STALE_MS) {
          // 아직 유효한 락 → 대기 (sleep via spawnSync)
          spawnSync('node', ['-e', `setTimeout(()=>{},${LOCK_WAIT_MS})`], { stdio: 'ignore', timeout: LOCK_WAIT_MS + 2000 });
          continue;
        }
        // stale 락 → 덮어쓰기
      }
      writeFileSync(LOCK_PATH, String(Date.now()));
      return true;
    } catch {
      // 파일 접근 실패 → 락 없이 진행
      return false;
    }
  }
  // 타임아웃 → 락 없이 진행
  debug('Lock acquisition timed out, proceeding without lock');
  return false;
}

function releaseLock() {
  try {
    if (existsSync(LOCK_PATH)) {
      unlinkSync(LOCK_PATH);
    }
  } catch { /* ignore */ }
}

// --- 읽기전용 캐시 (동적 학습) ---
const READONLY_CACHE_PATH = resolve(homedir(), '.claude', 'smart-approve-readonly-cache.json');

function loadReadonlyCache() {
  try {
    if (!existsSync(READONLY_CACHE_PATH)) return { commands: {} };
    return JSON.parse(readFileSync(READONLY_CACHE_PATH, 'utf8'));
  } catch { return { commands: {} }; }
}

function saveReadonlyCache(cache) {
  try {
    writeFileSync(READONLY_CACHE_PATH, JSON.stringify(cache, null, 2));
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

// 비동기 LLM readonly 판단 (detached child process)
function spawnAsyncLlmCheck(command) {
  const script = resolve(__dirname, 'async-readonly-check.mjs');
  try {
    const child = spawn('node', [script, command], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, SMART_APPROVE_DEBUG: DEBUG ? '1' : '0' },
    });
    child.unref();
    debug(`[async] Spawned LLM check for: "${command}"`);
  } catch (err) {
    debug(`[async] Failed to spawn LLM check: ${err.message}`);
  }
}

// 합성 명령어를 분해하여 캐시 기반으로 분류
// 반환: { result: 'readonly' | 'unknown', unknownParts: string[] }
function classifyCommand(command) {
  const cache = loadReadonlyCache();

  // 합성 명령어 분해
  const parts = splitShellCommand(command);
  const unknownParts = [];

  for (const part of parts) {
    const normalized = normalizeCommand(part);
    const cached = cache.commands[normalized];

    if (cached?.type === 'readonly') {
      // readonly 캐시 히트 → OK
      debug(`[classify] readonly (cached): "${normalized}"`);
    } else {
      // 캐시에 없음 → unknown
      debug(`[classify] unknown: "${normalized}"`);
      unknownParts.push(part);
    }
  }

  if (unknownParts.length === 0) {
    debug(`[classify] 모두 readonly: "${command}"`);
    return { result: 'readonly', unknownParts: [] };
  }

  debug(`[classify] unknown 포함 (${unknownParts.length}개): ${unknownParts.join(', ')}`);
  return { result: 'unknown', unknownParts };
}

// 사용자가 "항상 허용"을 입력했는지 확인
const ALWAYS_ALLOW_KEYWORDS = [
  /항상\s*허용/, /always\s*allow/i,
];

// 훅 자신의 deny 메시지인지 확인 (self-approval 방지)
const DENY_MESSAGE_PATTERNS = [
  /확인되지 않은 명령어/,
  /시스템을 변경할 수 있는/,
  /항상 허용.*답하세요/,
  /사용자에게 설명하고/,
];

function isDenyMessage(text) {
  return DENY_MESSAGE_PATTERNS.some(p => p.test(text));
}

function checkAlwaysAllow(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return false;

  try {
    const content = readFileSync(transcriptPath, 'utf8');
    const lines = content.trim().split('\n');
    const recentLines = lines.slice(-5);

    for (let i = recentLines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(recentLines[i]);
        if (entry.type !== 'user') continue;

        const msgContent = entry.message?.content ?? entry.content;
        let text = '';
        if (typeof msgContent === 'string') {
          if (msgContent.startsWith('<')) continue;
          text = msgContent;
        } else if (Array.isArray(msgContent)) {
          for (const block of msgContent) {
            if (block.type === 'text' && block.text && !block.text.startsWith('<')) {
              text += ' ' + block.text;
            }
            if (block.type === 'tool_result' && typeof block.content === 'string') {
              if (!isDenyMessage(block.content)) text += ' ' + block.content;
            }
          }
        }

        text = text.trim();
        if (!text) continue;
        if (ALWAYS_ALLOW_KEYWORDS.some(kw => kw.test(text))) return true;
      } catch { /* skip */ }
    }
    return false;
  } catch { return false; }
}

// --- 배치 승인 ---
const BATCH_PATH = resolve(homedir(), '.claude', 'smart-approve-batch.json');
const BATCH_TTL_MS = 10 * 60 * 1000; // 10분

const APPROVAL_KEYWORDS = [
  // 한국어
  /진행/, /승인/, /실행/, /계속/, /해줘/, /ㅇㅇ/, /^응$/, /^네$/, /^그래$/, /좋아/, /^ㅇㅋ$/, /^오케이$/,
  // 영어
  /proceed/i, /approve/i, /go\s*ahead/i, /^yes$/i, /continue/i, /^ok$/i, /^sure$/i, /^yep$/i,
];

function loadBatch() {
  try {
    if (!existsSync(BATCH_PATH)) return null;
    const batch = JSON.parse(readFileSync(BATCH_PATH, 'utf8'));
    // TTL 초과 시 무시
    if (Date.now() - batch.timestamp > BATCH_TTL_MS) {
      debug('Batch expired, ignoring');
      return null;
    }
    return batch;
  } catch {
    return null;
  }
}

function saveBatch(batch) {
  try {
    writeFileSync(BATCH_PATH, JSON.stringify(batch, null, 2));
  } catch { /* ignore */ }
}

function clearBatch() {
  try {
    if (existsSync(BATCH_PATH)) unlinkSync(BATCH_PATH);
  } catch { /* ignore */ }
}

function extractPlannedCommands(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];

  try {
    const content = readFileSync(transcriptPath, 'utf8');
    const lines = content.trim().split('\n');

    // 마지막 assistant 메시지를 찾음
    let lastAssistant = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'assistant') {
          lastAssistant = entry;
          break;
        }
      } catch { /* skip */ }
    }

    if (!lastAssistant) return [];

    const messageContent = lastAssistant.message?.content ?? lastAssistant.content;
    if (!Array.isArray(messageContent)) return [];

    // type === "tool_use" && name === "Bash" 블록에서 command 추출
    const commands = [];
    for (const block of messageContent) {
      if (block.type === 'tool_use' && block.name === 'Bash' && block.input?.command) {
        commands.push(block.input.command.trim());
      }
    }

    return commands;
  } catch {
    return [];
  }
}

function checkUserApproval(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return false;

  try {
    const content = readFileSync(transcriptPath, 'utf8');
    const lines = content.trim().split('\n');

    // 최근 10줄에서 user 메시지 확인
    const recentLines = lines.slice(-10);
    for (let i = recentLines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(recentLines[i]);
        if (entry.type !== 'user') continue;

        const msgContent = entry.message?.content ?? entry.content;
        let text = '';

        if (typeof msgContent === 'string') {
          if (msgContent.startsWith('<')) continue;
          text = msgContent;
        } else if (Array.isArray(msgContent)) {
          // tool_result 블록도 확인 (AskUserQuestion 응답)
          for (const block of msgContent) {
            if (block.type === 'text' && block.text && !block.text.startsWith('<')) {
              text += ' ' + block.text;
            }
            if (block.type === 'tool_result' && typeof block.content === 'string') {
              // hook deny 메시지 제외, AskUserQuestion 응답만 포함
              if (!isDenyMessage(block.content)) text += ' ' + block.content;
            }
          }
        }

        text = text.trim();
        if (!text) continue;

        // 승인 키워드 매칭
        if (APPROVAL_KEYWORDS.some(kw => kw.test(text))) {
          return true;
        }
      } catch { /* skip */ }
    }
    return false;
  } catch {
    return false;
  }
}

function outputDeny(reason) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
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

// --- 0단계: "항상 허용" 응답 확인 ---
// 사용자가 직전 deny에 대해 "항상 허용"으로 응답했는지 확인
const alwaysAllowBatch = loadBatch();
if (alwaysAllowBatch && alwaysAllowBatch.sessionId === input.session_id && alwaysAllowBatch.status === 'pending') {
  if (checkAlwaysAllow(input.transcript_path)) {
    debug('Step 0: "항상 허용" detected, adding commands to readonly cache');
    const cache = loadReadonlyCache();
    for (const cmd of alwaysAllowBatch.commands) {
      const normalized = normalizeCommand(cmd);
      cache.commands[normalized] = {
        type: 'readonly',
        source: 'user',
        original: cmd,
        addedAt: new Date().toISOString(),
      };
    }
    saveReadonlyCache(cache);
    clearBatch();
    // 현재 명령이 방금 허용된 배치에 포함되면 바로 allow
    if (alwaysAllowBatch.commands.includes(command)) {
      outputAllow('User always-allow: command added to readonly cache');
      process.exit(0);
    }
  }
}

// --- 1단계: 배치 승인 확인 (기존 approved 배치) ---
const batch = loadBatch();
if (batch && batch.sessionId === input.session_id) {
  if (batch.status === 'approved') {
    if (batch.commands.includes(command)) {
      debug('Step 1: batch approved');
      outputAllow('Batch: previously approved command');
      process.exit(0);
    }
  }
  if (batch.status === 'pending') {
    if (checkUserApproval(input.transcript_path)) {
      debug('Step 1: user approval detected for pending batch');
      batch.status = 'approved';
      saveBatch(batch);
      if (batch.commands.includes(command)) {
        updateCache(input.session_id, command, 'approve');
        outputAllow('Batch: user approved');
        process.exit(0);
      }
    }
    // pending 배치에 포함된 명령 → 다시 deny
    if (batch.commands.includes(command)) {
      debug('Step 1: command in pending batch, re-denying');
      outputDeny(batch.summary);
      process.exit(0);
    }
  }
}

// --- 2단계: 승인 캐시 확인 (기존 approve 캐시) ---
const approvalCached = checkCache(input.session_id, command);
debug(`Step 2 (approval cache): ${approvalCached ?? 'miss'}`);
if (approvalCached === 'approve') {
  outputAllow('Cached: previously approved command');
  process.exit(0);
}

// --- 3단계: readonly 캐시 기반 분류 (합성 명령어 분해) ---
const { result: classifyResult, unknownParts } = classifyCommand(command);
debug(`Step 3 (classify): ${classifyResult}`);

if (classifyResult === 'readonly') {
  outputAllow('Readonly cache: all sub-commands are cached readonly');
  process.exit(0);
}

// --- 4단계: npm scripts / 스크립트 정적 분석 (기존 로직 유지) ---
const subCommands = splitShellCommand(command);
let npmScript = null;
for (const sub of subCommands) {
  npmScript = extractNpmScript(sub);
  if (npmScript) break;
}
if (npmScript) {
  const effectiveCwd = resolveCdTarget(command, input.cwd) || input.cwd;
  debug(`Step 4a (npm): script="${npmScript}", cwd="${effectiveCwd}"`);
  const npmResult = analyzeNpmScript(npmScript, effectiveCwd);
  if (npmResult === 'readonly') {
    updateCache(input.session_id, command, 'approve');
    outputAllow(`npm script analysis: "${npmScript}" resolved to read-only command`);
    process.exit(0);
  }
}

const scriptPath = extractScriptPath(command);
if (scriptPath) {
  const staticResult = analyzeScriptContent(scriptPath, input.cwd);
  if (staticResult === 'readonly') {
    outputAllow('Static analysis: no write operations found in script');
    process.exit(0);
  }
}

// --- 5단계: LLM 유저 의도 확인 ---
const userContext = getRecentUserMessages(input.transcript_path);
debug(`Step 5 (LLM): userContext="${userContext?.slice(0, 100)}..."`);
const llmResult = askClaude(command, scriptPath || null, input.cwd, userContext);
debug(`Step 5 result: ${llmResult}`);
if (llmResult === 'approve') {
  updateCache(input.session_id, command, 'approve');
  outputAllow('LLM: approved (user-consented)');
  process.exit(0);
}

// --- 6단계: deny + 비동기 LLM readonly 판단 spawn ---
// unknown 구성요소에 대해 백그라운드 LLM 판단 실행
for (const part of unknownParts) {
  spawnAsyncLlmCheck(part);
}

// 배치 승인 플로우
handleBatchApproval(command, input);
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

  // 실제 명령어를 캐시 기반으로 분류
  const { result } = classifyCommand(actualCommand);
  return result === 'readonly' ? 'readonly' : 'ambiguous';
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

    // 최근 30줄만 확인 (성능)
    const recentLines = lines.slice(-30);
    const conversation = [];

    for (const line of recentLines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'user' && entry.type !== 'assistant') continue;

        const msgContent = entry.message?.content ?? entry.content;
        let text = '';

        if (typeof msgContent === 'string') {
          // XML 태그로 시작하면 시스템/커맨드 메시지이므로 스킵
          if (msgContent.startsWith('<')) continue;
          text = msgContent;
        } else if (Array.isArray(msgContent)) {
          // [{type: 'text', text: '...'}, ...] 형식에서 텍스트만 추출
          text = msgContent
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .filter(t => !t.startsWith('<'))
            .join(' ');
        }

        if (text.trim()) {
          const role = entry.type === 'user' ? 'User' : 'Assistant';
          conversation.push(`${role}: ${text.trim()}`);
        }
      } catch { /* skip malformed lines */ }
    }

    // 최근 6개 메시지(user+assistant)만 반환하여 대화 맥락 유지
    return conversation.slice(-6).join('\n');
  } catch {
    return '';
  }
}

function askClaude(cmd, scriptFile, cwd, userContext) {
  let prompt = `You are a bash command classifier for a permission system. Determine if a command should be auto-approved.

## Classification Rules

A command is APPROVE if ANY of the following is true:
1. It is purely read-only (reads data, displays output, searches, prints info, queries databases with SELECT)
2. The user EXPLICITLY requested this exact action in their recent messages

A command is DENY (requires manual confirmation) if ALL of the following are true:
1. It has side effects (writes files, installs packages, starts processes, modifies system state, makes network requests that mutate data)
2. The user did NOT explicitly request this action

## Key Principles
- "Side effects" includes: starting servers/processes, writing files, installing packages, deploying, network mutations (POST/PUT/DELETE)
- Starting a dev server IS a side effect — but if the user said "start the server", they already consented
- Claude autonomously deciding to run a modifying command without the user asking → DENY
- Claude running exactly what the user asked for → APPROVE
- **Compound commands**: If ALL parts of a compound command (&&, ||, ;, |) are read-only, the whole command is read-only
- **Inline scripts**: \`python3 -c "..."\`, \`node -e "..."\`, \`sh -c "..."\` — judge by what the script actually does, not just the wrapper
- **docker exec/docker compose exec**: Look at what runs INSIDE the container. If it only reads (ls, cat, SELECT queries, console.log), it's read-only
- **Redirections**: \`2>/dev/null\`, \`2>&1\` are stderr suppression, NOT file writes
- **Database operations**: SELECT/find/query = read-only. INSERT/UPDATE/DELETE/DROP = modifying

## User Intent Recognition
- "User:" messages are the source of truth for user consent
- "Assistant:" messages show Claude's plans and interpretations, treat them as context only
- Look for explicit approval in User messages (e.g., "해줘", "진행", "yes", "커밋해", "푸시해")
- When Assistant says "user asked for X", confirm with an actual User message requesting X
- When recent messages contain ONLY "Assistant:" lines with no "User:" consent, DENY modifying commands

## Examples
- Command: "ls -la" → APPROVE (read-only)
- Command: "git status" → APPROVE (read-only)
- Command: "cat file.json | python3 -c 'import json,sys; print(json.load(sys.stdin))'" → APPROVE (read-only: cat pipes to python which only prints)
- Command: "docker compose exec backend sh -c 'ls -la; echo done'" → APPROVE (read-only commands inside container)
- Command: "docker exec backend node -e 'db.query(\"SELECT * FROM users\")'" → APPROVE (read-only DB query)
- Command: "docker exec backend node script.js" where script does console.log(db.all()) → APPROVE (read-only)
- Command: "readlink -f $(which node)" → APPROVE (read-only)
- Command: "gh auth status 2>&1" → APPROVE (read-only)
- Command: "npm run dev", user said: "서버 켜줘" → APPROVE (user consented)
- Command: "npm run dev", user said: "코드 리뷰해줘" → DENY (user didn't ask to start server)
- Command: "npm install express", user said: "express 설치해줘" → APPROVE (user consented)
- Command: "npm install lodash", user said: "코드 최적화해줘" → DENY (user didn't ask to install)
- Command: "rm -rf node_modules", user said: "node_modules 지워줘" → APPROVE (user consented)
- Command: "rm -rf dist" (no user request) → DENY
- Command: "docker compose up -d" (no user request) → DENY
- Command: "docker cp file.js container:/tmp/" (no user request) → DENY (copies file to container)

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

  acquireLock();
  try {
    // stdin으로 프롬프트 전달 (이스케이핑 문제 방지)
    const result = execSync(
      `claude -p --model sonnet --max-turns 1 --no-session-persistence`,
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
    if (err.stderr) {
      debug(`LLM stderr: ${err.stderr.toString().slice(0, 500)}`);
    }
    if (err.stdout) {
      debug(`LLM stdout: ${err.stdout.toString().slice(0, 500)}`);
    }
    return 'ambiguous';
  } finally {
    releaseLock();
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

function handleBatchApproval(command, input) {
  const batch = loadBatch();

  // 1. 기존 approved 배치가 있으면 이 명령이 포함되었는지 확인
  if (batch && batch.sessionId === input.session_id) {
    if (batch.status === 'approved') {
      if (batch.commands.includes(command)) {
        debug('Batch: command found in approved batch');
        outputAllow('Batch: approved command in batch');
        return;
      }
      debug('Batch: command NOT in approved batch, falling through');
      return;
    }

    if (batch.status === 'pending') {
      // 사용자 승인 여부 확인
      if (checkUserApproval(input.transcript_path)) {
        debug('Batch: user approval detected, approving batch');
        batch.status = 'approved';
        saveBatch(batch);
        if (batch.commands.includes(command)) {
          outputAllow('Batch: user approved batch');
          return;
        }
      }
      // pending 배치가 있지만 현재 명령이 포함되지 않음 → 새 배치로 교체
      if (!batch.commands.includes(command)) {
        debug('Batch: command not in pending batch, creating new batch');
        clearBatch();
        // 아래 "새로운 배치 생성" 로직으로 진행
      } else {
        // 현재 명령이 배치에 있지만 아직 승인 안 됨 → 다시 deny
        debug('Batch: command in pending batch, re-denying');
        outputDeny(batch.summary);
        return;
      }
    }
  }

  // 2. 새로운 배치 생성
  const plannedCommands = extractPlannedCommands(input.transcript_path);
  debug(`Batch: extracted ${plannedCommands.length} planned commands`);

  // readonly 캐시에 없는 명령어만 필터링 (승인 필요)
  const readonlyCache = loadReadonlyCache();
  let modifyingCommands = plannedCommands.filter(cmd => {
    const parts = splitShellCommand(cmd);
    // 모든 구성요소가 readonly 캐시에 있으면 제외
    return !parts.every(part => {
      const normalized = normalizeCommand(part);
      return readonlyCache.commands[normalized]?.type === 'readonly';
    });
  });

  // 계획된 명령이 없거나 필터링 결과가 비어있으면 현재 명령만으로 배치 생성
  if (modifyingCommands.length === 0) {
    modifyingCommands = [command];
  }

  // 요약 메시지 생성
  const summary = '확인되지 않은 명령어입니다. 사용자 승인이 필요합니다:\n' +
    modifyingCommands.map((cmd, i) => `${i + 1}. ${cmd}`).join('\n') +
    '\n\n💡 이 명령어가 읽기 전용(안전한 명령어)이라면, "항상 허용"이라고 답하세요.\n   다음부터는 자동으로 승인됩니다.';

  // 배치 저장
  const newBatch = {
    sessionId: input.session_id,
    commands: modifyingCommands,
    status: 'pending',
    summary,
    timestamp: Date.now(),
  };
  saveBatch(newBatch);

  debug(`Batch: created pending batch with ${modifyingCommands.length} commands`);
  outputDeny(summary);
}
