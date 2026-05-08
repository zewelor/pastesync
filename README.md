# PasteSync

PasteSync is a minimal shared paste for moving text between phone and desktop.

## Design Goals

- exactly one shared paste per instance
- no login, no accounts, no PIN, no database
- no disk persistence, everything lives in process memory only
- automatic cleanup after inactivity
- simplest conflict model: last write wins
- Docker-first runtime with a small Go binary and static frontend

## Features

- single-page UI with one `textarea`
- autosave with a short debounce
- live sync through Server-Sent Events
- TTL based on the last change time
- health endpoint for containers and orchestrators
- no access logs for `/healthz`
- multistage Docker image with distroless non-root runtime

## Limitations

- container restart wipes the paste
- pod rescheduling or rollout wipes the paste
- concurrent edits use last write wins
- the app has no built-in auth, so public exposure should be protected at the network or ingress layer if needed

## Configuration

- `PORT`: listen address port, default `8080`
- `PASTE_TTL`: inactivity timeout before the paste is cleared, default `24h`
- `CLEANUP_INTERVAL`: optional override for cleanup checks
- `MAX_BODY_BYTES`: request size limit for `PUT /api/paste`, default `262144`

If `CLEANUP_INTERVAL` is not set, it is derived automatically from `PASTE_TTL`:

- formula: `max(15s, min(30m, PASTE_TTL / 288))`
- `24h` TTL becomes `5m`
- `7d` TTL becomes `30m`
- very short TTLs still use at least `15s`

Example durations:

- `24h`
- `12h`
- `30m`

## Local Validation

```bash
docker run --rm -v "$PWD:/src" -w /src golang:1.24 \
  sh -lc "/usr/local/go/bin/gofmt -w main.go main_test.go && /usr/local/go/bin/go test ./... && /usr/local/go/bin/go build -buildvcs=false ./..."
```

## Docker

```bash
docker build -t pastesync .
docker run --rm -p 8080:8080 pastesync
```

## Docker Compose

```bash
docker compose up --build
```

## GitHub Actions

The repository includes a minimal workflow that builds and pushes a multi-arch image for:

- `linux/amd64`
- `linux/arm64`

Published images target `ghcr.io/zewelor/pastesync` and include `latest`, branch, tag, and `sha-*` tags.

## Kubernetes

The Helm chart for Kubernetes lives in the GitOps repo under `charts/default/pastesync`.
