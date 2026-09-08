#!/bin/bash
set -e

BACKUP_DIR="./backups"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
FILENAME="$BACKUP_DIR/postgres_backup_$TIMESTAMP.sql"

mkdir -p $BACKUP_DIR

echo "[INFO] Memulai backup database PostgreSQL..."
docker exec devops_postgres pg_dump -U devops devops_message > $FILENAME

echo "[SUCCESS] Backup berhasil disimpan di $FILENAME"