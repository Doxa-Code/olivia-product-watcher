#!/bin/bash
# Product Watcher - CLI
# Usage: watcher <command> [options]

set -e

WATCHER_DIR="${WATCHER_DIR:-$HOME/.watcher}"
# SCRIPT_DIR points to the source files (watcher.ts, config-wizard.ts, etc.)
SCRIPT_DIR="$WATCHER_DIR/src"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# Ensure watcher directory exists
mkdir -p "$WATCHER_DIR"

show_help() {
    echo ""
    echo -e "${BOLD}Product Watcher${NC}"
    echo ""
    echo -e "${BOLD}Uso:${NC} watcher <comando> [opções]"
    echo ""
    echo -e "${BOLD}Comandos:${NC}"
    echo "  add <nome>           Configurar e iniciar novo cliente"
    echo "  list                 Listar todos os clientes"
    echo "  logs <nome>          Ver logs do cliente"
    echo "  run <nome> [modo]    Executar sync (full|quick)"
    echo "  stop <nome>          Parar cliente"
    echo "  start <nome>         Iniciar cliente"
    echo "  remove <nome>        Remover cliente"
    echo "  config <nome>        Reconfigurar cliente"
    echo ""
    echo -e "${BOLD}Exemplos:${NC}"
    echo "  watcher add farmacia-centro"
    echo "  watcher logs farmacia-centro"
    echo "  watcher run farmacia-centro quick"
    echo ""
}

get_client_dir() {
    echo "$WATCHER_DIR/$1"
}

