#!/usr/bin/env bash
# Launcher for smart-approve — finds node across various environments
# stdin is passed through to smart-approve.mjs via exec

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

find_node() {
    # 1. Already in PATH
    if command -v node &>/dev/null; then
        return 0
    fi

    # 2. Source shell profiles (redirect stdin from /dev/null to prevent consumption)
    for rc in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile" "$HOME/.zshrc"; do
        if [ -f "$rc" ]; then
            . "$rc" </dev/null &>/dev/null
            if command -v node &>/dev/null; then
                return 0
            fi
        fi
    done

    # 3. fnm
    if command -v fnm &>/dev/null; then
        eval "$(fnm env)" 2>/dev/null
        if command -v node &>/dev/null; then
            return 0
        fi
    fi

    # 4. nvm
    if [ -s "$HOME/.nvm/nvm.sh" ]; then
        . "$HOME/.nvm/nvm.sh" </dev/null 2>/dev/null
        if command -v node &>/dev/null; then
            return 0
        fi
    fi

    # 5. volta
    if [ -d "$HOME/.volta/bin" ]; then
        export PATH="$HOME/.volta/bin:$PATH"
        if command -v node &>/dev/null; then
            return 0
        fi
    fi

    # 6. Common paths
    for p in /usr/local/bin/node /usr/bin/node "$HOME/.local/bin/node"; do
        if [ -x "$p" ]; then
            export PATH="$(dirname "$p"):$PATH"
            return 0
        fi
    done

    return 1
}

if find_node; then
    node "$SCRIPT_DIR/smart-approve.mjs"
    return $? 2>/dev/null || exit $?
fi

# Node not found — exit silently (fall through to default permission flow)
return 0 2>/dev/null || exit 0
