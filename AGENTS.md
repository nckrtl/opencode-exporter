# OpenCode Metrics Exporter

Node.js service that exports OpenCode metrics to OpenTelemetry.

## Architecture

1. **Backfill**: On startup, fetches all sessions via REST API and aggregates historical metrics
2. **Real-time**: Subscribes to SSE stream at `/event` for live updates

## SSE Event Format

OpenCode events use **nested `properties.info` structure**:

```javascript
// CORRECT: Extract from properties.info
const info = properties.info || properties;
const { id, role, modelID, providerID, tokens, finish } = info;

// WRONG: Don't access properties directly
const { id, role } = properties; // Will be undefined!
```

### Token Structure

```javascript
tokens: {
  input: 3047,
  output: 7,
  reasoning: 368,  // Extended thinking tokens
  cache: {
    read: 10600,
    write: 0
  }
}
```

### Event Types

| Event | Properties Location | When to Count |
|-------|-------------------|---------------|
| `session.created` | `properties.info.id` | Always |
| `session.updated` | `properties.info.*` | Update metadata only |
| `session.deleted` | `properties.info.id` | Decrement active count |
| `message.updated` | `properties.info.*` | Only when `role=assistant` AND `finish` exists |

## Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `opencode.session.count` | Counter | - |
| `opencode.session.active` | UpDownCounter | - |
| `opencode.service.running` | Gauge | source |
| `opencode.message.count` | Counter | role, model, provider |
| `opencode.token.usage` | Counter | type, model, provider |
| `opencode.tool.usage` | Counter | tool, status |
| `opencode.error.count` | Counter | type |
| `opencode.session.info` | Gauge | session_id, title, directory, source |
| `opencode.error.info` | Gauge | timestamp, type, message, source |

### Service Running Metric

The `opencode.service.running` gauge indicates whether the OpenCode service is reachable:
- **Value 1**: Connected to OpenCode server successfully
- **Value 0**: Cannot connect (service not running or unreachable)

This metric is used by the "Active Sessions" dashboard panel, which sums across all exporter instances to show total active services.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_URL` | `http://host.docker.internal:4096` | OpenCode server URL |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://otel-collector:4317` | OTLP endpoint |
| `EXPORT_INTERVAL` | `10000` | Metrics export interval (ms) |
| `INSTANCE_ID` | hostname | Unique instance identifier |
| `DEBUG` | - | Set to enable verbose event logging |

## Debugging

```bash
# Watch exporter logs
docker logs -f observer-opencode-exporter-1

# Test SSE connection
curl -sN 'http://localhost:4096/event' --max-time 5

# Rebuild after changes
docker compose build opencode-exporter && docker compose up -d opencode-exporter
```

## Common Issues

1. **"Session created: unknown"** - Event format mismatch, check `properties.info.id`
2. **Tokens not updating** - Check that `processMessage()` extracts from `properties.info.tokens`
3. **Backfill works but real-time doesn't** - SSE connection may have dropped, check logs
