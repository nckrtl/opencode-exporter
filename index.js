import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { hostname } from "os";

const OPENCODE_URL = process.env.OPENCODE_URL || "http://host.docker.internal:4096";
const OTEL_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://otel-collector:4317";
const EXPORT_INTERVAL = parseInt(process.env.EXPORT_INTERVAL || "10000", 10);
const INSTANCE_ID = process.env.INSTANCE_ID || hostname();

console.log(`OpenCode Metrics Exporter starting...`);
console.log(`OpenCode URL: ${OPENCODE_URL}`);
console.log(`OTLP Endpoint: ${OTEL_ENDPOINT}`);
console.log(`Instance ID: ${INSTANCE_ID}`);

// Set up OpenTelemetry
const resource = new Resource({
  [ATTR_SERVICE_NAME]: "opencode",
  [ATTR_SERVICE_VERSION]: "1.0.0",
  "service.instance.id": INSTANCE_ID,
});

const metricExporter = new OTLPMetricExporter({
  url: OTEL_ENDPOINT,
});

const meterProvider = new MeterProvider({
  resource,
  readers: [
    new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: EXPORT_INTERVAL,
    }),
  ],
});

const meter = meterProvider.getMeter("opencode-metrics");

// Define metrics
const sessionCounter = meter.createCounter("opencode.session.count", {
  description: "Count of OpenCode sessions",
  unit: "1",
});

const messageCounter = meter.createCounter("opencode.message.count", {
  description: "Count of messages sent",
  unit: "1",
});

const tokenCounter = meter.createCounter("opencode.token.usage", {
  description: "Number of tokens used",
  unit: "tokens",
});

const toolUseCounter = meter.createCounter("opencode.tool.usage", {
  description: "Count of tool usages",
  unit: "1",
});

const errorCounter = meter.createCounter("opencode.error.count", {
  description: "Count of errors",
  unit: "1",
});

const activeSessionsGauge = meter.createUpDownCounter("opencode.session.active", {
  description: "Number of active sessions",
  unit: "1",
});

// Track state
const activeSessions = new Set();
const sessionMetadata = new Map(); // id -> {title, directory, slug}
const processedMessages = new Set();
const recentErrors = []; // Array of {timestamp, type, message, instance}
const MAX_ERRORS = 100; // Keep last 100 errors
const ERROR_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

// Observable gauges for session and error info
const sessionInfoGauge = meter.createObservableGauge("opencode.session.info", {
  description: "Session information with metadata labels",
  unit: "1",
});

const errorInfoGauge = meter.createObservableGauge("opencode.error.info", {
  description: "Recent error information with details",
  unit: "1",
});

// Use batch callback to report all sessions and errors together
// Note: Don't use 'instance' as attribute name - it collides with resource attribute
meter.addBatchObservableCallback(
  (batchObservableResult) => {
    // Report all sessions
    for (const [id, meta] of sessionMetadata) {
      batchObservableResult.observe(sessionInfoGauge, 1, {
        session_id: id,
        slug: meta.slug || "",
        title: meta.title || "",
        directory: meta.directory || "",
        source: INSTANCE_ID,
      });
    }
    
    // Clean up old errors
    const now = Date.now();
    while (recentErrors.length > 0 && now - recentErrors[0].timestamp > ERROR_RETENTION_MS) {
      recentErrors.shift();
    }
    
    // Report all errors
    for (const error of recentErrors) {
      batchObservableResult.observe(errorInfoGauge, 1, {
        timestamp: new Date(error.timestamp).toISOString(),
        type: error.type,
        message: error.message.slice(0, 200),
        source: error.instance,
      });
    }
  },
  [sessionInfoGauge, errorInfoGauge]
);

let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;

async function fetchJson(path) {
  const response = await fetch(`${OPENCODE_URL}${path}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

async function connectAndListen() {
  try {
    console.log(`Connecting to OpenCode at ${OPENCODE_URL}...`);
    
    // Check health first
    const health = await fetchJson("/global/health");
    if (health.healthy) {
      console.log(`Connected to OpenCode v${health.version}`);
      reconnectAttempts = 0;
    } else {
      throw new Error("OpenCode server not healthy");
    }

    // Reset session tracking on reconnect to avoid double-counting
    const previousCount = activeSessions.size;
    if (previousCount > 0) {
      activeSessionsGauge.add(-previousCount);
      activeSessions.clear();
      sessionMetadata.clear();
    }

    // Get initial session list
    const sessions = await fetchJson("/session");
    if (Array.isArray(sessions)) {
      console.log(`Found ${sessions.length} existing sessions`);
      sessions.forEach(s => {
        activeSessions.add(s.id);
        sessionMetadata.set(s.id, {
          slug: s.slug || "",
          title: s.title || "",
          directory: s.directory || "",
        });
      });
      activeSessionsGauge.add(sessions.length);
    }

    // Subscribe to SSE events
    console.log("Subscribing to events...");
    const eventSource = await fetch(`${OPENCODE_URL}/event`);
    
    if (!eventSource.ok) {
      throw new Error(`Failed to connect to event stream: ${eventSource.status}`);
    }

    const reader = eventSource.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        console.log("Event stream ended");
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            processEvent(data);
          } catch (e) {
            // Skip non-JSON data lines
          }
        }
      }
    }
  } catch (error) {
    console.error(`Connection error: ${error.message}`);
    errorCounter.add(1, { type: "connection" });
    
    // Store connection error details for table view
    recentErrors.push({
      timestamp: Date.now(),
      type: "connection",
      message: error.message,
      instance: INSTANCE_ID,
    });
    while (recentErrors.length > MAX_ERRORS) {
      recentErrors.shift();
    }
    
    // Exponential backoff reconnect
    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
    console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})...`);
    setTimeout(connectAndListen, delay);
  }
}

