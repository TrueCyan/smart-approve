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

// 명확히 읽기 전용인 CLI 명령어 패턴
export const READONLY_PATTERNS = [
  // 파일/디렉토리 조회
  /^(ls|dir|tree|find|where|which|file|stat|wc|du|df)\b/,
  /^(cat|type|head|tail|less|more|bat)\b/,
  /^(readlink|realpath|basename|dirname)\b/,

  // 디렉토리 이동
  /^cd\b/,

  // 시스템 정보 / 대기
  /^(echo|printf|pwd|whoami|hostname|uname|date|uptime|env|set|printenv|sleep)\b/,

  // 사용자/그룹 정보
  /^(id|groups|getent)\b/,

  // 셸 내장 / 테스트
  /^(source|\.)\s/,
  /^(test|true|false|\[)\b/,
  /^(command\s+-v|type\s)\b/,

  // 해시/체크섬
  /^(md5sum|sha256sum|sha1sum|shasum|cksum|b2sum)\b/,

  // 텍스트 처리 (읽기 전용)
  /^(sort|uniq|cut|tr|rev|tac|nl|column|paste|join|comm|fold|fmt|expand|unexpand)\b/,
  /^(awk|gawk)\b(?!.*\s-i)/,
  /^(jq|yq|xq)\b/,
  /^(diff|cmp)\b/,
  /^(xxd|od|hexdump|strings)\b/,

  // Git 읽기 전용
  /^git\s+(status|log|diff|show|branch|tag|remote|stash\s+list|describe|rev-parse|config\s+--get|config\s+-l|shortlog|blame|reflog)\b/,

  // Git 로컬 변경 (쉽게 되돌릴 수 있는 작업)
  /^git\s+(add|commit|stash\s+(save|push))\b/,

  // Node.js / npm 읽기 전용
  /^(npm|yarn|pnpm)\s+(list|ls|info|view|outdated|audit|why|config\s+get|config\s+list)\b/,
  /^node\s+(-e|--eval)\s+/,
  /^node\s+(-v|--version)\s*$/,
  /^npx\s+--yes\s+(which|envinfo)\b/,

  // 버전 관리 도구 조회
  /^(nvm|fnm|volta)\s+(list|ls|current|use|which|version|exec)\b/,

  // Python 읽기 전용
  /^python3?\s+(-c|--version)\b/,
  /^pip\s+(list|show|freeze|check)\b/,

  // .NET 읽기 전용
  /^dotnet\s+(--list-sdks|--list-runtimes|--info|--version|nuget\s+list)\b/,

  // TypeScript / 빌드 도구 타입 체크 (--noEmit, --dry-run 등)
  /^(tsc|npx\s+tsc|.*\/tsc)\b.*--noEmit/,
  /^(vite|npx\s+vite|webpack|esbuild|rollup)\b.*--dry-run/,

  // 빌드 도구 일반 실행 (파일 생성하지만 일반적으로 허용)
  /^(tsc|npx\s+tsc|.*\/tsc)\b/,
  /^(vite|npx\s+vite)\s+(build|preview)\b/,
  /^(webpack|npx\s+webpack)\b/,
  /^(esbuild|npx\s+esbuild)\b/,
  /^(rollup|npx\s+rollup)\b/,
  /^(parcel|npx\s+parcel)\s+build\b/,

  // sed 읽기 전용 (sed -i 제외)
  /^sed\b(?!.*\s-i)/,

  // Windows 패키지 매니저 읽기 전용
  /^winget\s+(list|show|search)\b/,

  // 검색
  /^(grep|rg|ag|findstr|select-string)\b/,

  // 네트워크 조회 (GET만)
  /^(ping|nslookup|dig|traceroute|tracert|ipconfig|ifconfig|netstat|ss)\b/,
  /^curl\s+(-s\s+)?(-S\s+)?(-L\s+)?https?:\/\//,

  // 프로세스/시스템 조회
  /^(ps|top|htop|tasklist|systeminfo|ver)\b/,

  // Docker 읽기 전용
  /^docker\s+(ps|images|logs|inspect|stats|version|info)\b/,
  /^docker\s+(volume|network|system|image|container)\s+(ls|list|inspect)\b/,
  /^docker\s+system\s+(df|info)\b/,
  /^docker\s+compose\s+(ps|logs|config|images|ls|top|events|port|version)\b/,

  // GitHub CLI 읽기 전용
  /^gh\s+(auth\s+status|pr\s+(view|list|status|checks|diff)|issue\s+(view|list|status)|repo\s+(view|list)|api\s)/,

  // Perforce 읽기 전용
  /^p4\s+(info|status|changes|filelog|print|diff|describe|clients|users|branches|labels|have|where|fstat|opened)\b/,
];

// 명확히 수정하는 CLI 명령어 패턴
export const MODIFYING_PATTERNS = [
  // 파일 조작
  /^(rm|del|rmdir|mkdir|mv|cp|move|copy|xcopy|robocopy|touch|chmod|chown|chgrp|ln)\b/,
  /^(rename|ren)\b/,

  // 리다이렉션 (파일 쓰기) — 2>/dev/null, 2>$null (stderr 억제)은 제외
  /(?<![0-9])>{1,2}\s*(?!\/dev\/null|\$null)/,

  // 패키지 설치/제거
  /^(npm|yarn|pnpm)\s+(install|uninstall|add|remove|update|upgrade|link|publish|init)\b/,
  /^pip\s+(install|uninstall)\b/,
  /^dotnet\s+(add|remove|new|publish|restore)\b/,
  /^winget\s+(install|uninstall|upgrade)\b/,

  // Git 수정
  /^git\s+(push|reset|clean|checkout\s+\.|restore\s+\.|rebase|merge|cherry-pick|revert|rm|mv)\b/,
  /^git\s+(branch\s+-[dD]|tag\s+-d|stash\s+(drop|pop|clear))\b/,

  // 위험한 네트워크 요청
  /^curl\b.*\s+(-X\s+(POST|PUT|DELETE|PATCH)|-d\s|--data|--upload-file|-F\s|--form)/,
  /^wget\s/,

  // 시스템 수정
  /^(kill|killall|pkill|shutdown|reboot|service|systemctl)\b/,
  /^(sed\s+-i|awk\s+-i)\b/,

  // Docker 수정 (개별 컨테이너)
  /^docker\s+(run|exec|build|push|pull|rm|rmi|stop|start|restart|cp)\b/,
  // Docker 리소스 수정 (volume, network, system, image)
  /^docker\s+(volume|network)\s+(rm|create|prune)\b/,
  /^docker\s+network\s+(connect|disconnect)\b/,
  /^docker\s+(system|image|container|builder)\s+prune\b/,
  // Docker compose 수정
  /^docker\s+compose\s+(up|down|build|create|start|stop|restart|rm|pull|push|run|exec)\b/,

  // Perforce 수정
  /^p4\s+(submit|revert|edit|add|delete|shelve|unshelve|resolve|sync)\b/,
];

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
