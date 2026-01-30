// 명확히 읽기 전용인 CLI 명령어 패턴
export const READONLY_PATTERNS = [
  // 파일/디렉토리 조회
  /^(ls|dir|tree|find|where|which|file|stat|wc|du|df)\b/,
  /^(cat|type|head|tail|less|more|bat)\b/,

  // 시스템 정보
  /^(echo|printf|pwd|whoami|hostname|uname|date|uptime|env|set|printenv)\b/,

  // Git 읽기 전용
  /^git\s+(status|log|diff|show|branch|tag|remote|stash\s+list|describe|rev-parse|config\s+--get|config\s+-l|shortlog|blame|reflog)\b/,

  // Node.js / npm 읽기 전용
  /^(npm|yarn|pnpm)\s+(list|ls|info|view|outdated|audit|why|config\s+get|config\s+list)\b/,
  /^node\s+(-e|--eval)\s+/,
  /^npx\s+--yes\s+(which|envinfo)\b/,

  // Python 읽기 전용
  /^python3?\s+(-c|--version)\b/,
  /^pip\s+(list|show|freeze|check)\b/,

  // .NET 읽기 전용
  /^dotnet\s+(--list-sdks|--list-runtimes|--info|--version|nuget\s+list)\b/,

  // 검색
  /^(grep|rg|ag|findstr|select-string)\b/,

  // 네트워크 조회 (GET만)
  /^(ping|nslookup|dig|traceroute|tracert|ipconfig|ifconfig|netstat|ss)\b/,
  /^curl\s+(-s\s+)?(-S\s+)?(-L\s+)?https?:\/\//,

  // 프로세스/시스템 조회
  /^(ps|top|htop|tasklist|systeminfo|ver)\b/,

  // Docker 읽기 전용
  /^docker\s+(ps|images|logs|inspect|stats|version|info)\b/,

  // Perforce 읽기 전용
  /^p4\s+(info|status|changes|filelog|print|diff|describe|clients|users|branches|labels|have|where|fstat|opened)\b/,
];

// 명확히 수정하는 CLI 명령어 패턴
export const MODIFYING_PATTERNS = [
  // 파일 조작
  /^(rm|del|rmdir|mkdir|mv|cp|move|copy|xcopy|robocopy|touch|chmod|chown|chgrp|ln)\b/,
  /^(rename|ren)\b/,

  // 리다이렉션 (파일 쓰기)
  /\s*>{1,2}\s*/,

  // 패키지 설치/제거
  /^(npm|yarn|pnpm)\s+(install|uninstall|add|remove|update|upgrade|link|publish|init)\b/,
  /^pip\s+(install|uninstall)\b/,
  /^dotnet\s+(add|remove|new|publish|restore)\b/,

  // Git 수정
  /^git\s+(push|reset|clean|checkout\s+\.|restore\s+\.|rebase|merge|cherry-pick|revert|rm|mv)\b/,
  /^git\s+(branch\s+-[dD]|tag\s+-d|stash\s+(drop|pop|clear))\b/,

  // 위험한 네트워크 요청
  /^curl\b.*\s+(-X\s+(POST|PUT|DELETE|PATCH)|-d\s|--data|--upload-file|-F\s|--form)/,
  /^wget\s/,

  // 시스템 수정
  /^(kill|killall|pkill|shutdown|reboot|service|systemctl)\b/,
  /^(sed\s+-i|awk\s+-i)\b/,

  // Docker 수정
  /^docker\s+(run|exec|build|push|pull|rm|rmi|stop|start|restart|compose)\b/,

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
    /\s*>{1,2}\s*/,
    /\b(rm|mv|cp|mkdir|touch|chmod|chown|sed\s+-i|dd)\b/,
    /\bcurl\b.*(-X\s*(POST|PUT|DELETE|PATCH)|-d\s|--data)/,
    /\bwget\b/,
    /\bkill\b/,
  ],
};

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
