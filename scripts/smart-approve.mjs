import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, isAbsolute } from 'path';
import {
  READONLY_PATTERNS,
  MODIFYING_PATTERNS,
  SCRIPT_WRITE_PATTERNS,
  extractScriptPath,
  getLanguage,
} from './patterns.mjs';

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

// --- 1단계: 규칙 기반 판단 ---
const ruleResult = analyzeByRules(command);

if (ruleResult === 'readonly') {
  outputAllow('Rule-based: read-only command');
  process.exit(0);
}

if (ruleResult === 'modifying') {
  // 기본 플로우 (사용자에게 물어봄)
  process.exit(0);
}

// --- 2단계: 스크립트 내용 정적 분석 ---
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

// --- 3단계: Claude에게 판단 위임 (애매한 경우만) ---
const llmResult = askClaude(command, scriptPath, input.cwd);
if (llmResult === 'readonly') {
  outputAllow('LLM analysis: predicted read-only');
  process.exit(0);
}

// modifying이거나 판단 불가 → 기본 플로우
process.exit(0);

// ============================================================
// 함수 정의
// ============================================================

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

function askClaude(cmd, scriptFile, cwd) {
  let prompt = `Analyze this bash command and determine if it modifies the filesystem, system state, or makes destructive network requests.

Command: ${cmd}`;

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

  prompt += `\n\nRespond with ONLY one word: "READONLY" or "MODIFYING".`;

  try {
    const escaped = prompt.replace(/"/g, '\\"').replace(/`/g, '\\`');
    const result = execSync(
      `claude -p --model haiku --max-turns 1 --no-session-persistence "${escaped}"`,
      {
        timeout: 15000,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    const answer = result.trim().toUpperCase();
    if (answer === 'READONLY' || answer.includes('READONLY')) return 'readonly';
    if (answer === 'MODIFYING' || answer.includes('MODIFYING')) return 'modifying';
    return 'ambiguous';
  } catch {
    // 타임아웃, CLI 없음, 에러 → 안전하게 기본 플로우
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
