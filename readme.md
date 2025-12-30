# Product Watcher

Sincronização de produtos com embeddings de alta performance.

## Instalação

```bash
curl -fsSL https://watcher.doxacode.com.br/install.sh | bash
```

## Uso

```bash
# Adicionar novo cliente (wizard interativo)
watcher add farmacia-centro

# Listar clientes
watcher list

# Ver logs
watcher logs farmacia-centro

# Executar sync
watcher run farmacia-centro quick   # Apenas novos/desatualizados
watcher run farmacia-centro full    # Todos os produtos

# Parar/Iniciar
watcher stop farmacia-centro
watcher start farmacia-centro

# Reconfigurar
watcher config farmacia-centro

# Remover
watcher remove farmacia-centro
```

## Desinstalação

```bash
curl -fsSL https://watcher.doxacode.com.br/uninstall.sh | bash
```

## Performance

| Produtos | Modo  | Com Jina | Sem Jina |
| -------- | ----- | -------- | -------- |
| 3,000    | quick | ~15 min  | ~5 min   |
| 3,000    | full  | ~20 min  | ~8 min   |
| 10,000   | full  | ~45 min  | ~20 min  |

## Configuração

O wizard `watcher add` solicita:

| Campo           | Descrição                                |
| --------------- | ---------------------------------------- |
| Tipo do banco   | mysql5, mysql8, postgres                 |
| Host/Porta      | Conexão com o banco                      |
| Usuário/Senha   | Credenciais                              |
| Database/Tabela | Onde estão os produtos                   |
| Colunas         | Mapeamento: id, descrição, código, preço |
| Workspace ID    | UUID do workspace                        |
| Azure API Key   | Key para embeddings                      |
| Jina API Key    | Opcional: busca de descrições            |

## Arquivos

Após instalação:

```
~/.watcher/
├── watcher-cli.sh        # CLI
├── src/                  # Código fonte
│   ├── watcher.ts
│   ├── package.json
│   └── Dockerfile
└── <cliente>/            # Por cliente
    ├── config.env
    ├── docker-compose.yml
    └── data/
        └── hashes.db
```
