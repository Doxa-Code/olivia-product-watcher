#!/bin/bash
# Product Watcher - Quick Install
# curl -fsSL https://watcher.doxacode.com.br/install.sh | bash

set -e

REPO_URL="https://watcher.doxacode.com.br"
INSTALL_DIR="/usr/local/bin"
WATCHER_HOME="$HOME/.watcher"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
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

# Detect platform
detect_platform() {
    local os=$(uname -s | tr '[:upper:]' '[:lower:]')
    local arch=$(uname -m)

    case "$os" in
        linux)
            echo "linux-x64"
            ;;
        darwin)
            case "$arch" in
                arm64|aarch64)
                    echo "darwin-arm64"
                    ;;
                x86_64|amd64)
                    echo "darwin-x64"
                    ;;
                *)
                    echo -e "${RED}Arquitetura não suportada: $arch${NC}" >&2
                    exit 1
                    ;;
            esac
            ;;
        *)
            echo -e "${RED}Sistema operacional não suportado: $os${NC}" >&2
            exit 1
            ;;
    esac
}

PLATFORM=$(detect_platform)
echo -e "${GREEN}✓${NC} Plataforma: $PLATFORM"

# Check permissions
if [ "$EUID" -ne 0 ]; then
    if ! sudo -n true 2>/dev/null; then
        echo -e "${YELLOW}Precisará de sudo para instalar em $INSTALL_DIR${NC}"
    fi
    SUDO="sudo"
else
    SUDO=""
fi

# Create watcher directory
mkdir -p "$WATCHER_HOME"

# Download binary
echo -e "${CYAN}Baixando watcher...${NC}"
BINARY_URL="$REPO_URL/watcher-$PLATFORM"
TMP_FILE=$(mktemp)

if ! curl -fsSL "$BINARY_URL" -o "$TMP_FILE"; then
    echo -e "${RED}Erro ao baixar de $BINARY_URL${NC}"
    rm -f "$TMP_FILE"
    exit 1
fi

# Install binary
$SUDO mv "$TMP_FILE" "$INSTALL_DIR/watcher"
$SUDO chmod +x "$INSTALL_DIR/watcher"
echo -e "${GREEN}✓${NC} Instalado em $INSTALL_DIR/watcher"

# Pull Docker image
echo -e "${CYAN}Baixando imagem Docker...${NC}"
docker pull ghcr.io/doxacode/watcher:latest 2>/dev/null || echo -e "${YELLOW}Aviso: Imagem será baixada no primeiro uso${NC}"

echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}        Instalação Completa!            ${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo ""
echo -e "${BOLD}Próximo passo:${NC}"
echo ""
echo -e "  ${CYAN}watcher add <nome-cliente>${NC}"
echo ""
echo -e "${BOLD}Comandos:${NC}"
echo ""
echo "  watcher add <nome>     Novo cliente"
echo "  watcher list           Listar clientes"
echo "  watcher logs <nome>    Ver logs"
echo "  watcher stop <nome>    Parar"
echo "  watcher remove <nome>  Remover"
echo ""
