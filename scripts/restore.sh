#!/bin/bash
set -e

if [ -z "$1" ]; then
  echo "Penggunaan: ./restore.sh <path_to_sql_file>"
  exit 1
fi

FILE=$1

echo "[INFO] Memulihkan database dari $FILE..."
cat $FILE | docker exec -i devops_postgres psql -U devops -d devops_message

echo "[SUCCESS] Restore database selesai!"