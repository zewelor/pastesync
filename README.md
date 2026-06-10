# 📋 PasteSync

[![docker](https://github.com/zewelor/pastesync/actions/workflows/docker.yml/badge.svg)](https://github.com/zewelor/pastesync/actions/workflows/docker.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

PasteSync is a minimal, secure, in-memory shared paste bin designed for moving text between devices instantly and frictionlessly.

---

## 🎯 Design Goals

*   **Single-Paste Concept:** Exactly one shared paste per instance.
*   **Zero Persistence:** No login, no accounts, no PIN, and no database. Everything lives in-process memory only.
*   **Auto-Cleanup:** The paste is automatically cleared after inactivity.
*   **Last-Write-Wins:** Simple conflict resolution — the last save wins.
*   **Docker-First:** Ultra-small, secure multistage distroless non-root runtime with no external dependencies.

---

## ✨ Features

*   🖥️ **Minimal UI:** Single-page interface with a single `textarea` and live status indicators.
*   💾 **Autosave:** Automatically saves content with a short debounce.
*   🔄 **Real-Time Sync:** Instant updates across all active browser windows/devices using Server-Sent Events (SSE).
*   ⏱️ **Inactivity TTL:** Automatically clears the paste after a configurable period of inactivity.
*   🩺 **Orchestrator-Friendly:** Built-in `/healthz` health check endpoint with access logging disabled to keep container logs clean.
*   🛡️ **Hardened Sandbox:** Distroless non-root base container running with dropped capabilities (`CAP_DROP`) and a read-only root filesystem.
*   📱 **Favicon & PWA Support:** Native SVG favicons for desktop browsers and Android web app manifest support.

---

## 🎨 Icons

*   Browser assets live in `web/` and are served directly by the application.
*   Raw-linkable SVG assets live in `icons/`.
*   Recommended dashboard icon (e.g., for [gethomepage](https://gethomepage.dev/)): `icons/pastesync-homepage.svg`

**Raw SVG URL:**
```
https://raw.githubusercontent.com/zewelor/pastesync/main/icons/pastesync-homepage.svg
```

### Example homepage.yaml Entry:

```yaml
- Utilities:
    - PasteSync:
        href: https://pastesync.example.com
        description: Single shared paste
        icon: https://raw.githubusercontent.com/zewelor/pastesync/main/icons/pastesync-homepage.svg
        ping: https://pastesync.example.com/healthz
```

---

## ⚠️ Limitations

*   **In-Memory Only:** Container restarts, pod reschedules, or deployments will clear the paste.
*   **No Built-In Auth:** Access control should be handled at the network, reverse proxy, or ingress layer if public access needs to be restricted.

---

## ⚙️ Configuration

PasteSync is configured entirely via environment variables:

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | The network port the server listens on | `8080` |
| `PASTE_TTL` | Inactivity duration before the paste is cleared | `24h` |
| `CLEANUP_INTERVAL` | How often the background worker checks for TTL expiration | *Derived* |
| `MAX_BODY_BYTES` | Maximum allowed request size for `PUT /api/paste` | `262144` (256 KB) |

### Automatic Cleanup Interval

If `CLEANUP_INTERVAL` is not explicitly set, it is calculated dynamically using the formula:

```
cleanup_interval = max(15s, min(30m, PASTE_TTL / 288))
```

*   `24h` TTL → checks every `5m`
*   `7d` TTL → checks every `30m`
*   Very short TTLs still use a minimum check interval of `15s`.

---

## 🩺 Health Check (`/healthz`)

PasteSync exposes a lightweight health check endpoint at `GET /healthz`.

### Behavior & Design

*   **Zero-Noise Logging:** Requests targeting `/healthz` are excluded from the application's standard request logger. This prevents access logs from being flooded when orchestrators perform frequent probes.
*   **No Caching:** The endpoint returns `Cache-Control: no-store` to prevent caching by proxies.
*   **JSON Response:** Returns a `200 OK` status code with the following JSON payload:
    ```json
    {
      "status": "ok"
    }
    ```

### Example Probe Configurations

#### Kubernetes (Liveness & Readiness Probes)
```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: 8080
  initialDelaySeconds: 3
  periodSeconds: 10
readinessProbe:
  httpGet:
    path: /healthz
    port: 8080
  initialDelaySeconds: 3
  periodSeconds: 10
```

#### Docker Compose
```yaml
healthcheck:
  test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:8080/healthz"]
  interval: 10s
  timeout: 5s
  retries: 3
```

---

## 🛠️ Development & Local Setup

This repository uses `just` as a command runner and `pre-commit` for quality checks.

### Setup Git Hooks

Our pre-commit configuration uses a dockerized `gofmt` container, meaning **you do not need Go installed on your local host** to format or check code.

```bash
# Install pre-commit hooks
just setup
```

### Local Development Commands

| Command | Description |
| :--- | :--- |
| `just up` | Build and start the container locally at `http://localhost:8080` |
| `just docker_build` | Force rebuild the container image without cache |
| `just test_dockerignore` | Preview files excluded from the Docker build context |

### Manual Docker Validation

You can also run validation and testing inside Docker manually:

```bash
# Run unit tests and static builds in validation stage
docker build --target validate .

# Run the standard PasteSync image locally
docker build -t pastesync .
docker run --rm -p 8080:8080 pastesync
```

---

## 🚀 Deployment

### Docker Compose

```bash
docker compose up --build
```

### Kubernetes & Helm

 A Helm chart for Kubernetes deployment is maintained in the GitOps repository under `charts/default/pastesync`.

### GitHub Actions CI/CD

The repository automatically builds and publishes multi-architecture images to GitHub Packages (`ghcr.io/zewelor/pastesync`) for the following architectures:
*   `linux/amd64`
*   `linux/arm64`

Images are tagged with `latest`, branch names, tags (`v*`), and git commit SHAs (`sha-*`).
