// 셸 따옴표/서브셸을 인식하는 명령어 분할
export function splitShellCommand(cmd) {
  const parts = [];
  let current = '';
  let i = 0;

  while (i < cmd.length) {
    const ch = cmd[i];

    // 작은따옴표 — 내부 전부 리터럴
    if (ch === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) { current += cmd.slice(i); break; }
      current += cmd.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    // 큰따옴표 — 이스케이프 처리
    if (ch === '"') {
      let j = i + 1;
      while (j < cmd.length) {
        if (cmd[j] === '\\') { j += 2; continue; }
        if (cmd[j] === '"') break;
        j++;
      }
      current += cmd.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    // 백틱
    if (ch === '`') {
      const end = cmd.indexOf('`', i + 1);
      if (end === -1) { current += cmd.slice(i); break; }
      current += cmd.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    // $(...) 서브셸
    if (ch === '$' && i + 1 < cmd.length && cmd[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      while (j < cmd.length && depth > 0) {
        if (cmd[j] === '(') depth++;
        else if (cmd[j] === ')') depth--;
        else if (cmd[j] === "'") {
          const end = cmd.indexOf("'", j + 1);
          if (end !== -1) j = end;
        } else if (cmd[j] === '"') {
          let k = j + 1;
          while (k < cmd.length) {
            if (cmd[k] === '\\') { k += 2; continue; }
            if (cmd[k] === '"') break;
            k++;
          }
          j = k;
        }
        j++;
      }
      current += cmd.slice(i, j);
      i = j;
      continue;
    }

    // 연산자: ||, &&
    if (i + 1 < cmd.length && (cmd.slice(i, i + 2) === '||' || cmd.slice(i, i + 2) === '&&')) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      i += 2;
      while (i < cmd.length && cmd[i] === ' ') i++;
      continue;
    }

    // 연산자: ;, |
    if (ch === ';' || ch === '|') {
      if (current.trim()) parts.push(current.trim());
      current = '';
      i++;
      while (i < cmd.length && cmd[i] === ' ') i++;
      continue;
    }

    current += ch;
    i++;
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

// 스크립트 실행 명령에서 파일 경로 추출
export function extractScriptPath(command) {
  const patterns = [
    // node script.js, node ./path/script.mjs
    /^node\s+(?!-e\b|--eval\b|-p\b|--print\b|-v\b|--version\b)["']?([^\s"']+\.m?[jt]sx?)["']?/,
    // python script.py, python3 script.py
    /^python3?\s+(?!-c\b|--version\b|-m\b|-V\b)["']?([^\s"']+\.py)["']?/,
    // bash script.sh, sh script.sh
    /^(?:ba)?sh\s+["']?([^\s"']+\.sh)["']?/,
    // powershell script.ps1
    /^(?:pwsh|powershell).*?(?:-File\s+)?["']?([^\s"']+\.ps1)["']?/,
    // tsx/ts-node script.ts
    /^(?:tsx|ts-node|npx\s+tsx)\s+["']?([^\s"']+\.tsx?)["']?/,
  ];

  for (const pattern of patterns) {
    const match = command.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// 언어별 쓰기 패턴 (스크립트 내용 분석용)
export const SCRIPT_WRITE_PATTERNS = {
  js: [
    /\bfs\.(writeFile|appendFile|mkdir|rmdir|unlink|rename|copyFile|cp|rm)\b/,
    /\bfs\.(createWriteStream|writeSync|appendFileSync|mkdirSync|rmdirSync|unlinkSync|renameSync)\b/,
    /\bfs\.promises\.(writeFile|appendFile|mkdir|rmdir|unlink|rename|copyFile|cp|rm)\b/,
    /\bchild_process\.(exec|spawn|execSync|spawnSync|execFile)\b/,
    /\bfetch\([^)]*method\s*:\s*['"`](POST|PUT|DELETE|PATCH)/i,
    /\bprocess\.exit\b/,
    /\brequire\s*\(\s*['"]child_process['"]\s*\)/,
  ],
  py: [
    /\bopen\s*\([^)]*['"][waxb+]+['"]/,
    /\.write\s*\(/,
    /\.writelines\s*\(/,
    /\bos\.(remove|unlink|rename|mkdir|makedirs|rmdir|removedirs|system|popen)\b/,
    /\bshutil\.(copy|copy2|move|rmtree|copytree)\b/,
    /\bsubprocess\.(run|call|Popen|check_call|check_output)\b/,
    /\bpathlib\.Path\([^)]*\)\.(write_text|write_bytes|mkdir|rmdir|unlink|rename|touch)\b/,
  ],
  sh: [
    /(?<![0-9])>{1,2}\s*(?!\/dev\/null|\$null)/,
    /\b(rm|mv|cp|mkdir|touch|chmod|chown|sed\s+-i|dd)\b/,
    /\bcurl\b.*(-X\s*(POST|PUT|DELETE|PATCH)|-d\s|--data)/,
    /\bwget\b/,
    /\bkill\b/,
  ],
};

// npm/yarn/pnpm run 명령에서 스크립트 이름 추출
export function extractNpmScript(command) {
  // npm run dev, npm run build, yarn dev, pnpm run start 등
  const match = command.match(
    /^(npm|yarn|pnpm)\s+(?:run\s+)?(\S+)/
  );
  if (!match) return null;

  const [, manager, scriptName] = match;

  // npm list, npm install 등은 npm 서브커맨드이지 스크립트가 아님
  const builtinSubcommands = new Set([
    'install', 'uninstall', 'add', 'remove', 'update', 'upgrade',
    'list', 'ls', 'info', 'view', 'outdated', 'audit', 'why',
    'init', 'publish', 'link', 'pack', 'cache', 'config',
    'login', 'logout', 'whoami', 'token', 'access',
    'help', 'version', '-v', '--version', '-h', '--help',
    'ci', 'dedupe', 'prune', 'shrinkwrap', 'doctor',
    'explore', 'fund', 'search', 'star', 'stars',
    'prefix', 'root', 'bin', 'bugs', 'docs', 'repo',
    'set-script', 'exec', 'pkg', 'explain',
    'run-script', // 이건 별도 처리
  ]);

  // "npm run xxx"이면 항상 스크립트
  if (command.match(/^(npm|yarn|pnpm)\s+run\s+/)) {
    return scriptName;
  }

  // "npm xxx"이면 빌트인 커맨드가 아닐 때만 스크립트
  if (!builtinSubcommands.has(scriptName)) {
    return scriptName;
  }

  return null;
}

// 파일 확장자 → 언어 매핑
export function getLanguage(filePath) {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map = {
    js: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
    ts: 'js', mts: 'js', cts: 'js', tsx: 'js',
    py: 'py', pyw: 'py',
    sh: 'sh', bash: 'sh', zsh: 'sh',
    ps1: 'sh', bat: 'sh', cmd: 'sh',
  };
  return map[ext] || null;
}
