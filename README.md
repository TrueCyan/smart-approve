# smart-approve

AI-powered auto-approval for read-only Bash commands in Claude Code.

## Overview

Claude Code에서 Bash 명령어 실행 시 매번 수동 승인이 필요합니다. 이 플러그인은 읽기 전용 명령어를 자동으로 감지하여 승인 프롬프트 없이 실행합니다.

### 판단 흐름

```
Bash 명령어 요청
    │
    ├─ 1단계: 규칙 기반 패턴 매칭 (즉시)
    │   ├─ readonly 확정 → 자동 수락
    │   ├─ modifying 확정 → 사용자 확인
    │   └─ 애매함 → 2단계로
    │
    ├─ 2단계: 스크립트 정적 분석 (즉시)
    │   ├─ 스크립트 내 쓰기 패턴 없음 → 자동 수락
    │   ├─ 스크립트 내 쓰기 패턴 있음 → 사용자 확인
    │   └─ 분석 불가 → 3단계로
    │
    └─ 3단계: claude --print 호출 (~3-5초)
        ├─ "READONLY" 판단 → 자동 수락
        ├─ "MODIFYING" 판단 → 사용자 확인
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

### 2단계: 스크립트 정적 분석

`node script.js`, `python script.py` 등 스크립트 실행 명령의 경우, 해당 파일의 내용을 읽어 쓰기 관련 API 호출이 있는지 분석합니다. import/require된 로컬 모듈도 재귀적으로 분석합니다.

**지원 언어:** JavaScript/TypeScript, Python, Shell/PowerShell

### 3단계: LLM 판단

규칙과 정적 분석으로 판단이 안 되는 경우, `claude --print --model haiku`를 사용하여 AI가 명령어의 부작용을 예측합니다. 별도 API 키 없이 현재 세션의 인증을 그대로 사용합니다.

## Safety

- 판단 불가 시 항상 **사용자 확인** (안전한 폴백)
- LLM 호출 타임아웃 15초 제한
- 기존 `permissions.allow` / `permissions.deny` 설정과 공존 (hook보다 permission이 우선)

## Requirements

- Node.js 18+
- Claude Code CLI (`claude` command available in PATH)

## License

MIT