# List all clients with status
cmd_list() {
    echo ""
    echo -e "${BOLD}Clientes${NC}"
    echo -e "${DIM}─────────────────────────────────────${NC}"

    if [ ! -d "$WATCHER_DIR" ] || [ -z "$(ls -A "$WATCHER_DIR" 2>/dev/null)" ]; then
        echo -e "  ${DIM}Nenhum cliente configurado.${NC}"
        echo ""
        return
    fi

    printf "  ${BOLD}%-25s %-12s${NC}\n" "NOME" "STATUS"
    echo -e "  ${DIM}───────────────────────── ────────────${NC}"

    for dir in "$WATCHER_DIR"/*/; do
        [ -d "$dir" ] || continue
        name=$(basename "$dir")

        # Skip src directory and files
        [ "$name" = "src" ] && continue

        # Only show directories with config.env (real clients)
        [ -f "$dir/config.env" ] || continue

        if docker ps -q -f "name=watcher-$name" 2>/dev/null | grep -q .; then
            printf "  %-25s ${GREEN}● rodando${NC}\n" "$name"
        else
            printf "  %-25s ${YELLOW}○ parado${NC}\n" "$name"
        fi
    done
    echo ""
}

# Add new client
cmd_add() {
    local name="$1"

    if [ -z "$name" ]; then
        echo -e "${RED}Erro: Nome do cliente é obrigatório${NC}"
        echo "Uso: watcher add <nome>"
        exit 1
    fi

    # Sanitize name
    name=$(echo "$name" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd '[:alnum:]-')
    local client_dir=$(get_client_dir "$name")

    if [ -d "$client_dir" ]; then
        echo -e "${RED}Erro: Cliente '$name' já existe${NC}"
        echo "Use: watcher config $name (reconfigurar)"
        echo "Use: watcher remove $name (remover)"
        exit 1
    fi

    # Create client directory
    mkdir -p "$client_dir"

    # Run interactive config wizard (shows its own banner)
    run_config_wizard "$name" "$client_dir"

    # Check if config was saved
    if [ ! -f "$client_dir/config.env" ]; then
        echo -e "${RED}Configuração cancelada.${NC}"
        rm -rf "$client_dir"
        exit 1
    fi

    # Create docker-compose
    create_docker_compose "$name" "$client_dir"

    # Build and start
    echo -e "\n${CYAN}▶ Iniciando container...${NC}"
    cd "$client_dir"
    docker-compose up -d --build

    echo ""
    echo -e "${GREEN}════════════════════════════════════════${NC}"
    echo -e "${GREEN}          Cliente Configurado!          ${NC}"
    echo -e "${GREEN}════════════════════════════════════════${NC}"
    echo ""
    echo -e "Cliente: ${BOLD}$name${NC}"
    echo -e "Status:  ${GREEN}● rodando${NC}"
    echo ""
    echo -e "${BOLD}Comandos:${NC}"
    echo "  watcher logs $name       # Ver logs"
    echo "  watcher run $name quick  # Sync rápido"
    echo "  watcher run $name full   # Sync completo"
    echo "  watcher stop $name       # Parar"
    echo ""
}

run_config_wizard() {
    local name="$1"
    local client_dir="$2"

    # Run TypeScript wizard with prompts library
    if ! bun run "$SCRIPT_DIR/config-wizard.ts" "$name" "$client_dir"; then
        return 1
    fi
}

create_docker_compose() {
    local name="$1"
    local client_dir="$2"

    cat > "$client_dir/docker-compose.yml" << EOF
services:
  watcher:
    container_name: watcher-$name
    build:
      context: $SCRIPT_DIR
      dockerfile: Dockerfile
    env_file:
      - config.env
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ./data:/app/data
    restart: unless-stopped
EOF
}

# View logs
cmd_logs() {
    local name="$1"
    local client_dir=$(get_client_dir "$name")

    if [ -z "$name" ]; then
        echo -e "${RED}Erro: Informe o nome do cliente${NC}"
        exit 1
    fi

    if [ ! -d "$client_dir" ]; then
        echo -e "${RED}Erro: Cliente '$name' não encontrado${NC}"
        exit 1
    fi

    cd "$client_dir"
    docker-compose logs -f --tail=100
}

# Run sync
cmd_run() {
    local name="$1"
    local mode="${2:-full}"
    local client_dir=$(get_client_dir "$name")

    if [ -z "$name" ]; then
        echo -e "${RED}Erro: Informe o nome do cliente${NC}"
        exit 1
    fi

    if [ ! -d "$client_dir" ]; then
        echo -e "${RED}Erro: Cliente '$name' não encontrado${NC}"
        exit 1
    fi

    cd "$client_dir"

    # Ensure container is running
    if ! docker-compose ps --status running 2>/dev/null | grep -q watcher; then
        echo -e "${YELLOW}Container não está rodando. Iniciando...${NC}"
        docker-compose up -d
        sleep 2
    fi

    echo -e "${CYAN}Executando sync ($mode) para $name...${NC}"
    docker-compose exec watcher bun run /app/watcher.ts --mode "$mode"
}

# Stop client
cmd_stop() {
    local name="$1"
    local client_dir=$(get_client_dir "$name")

    if [ -z "$name" ]; then
        echo -e "${RED}Erro: Informe o nome do cliente${NC}"
        exit 1
    fi

    if [ ! -d "$client_dir" ]; then
        echo -e "${RED}Erro: Cliente '$name' não encontrado${NC}"
        exit 1
    fi

    echo -e "${YELLOW}Parando $name...${NC}"
    cd "$client_dir"
    docker-compose down
    echo -e "${GREEN}✓ Parado${NC}"
}

# Start client
cmd_start() {
    local name="$1"
    local client_dir=$(get_client_dir "$name")

    if [ -z "$name" ]; then
        echo -e "${RED}Erro: Informe o nome do cliente${NC}"
        exit 1
    fi

    if [ ! -d "$client_dir" ]; then
        echo -e "${RED}Erro: Cliente '$name' não encontrado${NC}"
        exit 1
    fi

    echo -e "${CYAN}Iniciando $name...${NC}"
    cd "$client_dir"
    docker-compose up -d
    echo -e "${GREEN}✓ Iniciado${NC}"
}

# Remove client
cmd_remove() {
    local name="$1"
    local client_dir=$(get_client_dir "$name")

    if [ -z "$name" ]; then
        echo -e "${RED}Erro: Informe o nome do cliente${NC}"
        exit 1
    fi

    if [ ! -d "$client_dir" ]; then
        echo -e "${RED}Erro: Cliente '$name' não encontrado${NC}"
        exit 1
    fi

    echo -e "${YELLOW}Isso vai remover o cliente '$name' e todos os dados.${NC}"
    read -p "Tem certeza? (s/N): " confirm

    if [[ ! "$confirm" =~ ^[Ss]$ ]]; then
        echo "Cancelado."
        exit 0
    fi

    echo "Parando container..."
    cd "$client_dir"
    docker-compose down -v 2>/dev/null || true

    echo "Removendo arquivos..."
    rm -rf "$client_dir"

    echo -e "${GREEN}✓ Cliente '$name' removido${NC}"
}

# Reconfigure client
cmd_config() {
    local name="$1"
    local client_dir=$(get_client_dir "$name")

    if [ -z "$name" ]; then
        echo -e "${RED}Erro: Informe o nome do cliente${NC}"
        exit 1
    fi

    if [ ! -d "$client_dir" ]; then
        echo -e "${RED}Erro: Cliente '$name' não encontrado${NC}"
        exit 1
    fi

    echo -e "${CYAN}Reconfigurando $name...${NC}"
    run_config_wizard "$name" "$client_dir"

    # Check if config was saved
    if [ ! -f "$client_dir/config.env" ]; then
        echo -e "${RED}Configuração cancelada.${NC}"
        exit 1
    fi

    # Recreate docker-compose
    create_docker_compose "$name" "$client_dir"

    # Restart if running
    cd "$client_dir"
    if docker ps -q -f "name=watcher-$name" 2>/dev/null | grep -q .; then
        echo -e "${CYAN}Reiniciando container...${NC}"
        docker-compose down 2>/dev/null || true
        docker-compose up -d --build
    fi

    echo -e "${GREEN}✓ Reconfigurado${NC}"
}

# Main
case "${1:-}" in
    add)
        cmd_add "$2"
        ;;
    list|ls)
        cmd_list
        ;;
    logs|log)
        cmd_logs "$2"
        ;;
    run|sync)
        cmd_run "$2" "$3"
        ;;
    stop)
        cmd_stop "$2"
        ;;
    start)
        cmd_start "$2"
        ;;
    remove|rm)
        cmd_remove "$2"
        ;;
    config)
        cmd_config "$2"
        ;;
    help|--help|-h|"")
        show_help
        ;;
    *)
        echo -e "${RED}Comando desconhecido: $1${NC}"
        show_help
        exit 1
        ;;
esac
