import { readFileSync, existsSync, appendFileSync, writeFileSync, unlinkSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import { resolve, isAbsolute, dirname } from 'path';
import { homedir } from 'os';
import {
  READONLY_PATTERNS,
  MODIFYING_PATTERNS,
  SCRIPT_WRITE_PATTERNS,
  extractScriptPath,
  extractNpmScript,
  getLanguage,
  splitShellCommand,
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

    // 최근 5줄에서 user 메시지 확인
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
          text = msgContent
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .filter(t => !t.startsWith('<'))
            .join(' ');
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

  // 배치 승인 확인 (이미 approved 배치가 있으면 바로 allow)
  const batch = loadBatch();
  if (batch && batch.sessionId === input.session_id && batch.status === 'approved') {
    if (batch.commands.includes(command)) {
      debug('Step 1→batch: approved (batch contains this command)');
      outputAllow('Batch: previously batch-approved command');
      process.exit(0);
    }
  }

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
  // LLM도 approve 안 함 → 배치 승인 플로우
  handleBatchApproval(command, input);
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

// modifying이거나 판단 불가 → 배치 승인 플로우 시도
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

function unwrapPowershell(cmd) {
  // powershell -Command "..." 패턴에서 내부 명령을 추출
  const match = cmd.match(/^(?:powershell|pwsh)(?:\.exe)?\s+(?:-\w+\s+)*-Command\s+["'](.+?)["']\s*$/i);
  if (match) {
    return match[1];
  }
  return cmd;
}

function analyzeByRules(cmd) {
  // powershell -Command "..." 래핑 해제
  cmd = unwrapPowershell(cmd);

  // 따옴표/서브셸을 인식하는 분할 (따옴표 안의 ;|는 분할하지 않음)
  const subCommands = splitShellCommand(cmd);

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
1. It is purely read-only (reads data, displays output, searches, prints info)
2. The user EXPLICITLY requested this exact action in their recent messages

A command is DENY (requires manual confirmation) if ALL of the following are true:
1. It has side effects (writes files, installs packages, starts processes, modifies system state, makes network requests)
2. The user did NOT explicitly request this action

## Key Principles
- "Side effects" includes: starting servers/processes, writing files, installing packages, deploying, network mutations
- Starting a dev server IS a side effect — but if the user said "start the server", they already consented
- Claude autonomously deciding to run a modifying command without the user asking → DENY
- Claude running exactly what the user asked for → APPROVE
- **Compound commands**: If ALL parts of a compound command (&&, ||, ;, |) are read-only, the whole command is read-only
- **Inline scripts**: \`python3 -c "..."\`, \`node -e "..."\`, \`sh -c "..."\` — judge by what the script actually does, not just the wrapper
- **docker compose exec/docker exec running read-only commands** (ls, cat, echo, env, which, etc.) inside a container is effectively read-only
- **Redirections**: \`2>/dev/null\`, \`2>&1\` are stderr suppression, NOT file writes

## Examples
- Command: "ls -la" → APPROVE (read-only)
- Command: "git status" → APPROVE (read-only)
- Command: "cat file.json | python3 -c 'import json,sys; print(json.load(sys.stdin))'" → APPROVE (read-only: cat pipes to python which only prints)
- Command: "docker compose exec backend sh -c 'ls -la; echo done'" → APPROVE (read-only commands inside container)
- Command: "readlink -f $(which node)" → APPROVE (read-only)
- Command: "gh auth status 2>&1" → APPROVE (read-only)
- Command: "npm run dev", user said: "서버 켜줘" → APPROVE (user consented)
- Command: "npm run dev", user said: "코드 리뷰해줘" → DENY (user didn't ask to start server)
- Command: "npm install express", user said: "express 설치해줘" → APPROVE (user consented)
- Command: "npm install lodash", user said: "코드 최적화해줘" → DENY (user didn't ask to install)
- Command: "rm -rf node_modules", user said: "node_modules 지워줘" → APPROVE (user consented)
- Command: "rm -rf dist" (no user request) → DENY
- Command: "docker compose up -d" (no user request) → DENY

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

  // modifying 명령어만 필터링
  let modifyingCommands = plannedCommands.filter(cmd => {
    const result = analyzeByRules(cmd);
    return result === 'modifying' || result === 'ambiguous';
  });

  // 계획된 명령이 없거나 필터링 결과가 비어있으면 현재 명령만으로 배치 생성
  if (modifyingCommands.length === 0) {
    modifyingCommands = [command];
  }

  // 요약 메시지 생성 (에이전트가 보고 사용자에게 권한 요청하도록 지시)
  const summary = '다음 명령어는 시스템을 변경할 수 있는 작업입니다. 사용자에게 설명하고 승인을 받으세요:\n' +
    modifyingCommands.map((cmd, i) => `${i + 1}. ${cmd}`).join('\n');

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
