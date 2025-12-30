#!/bin/bash
# Product Watcher - Uninstall
# curl -fsSL https://raw.githubusercontent.com/seu-user/cart-watcher/main/uninstall.sh | bash

WATCHER_HOME="$HOME/.watcher"
INSTALL_DIR="/usr/local/bin"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${CYAN}${BOLD}"
echo "╔════════════════════════════════════════╗"
echo "║    Product Watcher - Uninstall         ║"
echo "╚════════════════════════════════════════╝"
echo -e "${NC}"

# List clients
if [ -d "$WATCHER_HOME" ]; then
    clients=$(ls -1 "$WATCHER_HOME" 2>/dev/null | grep -v "^src$" | grep -v "watcher-cli.sh")
    if [ -n "$clients" ]; then
        echo -e "${YELLOW}Clientes que serão removidos:${NC}"
        echo "$clients" | while read -r name; do
            [ -d "$WATCHER_HOME/$name" ] && echo -e "  ${RED}●${NC} $name"
        done
        echo ""
    fi
fi

echo -e "${YELLOW}${BOLD}Isso vai remover o watcher e todos os clientes.${NC}"
read -p "Tem certeza? (s/N): " confirm </dev/tty

if [[ ! "$confirm" =~ ^[Ss]$ ]]; then
    echo "Cancelado."
    exit 0
fi

# Stop all containers
echo -e "${CYAN}Parando containers...${NC}"
for dir in "$WATCHER_HOME"/*/; do
    [ -d "$dir" ] || continue
    [ -f "$dir/docker-compose.yml" ] || continue
    name=$(basename "$dir")
    echo "  Parando watcher-$name..."
    (cd "$dir" && docker compose down -v 2>/dev/null) || true
done

# Remove CLI
echo -e "${CYAN}Removendo CLI...${NC}"
sudo rm -f "$INSTALL_DIR/watcher"

# Remove files
echo -e "${CYAN}Removendo arquivos...${NC}"
rm -rf "$WATCHER_HOME"

echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}       Desinstalação Completa!          ${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo ""