function processEvent(event) {
  try {
    const { type, properties } = event;
    
    if (process.env.DEBUG) {
      console.log(`Event: ${type}`, JSON.stringify(properties).slice(0, 200));
    }

    switch (type) {
      case "session.created":
        sessionCounter.add(1);
        if (properties?.id) {
          activeSessions.add(properties.id);
          sessionMetadata.set(properties.id, {
            slug: properties.slug || "",
            title: properties.title || "",
            directory: properties.directory || "",
          });
          activeSessionsGauge.add(1);
        }
        console.log(`Session created: ${properties?.id || "unknown"}`);
        break;

      case "session.updated":
        if (properties?.id && sessionMetadata.has(properties.id)) {
          const meta = sessionMetadata.get(properties.id);
          if (properties.title) meta.title = properties.title;
          if (properties.directory) meta.directory = properties.directory;
          if (properties.slug) meta.slug = properties.slug;
        }
        break;

      case "session.deleted":
        if (properties?.id && activeSessions.has(properties.id)) {
          activeSessions.delete(properties.id);
          sessionMetadata.delete(properties.id);
          activeSessionsGauge.add(-1);
        }
        console.log(`Session deleted: ${properties?.id || "unknown"}`);
        break;

      case "message.created":
      case "message.updated":
        processMessage(properties);
        break;

      case "part.created":
      case "part.updated":
        processPart(properties);
        break;

      case "error":
        const errorType = properties?.code || "unknown";
        const errorMessage = properties?.message || "unknown";
        errorCounter.add(1, { type: errorType });
        
        // Store error details for table view
        recentErrors.push({
          timestamp: Date.now(),
          type: errorType,
          message: errorMessage,
          instance: INSTANCE_ID,
        });
        
        // Keep only last MAX_ERRORS
        while (recentErrors.length > MAX_ERRORS) {
          recentErrors.shift();
        }
        
        console.log(`Error event: ${errorMessage}`);
        break;
    }
  } catch (error) {
    console.error(`Error processing event: ${error.message}`);
  }
}

function processMessage(properties) {
  if (!properties) return;

  const { id, role, model } = properties;
  
  // Avoid counting the same message multiple times
  const msgKey = `${id}-${role}`;
  if (processedMessages.has(msgKey)) return;
  processedMessages.add(msgKey);
  
  // Keep set from growing indefinitely
  if (processedMessages.size > 10000) {
    const toDelete = [...processedMessages].slice(0, 5000);
    toDelete.forEach(k => processedMessages.delete(k));
  }

  messageCounter.add(1, {
    role: role || "unknown",
    model: model?.modelID || "unknown",
    provider: model?.providerID || "unknown",
  });

  // Extract token usage if available
  if (properties.usage) {
    const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = properties.usage;
    const modelId = model?.modelID || "unknown";
    const providerId = model?.providerID || "unknown";
    
    if (inputTokens) {
      tokenCounter.add(inputTokens, { type: "input", model: modelId, provider: providerId });
      console.log(`Tokens: +${inputTokens} input (${modelId})`);
    }
    if (outputTokens) {
      tokenCounter.add(outputTokens, { type: "output", model: modelId, provider: providerId });
      console.log(`Tokens: +${outputTokens} output (${modelId})`);
    }
    if (cacheReadTokens) {
      tokenCounter.add(cacheReadTokens, { type: "cacheRead", model: modelId, provider: providerId });
    }
    if (cacheWriteTokens) {
      tokenCounter.add(cacheWriteTokens, { type: "cacheCreation", model: modelId, provider: providerId });
    }
  }
}

function processPart(properties) {
  if (!properties) return;

  const { type } = properties;
  
  // Track tool usage
  if (type === "tool-invocation" || type === "tool-result") {
    const toolName = properties.toolInvocation?.toolName || 
                     properties.toolName || 
                     "unknown";
    
    toolUseCounter.add(1, {
      tool: toolName,
      status: properties.toolInvocation?.state || properties.state || "unknown",
    });
    console.log(`Tool use: ${toolName}`);
  }
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down...");
  await meterProvider.shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("Shutting down...");
  await meterProvider.shutdown();
  process.exit(0);
});

// Start
connectAndListen();
