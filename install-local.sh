#!/bin/bash
# Product Watcher - Local Install (para testes)
# ./install-local.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WATCHER_HOME="$HOME/.watcher"
INSTALL_DIR="/usr/local/bin"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${CYAN}${BOLD}"
echo "╔════════════════════════════════════════╗"
echo "║   Product Watcher - Local Install      ║"
echo "╚════════════════════════════════════════╝"
echo -e "${NC}"

# Check Docker
if ! docker info &> /dev/null; then
    echo -e "${RED}Erro: Docker não está rodando${NC}"
    exit 1
fi
echo -e "${GREEN}✓${NC} Docker OK"

# Create directories
mkdir -p "$WATCHER_HOME/src"
echo -e "${GREEN}✓${NC} Diretório: $WATCHER_HOME"

# Copy files
cp "$SCRIPT_DIR/watcher-cli.sh" "$WATCHER_HOME/watcher-cli.sh"
cp "$SCRIPT_DIR/watcher.ts" "$WATCHER_HOME/src/watcher.ts"
cp "$SCRIPT_DIR/config-wizard.ts" "$WATCHER_HOME/src/config-wizard.ts"
cp "$SCRIPT_DIR/package.json" "$WATCHER_HOME/src/package.json"
cp "$SCRIPT_DIR/Dockerfile" "$WATCHER_HOME/src/Dockerfile"
[ -f "$SCRIPT_DIR/bun.lockb" ] && cp "$SCRIPT_DIR/bun.lockb" "$WATCHER_HOME/src/bun.lockb"
chmod +x "$WATCHER_HOME/watcher-cli.sh"
echo -e "${GREEN}✓${NC} Arquivos copiados"

# Install dependencies
echo -e "${CYAN}▶${NC} Instalando dependências..."
(cd "$WATCHER_HOME/src" && bun install --frozen-lockfile 2>/dev/null || bun install)
echo -e "${GREEN}✓${NC} Dependências instaladas"

# SCRIPT_DIR is already set to $WATCHER_DIR/src in the script

# Install CLI
sudo ln -sf "$WATCHER_HOME/watcher-cli.sh" "$INSTALL_DIR/watcher"
echo -e "${GREEN}✓${NC} CLI instalada"

echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}        Instalação Completa!            ${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo ""
echo -e "Agora execute: ${CYAN}watcher add <nome-cliente>${NC}"
echo ""
