# OpenCode Metrics Exporter

A sidecar that connects to OpenCode's API and exports metrics via OpenTelemetry (OTLP).

## Metrics Exported

- `opencode.session.count` - Count of sessions created
- `opencode.session.active` - Number of active sessions
- `opencode.message.count` - Messages sent (by role, model, provider)
- `opencode.token.usage` - Token usage (input, output, cache)
- `opencode.tool.usage` - Tool invocations (by tool name)
- `opencode.error.count` - Errors encountered

## Usage

### Docker

```bash
docker build -t opencode-exporter .
docker run -d \
  -e OPENCODE_URL=http://host.docker.internal:4096 \
  -e OTEL_EXPORTER_OTLP_ENDPOINT=http://your-otel-collector:4317 \
  -e EXPORT_INTERVAL=10000 \
  --add-host=host.docker.internal:host-gateway \
  --restart unless-stopped \
  opencode-exporter
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_URL` | `http://host.docker.internal:4096` | OpenCode server URL |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://otel-collector:4317` | OTLP collector endpoint |
| `EXPORT_INTERVAL` | `10000` | Metrics export interval (ms) |
| `DEBUG` | - | Enable verbose logging |

### Node.js

```bash
npm install
OPENCODE_URL=http://localhost:4096 \
OTEL_EXPORTER_OTLP_ENDPOINT=http://your-collector:4317 \
npm start
```

## Requirements

- OpenCode running with API server enabled (default port 4096)
- An OpenTelemetry collector accepting OTLP/gRPC
