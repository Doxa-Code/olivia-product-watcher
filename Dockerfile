# Product Watcher - Runtime Image
# Apenas copia o binário pré-compilado
#
# Build:
#   bun run build:linux
#   docker build -t watcher .
#
# Push (exemplo):
#   docker tag watcher registry.doxacode.com.br/watcher:latest
#   docker push registry.doxacode.com.br/watcher:latest

FROM alpine:3.19

# Copia o binário pré-compilado
COPY dist/watcher-linux-x64 /app/watcher

# Permissão de execução
RUN chmod +x /app/watcher

WORKDIR /app/data

ENTRYPOINT ["/app/watcher"]
CMD ["daemon"]
