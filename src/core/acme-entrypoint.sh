#!/bin/sh
set -eu
umask 077

if [ "${ENABLE_TLS:-false}" = "true" ] && [ "${TLS_MODE:-}" = "letsencrypt" ]; then
  : "${TLS_DOMAIN:?TLS_DOMAIN is required for Let's Encrypt}"
  : "${TLS_EMAIL:?TLS_EMAIL is required for Let's Encrypt}"
  acme_config_dir="${TLS_ACME_CONFIG_DIR:-/data/letsencrypt}"
  acme_work_dir="${TLS_ACME_WORK_DIR:-/data/letsencrypt-work}"
  acme_logs_dir="${TLS_ACME_LOGS_DIR:-/data/letsencrypt-logs}"
  acme_http_port="${TLS_ACME_HTTP_PORT:-8080}"
  renewal_seconds="${TLS_ACME_RENEW_INTERVAL_SECONDS:-43200}"

  case "$acme_http_port" in ''|*[!0-9]*) echo 'TLS_ACME_HTTP_PORT must be numeric' >&2; exit 1 ;; esac
  case "$renewal_seconds" in ''|*[!0-9]*) echo 'TLS_ACME_RENEW_INTERVAL_SECONDS must be numeric' >&2; exit 1 ;; esac
  if [ "$acme_http_port" -lt 1024 ] || [ "$acme_http_port" -gt 65535 ]; then
    echo 'TLS_ACME_HTTP_PORT must be between 1024 and 65535' >&2
    exit 1
  fi
  if [ "$renewal_seconds" -lt 300 ]; then
    echo 'TLS_ACME_RENEW_INTERVAL_SECONDS must be at least 300' >&2
    exit 1
  fi

  mkdir -p "$acme_config_dir" "$acme_work_dir" "$acme_logs_dir"
  certbot certonly --standalone --non-interactive --agree-tos --keep-until-expiring \
    --http-01-port "$acme_http_port" --email "$TLS_EMAIL" --domains "$TLS_DOMAIN" \
    --config-dir "$acme_config_dir" --work-dir "$acme_work_dir" --logs-dir "$acme_logs_dir"

  (
    while sleep "$renewal_seconds"; do
      if ! certbot renew --non-interactive --http-01-port "$acme_http_port" \
        --config-dir "$acme_config_dir" --work-dir "$acme_work_dir" --logs-dir "$acme_logs_dir"; then
        echo 'Certbot renewal failed; the existing certificate remains active and renewal will be retried' >&2
      fi
    done
  ) &
fi

exec "$@"
