# smart-approve

Smart Bash command auto-approval for Claude Code.

## Overview

Claude Code에서 Bash 명령어 실행 시 매번 수동 승인이 필요합니다. 이 플러그인은 읽기 전용 명령어와 유저가 명시적으로 요청한 명령어를 자동으로 감지하여 승인 프롬프트 없이 실행합니다.

### 자동 수락 기준

| 명령어 성격 | 유저가 요청함 | 유저가 요청 안 함 |
|------------|-------------|-----------------|
| 읽기 전용   | 자동 수락    | 자동 수락        |
| 부작용 있음  | 자동 수락    | 사용자 확인      |

### 판단 흐름

```
Bash 명령어 요청
    │
    ├─ 1단계: 규칙 기반 패턴 매칭 (즉시)
    │   ├─ readonly 확정 → 자동 수락
    │   ├─ modifying 확정 → 사용자 확인
    │   └─ 애매함 → 2단계로
    │
    ├─ 2단계: npm/yarn/pnpm scripts 분석 (즉시)
    │   └─ package.json의 scripts를 읽어 실제 명령어를 규칙 분석
    │
    ├─ 3단계: 스크립트 정적 분석 (즉시)
    │   └─ 스크립트 파일 내 쓰기 API 호출 여부 분석
    │
    └─ 4단계: claude --print 호출 (~3-5초)
        ├─ 대화 기록에서 유저 의도 파악
        ├─ 읽기 전용 또는 유저가 요청한 명령 → 자동 수락
        ├─ 유저가 요청하지 않은 부작용 명령 → 사용자 확인
        └─ 에러/타임아웃 → 사용자 확인 (안전 폴백)
```

## Installation

```bash
# Add marketplace (if not already added)
/plugin marketplace add TrueCyan/claude-plugins

# Install
/plugin install smart-approve@truecyan-plugins
```

## How It Works

### 1단계: 규칙 기반

`ls`, `git status`, `npm list` 등 명확히 읽기 전용인 명령어는 즉시 자동 수락합니다. `rm`, `mkdir`, `npm install` 등 명확히 수정하는 명령어는 기본 승인 플로우를 따릅니다.

### 2단계: npm scripts 분석

`npm run dev` 같은 명령을 만나면 `package.json`의 `scripts` 필드에서 실제 실행될 명령어를 찾아 규칙 기반으로 재분석합니다.

### 3단계: 스크립트 정적 분석

`node script.js`, `python script.py` 등 스크립트 실행 명령의 경우, 해당 파일의 내용을 읽어 쓰기 관련 API 호출이 있는지 분석합니다. import/require된 로컬 모듈도 재귀적으로 분석합니다.

**지원 언어:** JavaScript/TypeScript, Python, Shell/PowerShell

### 4단계: LLM 판단 (유저 의도 인식)

규칙과 정적 분석으로 판단이 안 되는 경우, `claude --print --model haiku`를 사용합니다. 이때 대화 기록(`transcript_path`)에서 최근 유저 메시지를 함께 전달하여, 유저가 명시적으로 요청한 명령인지 판단합니다.

- "서버 켜줘" → `npm run dev` → 유저 동의 확인 → 자동 수락
- "코드 리뷰해줘" → Claude가 자의적으로 `npm run dev` → 동의 없음 → 사용자 확인

## Safety

- 판단 불가 시 항상 **사용자 확인** (안전한 폴백)
- LLM 호출 타임아웃 15초 제한
- 기존 `permissions.allow` / `permissions.deny` 설정과 공존 (hook보다 permission이 우선)

## Requirements

- Node.js 18+ (must be in PATH)
- Claude Code CLI (`claude` command available in PATH)

## Platform Support

| Platform | Status |
|----------|--------|
| macOS    | ✅ Fully supported |
| Linux    | ✅ Fully supported |
| WSL      | ✅ Fully supported |
| Windows  | ⚠️ Limited - see below |

### Windows Limitations

Claude Code executes hook commands via `sh -c "..."` internally. On native Windows (not WSL), `sh` does not exist, so the hook fails to execute. The plugin will silently fall back to Claude Code's default permission flow.

**Workarounds:**
1. Use WSL (recommended) - Full support
2. Install Git Bash and add `sh` to PATH
3. Use Claude Code's built-in permission system instead

## License

MIT
