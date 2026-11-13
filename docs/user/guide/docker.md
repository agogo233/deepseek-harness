# Run DeepSeek Harness in a container

English | [中文](docker.zh.md)

The published image starts a ready-to-use Harness with the Web UI and one-shot tasks in one process. It runs as an unprivileged user, keeps session data and workspaces on named volumes, and ships Python for code execution.

## What is in the image

- The `dsh` command: Web UI and one-shot tasks
- A persistent terminal and command execution
- The Web frontend
- A confinement sandbox for file operations
- Python 3 and the Python code-execution backend
- The project license and third-party notices

## Run it

The image name follows the repository that builds it (`ghcr.io/<owner>/deepseek-harness`); the examples below use the image published by the `agogo233` fork.

```sh
docker run -d --name dsh -p 3080:3080 \
  -e DEEPSEEK_API_KEY=your-key \
  -v dsh-data:/data \
  -v "$PWD/workspace:/workspace" \
  ghcr.io/agogo233/deepseek-harness:latest
```

The Web UI prints a startup URL carrying a token. See [Run from npm](../../../README.md#run) for the plain install path.

### One-shot tasks

```sh
docker run --rm \
  -e DEEPSEEK_API_KEY=your-key \
  -v "$PWD/workspace:/workspace" \
  ghcr.io/agogo233/deepseek-harness:latest \
  headless "Summarize this repository"
```

### docker compose

```yaml
# docker-compose.yml
services:
  dsh:
    image: ghcr.io/agogo233/deepseek-harness:latest
    ports: ["3080:3080"]
    environment:
      DEEPSEEK_API_KEY: ${DEEPSEEK_API_KEY}
    volumes:
      - dsh-data:/data
      - ./workspace:/workspace
volumes:
  dsh-data:
```

```sh
docker compose up -d
```

## Reach it from the local network

Port mapping alone is enough; a reverse proxy is not required for local use. Tell the process which address browsers use, or the API rejects requests:

```sh
docker run -d --name dsh -p 3080:3080 \
  -e DEEPSEEK_API_KEY=your-key \
  -e DSH_PUBLIC_URL=http://192.168.1.10:3080/ \
  -e DSH_TRUSTED_HOSTS=192.168.1.10 \
  -v dsh-data:/data \
  -v "$PWD/workspace:/workspace" \
  ghcr.io/agogo233/deepseek-harness:latest
```

`DSH_PUBLIC_URL` only changes the address printed in the startup line. `DSH_TRUSTED_HOSTS` is what actually admits the address to the API, one host or host:port per entry.

## Authentication

Every request needs a credential, and there is no username or password.

- The startup line carries a one-time token. Open it, and the browser receives a signed cookie good for that address for 30 days.
- After that, the cookie authenticates every page request and real-time call.
- Sharing the startup line shares access. Clearing the cookie ends one browser session.
- Restarting changes the token; cookies signed before the restart keep working until they expire.
- To sign out everyone, delete the credentials file in the data volume and restart.

## Publish behind a reverse proxy

For public access, put a reverse proxy in front: it owns TLS, the host name, and an extra authentication layer. The built-in token and cookie are not enough on their own over the open internet.

See [Publish the Web UI behind a reverse proxy](./public-deployments.md) for what the proxy must do: preserve the browser-facing host, strip the mount prefix, forward upgrades, rewrite cookie scope, and redirect the bare mount. Pass the same address to the process:

```sh
dsh --profile web --public-url https://app.example/ui/ --trusted-host app.example
```

In the image, set:

```sh
DSH_PUBLIC_URL=https://app.example/ui/
DSH_TRUSTED_HOSTS=app.example
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DEEPSEEK_API_KEY` | | Model API key |
| `DSH_PUBLIC_URL` | `http://localhost:3080/` | Address printed in the startup line |
| `DSH_TRUSTED_HOSTS` | | Space-separated authorities the API accepts |
| `DSH_BIND_HOST` | container IPv4 | Address the listener binds |
| `DSH_PORT` | `3080` | Listener port |
| `DSH_HOME` | `/data/dsh` | Session and credential storage |
| `DSH_AGENTS_HOME` | `/data/agents` | Agent notes |
| `DSH_TELEMETRY_DISABLED` | `1` | Usage-data reporting is off by default |

## Data

- `/data/dsh` holds sessions, credentials, and settings.
- `/workspace` is the workspace the agent reads and edits.
- Both are volumes, so data survives restarts and is wiped when the volumes are removed.

## Python

Python 3 is included for code execution. The Web UI and one-shot tasks use the built-in backend by default; the Python backend is experimental and needs an explicit composition to enable.
