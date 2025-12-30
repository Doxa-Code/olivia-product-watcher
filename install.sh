#!/bin/bash
# Product Watcher - Quick Install
# curl -fsSL https://raw.githubusercontent.com/seu-user/cart-watcher/main/install.sh | bash

set -e

REPO_URL="https://watcher.doxacode.com.br"
INSTALL_DIR="/usr/local/bin"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${CYAN}${BOLD}"
echo "╔════════════════════════════════════════╗"
echo "║     Product Watcher - Installer        ║"
echo "╚════════════════════════════════════════╝"
echo -e "${NC}"

# Check Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}Erro: Docker não está instalado${NC}"
    exit 1
fi

if ! docker info &> /dev/null; then
    echo -e "${RED}Erro: Docker não está rodando${NC}"
    exit 1
fi
echo -e "${GREEN}✓${NC} Docker OK"

# Check permissions
if [ "$EUID" -ne 0 ]; then
    if ! sudo -n true 2>/dev/null; then
        echo -e "${YELLOW}Precisará de sudo para instalar em $INSTALL_DIR${NC}"
        SUDO="sudo"
    else
        SUDO="sudo"
    fi
else
    SUDO=""
fi

# Create watcher directory
WATCHER_HOME="$HOME/.watcher"
mkdir -p "$WATCHER_HOME/src"
echo -e "${GREEN}✓${NC} Diretório criado: $WATCHER_HOME"

# Download files
echo -e "${CYAN}Baixando arquivos...${NC}"
curl -fsSL "$REPO_URL/watcher-cli.sh" -o "$WATCHER_HOME/watcher-cli.sh"
curl -fsSL "$REPO_URL/watcher.ts" -o "$WATCHER_HOME/src/watcher.ts"
curl -fsSL "$REPO_URL/config-wizard.ts" -o "$WATCHER_HOME/src/config-wizard.ts"
curl -fsSL "$REPO_URL/package.json" -o "$WATCHER_HOME/src/package.json"
curl -fsSL "$REPO_URL/Dockerfile" -o "$WATCHER_HOME/src/Dockerfile"
chmod +x "$WATCHER_HOME/watcher-cli.sh"
echo -e "${GREEN}✓${NC} Arquivos baixados"

# Install dependencies
echo -e "${CYAN}Instalando dependências...${NC}"
(cd "$WATCHER_HOME/src" && bun install)
echo -e "${GREEN}✓${NC} Dependências instaladas"

# Install CLI
echo -e "${CYAN}Instalando CLI...${NC}"
$SUDO ln -sf "$WATCHER_HOME/watcher-cli.sh" "$INSTALL_DIR/watcher"
echo -e "${GREEN}✓${NC} CLI instalada"

# SCRIPT_DIR is already set to $WATCHER_DIR/src in the script

echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}        Instalação Completa!            ${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo ""
echo -e "${BOLD}Próximo passo:${NC}"
echo ""
echo -e "  ${CYAN}watcher add <nome-cliente>${NC}"
echo ""
echo -e "${BOLD}Comandos disponíveis:${NC}"
echo ""
echo "  watcher add <nome>     Configurar novo cliente"
echo "  watcher list           Listar clientes"
echo "  watcher logs <nome>    Ver logs"
echo "  watcher run <nome>     Executar sync"
echo "  watcher remove <nome>  Remover cliente"
echo ""
