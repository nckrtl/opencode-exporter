import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { hostname } from "os";

const OPENCODE_URL = process.env.OPENCODE_URL || "http://host.docker.internal:4096";
const OTEL_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://otel-collector:4317";
const EXPORT_INTERVAL = parseInt(process.env.EXPORT_INTERVAL || "10000", 10);
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "30000", 10); // Poll every 30s for Anthropic sessions
const INSTANCE_ID = process.env.INSTANCE_ID || hostname();

console.log(`OpenCode Metrics Exporter starting...`);
console.log(`OpenCode URL: ${OPENCODE_URL}`);
console.log(`OTLP Endpoint: ${OTEL_ENDPOINT}`);
console.log(`Poll Interval: ${POLL_INTERVAL}ms`);
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

// Service status gauge - checks if opencode.service is running
const serviceRunningGauge = meter.createObservableGauge("opencode.service.running", {
  description: "Whether opencode.service is running (1=running, 0=not running)",
  unit: "1",
});

// Track service status - updated by connection attempts
let isServiceRunning = 0;

// Register observable callback for service status
serviceRunningGauge.addCallback((observableResult) => {
  observableResult.observe(isServiceRunning, { source: INSTANCE_ID });
});

// Per-session activity counter - increments when a session receives a message
// Used for time-range aware session counting in Grafana
const sessionActivityCounter = meter.createCounter("opencode.session.activity", {
  description: "Activity counter per session (increments on each message)",
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
      isServiceRunning = 1; // Service is running and healthy
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

    // Get initial session list and backfill historical metrics
    const sessions = await fetchJson("/session");
    if (Array.isArray(sessions)) {
      console.log(`Found ${sessions.length} existing sessions`);
      
      // Track sessions for active count
      sessions.forEach(s => {
        activeSessions.add(s.id);
        sessionMetadata.set(s.id, {
          slug: s.slug || "",
          title: s.title || "",
          directory: s.directory || "",
        });
      });
      activeSessionsGauge.add(sessions.length);
      
      // Count existing sessions for the counter
      sessionCounter.add(sessions.length);
      
      // Backfill historical message/token/tool data
      // NOTE: Session activity counter is NOT backfilled intentionally - it only tracks
      // real-time activity so that time-range queries in Grafana are accurate
      console.log("Backfilling historical metrics from existing sessions...");
      let totalMessages = 0;
      let totalTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      let toolCounts = new Map();
      
      for (const session of sessions) {
        try {
          const messages = await fetchJson(`/session/${session.id}/message`);
          if (!Array.isArray(messages)) continue;
          
          for (const msg of messages) {
            if (!msg.info) continue;
            
            // Count messages
            const msgKey = `${msg.info.id}-${msg.info.role}`;
            if (!processedMessages.has(msgKey)) {
              processedMessages.add(msgKey);
              totalMessages++;
              
              // Aggregate token usage
              if (msg.info.tokens) {
                const t = msg.info.tokens;
                if (t.input) totalTokens.input += t.input;
                if (t.output) totalTokens.output += t.output;
                if (t.cache?.read) totalTokens.cacheRead += t.cache.read;
                if (t.cache?.write) totalTokens.cacheWrite += t.cache.write;
              }
            }
            
            // Count tool usage from parts
            if (msg.parts) {
              for (const part of msg.parts) {
                if (part.type === "tool" && part.tool) {
                  const count = toolCounts.get(part.tool) || 0;
                  toolCounts.set(part.tool, count + 1);
                }
              }
            }
          }
        } catch (e) {
          // Skip sessions we can't fetch messages for
        }
      }
      
      // Emit backfilled metrics
      if (totalMessages > 0) {
        messageCounter.add(totalMessages, { role: "backfill", model: "historical", provider: "historical" });
        console.log(`Backfilled ${totalMessages} messages`);
      }
      
      if (totalTokens.input > 0) {
        tokenCounter.add(totalTokens.input, { type: "input", model: "historical", provider: "historical" });
      }
      if (totalTokens.output > 0) {
        tokenCounter.add(totalTokens.output, { type: "output", model: "historical", provider: "historical" });
      }
      if (totalTokens.cacheRead > 0) {
        tokenCounter.add(totalTokens.cacheRead, { type: "cacheRead", model: "historical", provider: "historical" });
      }
      if (totalTokens.cacheWrite > 0) {
        tokenCounter.add(totalTokens.cacheWrite, { type: "cacheCreation", model: "historical", provider: "historical" });
      }
      const totalAllTokens = totalTokens.input + totalTokens.output + totalTokens.cacheRead + totalTokens.cacheWrite;
      if (totalAllTokens > 0) {
        console.log(`Backfilled ${totalAllTokens} tokens`);
      }
      
      for (const [tool, count] of toolCounts) {
        toolUseCounter.add(count, { tool, status: "historical" });
      }
      if (toolCounts.size > 0) {
        const totalTools = [...toolCounts.values()].reduce((a, b) => a + b, 0);
        console.log(`Backfilled ${totalTools} tool uses across ${toolCounts.size} tools`);
      }
    }

    // Start periodic polling for Anthropic sessions (SSE doesn't broadcast these)
    startPolling();

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
        stopPolling();
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
    isServiceRunning = 0; // Service is not running or not reachable
    stopPolling(); // Stop polling on connection error, will restart on reconnect
    
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
        // Handle nested info structure
        const sessionInfo = properties?.info || properties;
        if (sessionInfo?.id) {
          activeSessions.add(sessionInfo.id);
          sessionMetadata.set(sessionInfo.id, {
            slug: sessionInfo.slug || "",
            title: sessionInfo.title || "",
            directory: sessionInfo.directory || "",
          });
          activeSessionsGauge.add(1);
        }
        console.log(`Session created: ${sessionInfo?.id || "unknown"}`);
        break;

      case "session.updated":
        const updatedSession = properties?.info || properties;
        if (updatedSession?.id && sessionMetadata.has(updatedSession.id)) {
          const meta = sessionMetadata.get(updatedSession.id);
          if (updatedSession.title) meta.title = updatedSession.title;
          if (updatedSession.directory) meta.directory = updatedSession.directory;
          if (updatedSession.slug) meta.slug = updatedSession.slug;
        }
        break;

      case "session.deleted":
        const deletedSession = properties?.info || properties;
        if (deletedSession?.id && activeSessions.has(deletedSession.id)) {
          activeSessions.delete(deletedSession.id);
          sessionMetadata.delete(deletedSession.id);
          activeSessionsGauge.add(-1);
        }
        console.log(`Session deleted: ${deletedSession?.id || "unknown"}`);
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

function processMessage(properties, sessionId = null) {
  if (!properties) return;

  // Handle nested info structure from SSE events
  const info = properties.info || properties;
  const { id, role, modelID, providerID, tokens, finish } = info;
  
  // Try to get session ID from properties if not provided
  const sessId = sessionId || properties.sessionID || properties.session_id || info.sessionID || info.session_id;
  
  // Only count completed assistant messages with tokens
  if (role !== "assistant" || !tokens || !finish) return;
  
  // Avoid counting the same message multiple times
  const msgKey = `${id}-${role}`;
  if (processedMessages.has(msgKey)) return;
  processedMessages.add(msgKey);
  
  // Keep set from growing indefinitely
  if (processedMessages.size > 10000) {
    const toDelete = [...processedMessages].slice(0, 5000);
    toDelete.forEach(k => processedMessages.delete(k));
  }

  // Increment per-session activity counter for time-range aware counting
  if (sessId) {
    sessionActivityCounter.add(1, { session_id: sessId, source: INSTANCE_ID });
  }

  messageCounter.add(1, {
    role: role || "unknown",
    model: modelID || "unknown",
    provider: providerID || "unknown",
  });

  // Extract token usage from info.tokens
  const modelId = modelID || "unknown";
  const providerId = providerID || "unknown";
  
  if (tokens.input) {
    tokenCounter.add(tokens.input, { type: "input", model: modelId, provider: providerId });
    console.log(`Tokens: +${tokens.input} input (${modelId})`);
  }
  if (tokens.output) {
    tokenCounter.add(tokens.output, { type: "output", model: modelId, provider: providerId });
    console.log(`Tokens: +${tokens.output} output (${modelId})`);
  }
  if (tokens.cache?.read) {
    tokenCounter.add(tokens.cache.read, { type: "cacheRead", model: modelId, provider: providerId });
  }
  if (tokens.cache?.write) {
    tokenCounter.add(tokens.cache.write, { type: "cacheCreation", model: modelId, provider: providerId });
  }
  if (tokens.reasoning) {
    tokenCounter.add(tokens.reasoning, { type: "reasoning", model: modelId, provider: providerId });
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

// Periodic polling to catch Anthropic sessions that don't broadcast SSE events
async function pollSessions() {
  try {
    const sessions = await fetchJson("/session");
    if (!Array.isArray(sessions)) return;
    
    let newMessages = 0;
    let newTokens = 0;
    
    for (const session of sessions) {
      // Update session metadata
      if (!activeSessions.has(session.id)) {
        activeSessions.add(session.id);
        activeSessionsGauge.add(1);
        sessionCounter.add(1);
      }
      sessionMetadata.set(session.id, {
        slug: session.slug || "",
        title: session.title || "",
        directory: session.directory || "",
      });
      
      try {
        const messages = await fetchJson(`/session/${session.id}/message`);
        if (!Array.isArray(messages)) continue;
        
        for (const msg of messages) {
          if (!msg.info) continue;
          
          const { id, role, modelID, providerID, tokens, finish } = msg.info;
          
          // Only count completed assistant messages with tokens
          if (role !== "assistant" || !tokens || !finish) continue;
          
          const msgKey = `${id}-${role}`;
          if (processedMessages.has(msgKey)) continue;
          processedMessages.add(msgKey);
          
          newMessages++;
          
          const modelId = modelID || "unknown";
          const providerId = providerID || "unknown";
          
          // Increment per-session activity counter for time-range aware counting
          sessionActivityCounter.add(1, { session_id: session.id, source: INSTANCE_ID });

          messageCounter.add(1, {
            role: role,
            model: modelId,
            provider: providerId,
          });
          
          if (tokens.input) {
            tokenCounter.add(tokens.input, { type: "input", model: modelId, provider: providerId });
            newTokens += tokens.input;
          }
          if (tokens.output) {
            tokenCounter.add(tokens.output, { type: "output", model: modelId, provider: providerId });
            newTokens += tokens.output;
          }
          if (tokens.cache?.read) {
            tokenCounter.add(tokens.cache.read, { type: "cacheRead", model: modelId, provider: providerId });
            newTokens += tokens.cache.read;
          }
          if (tokens.cache?.write) {
            tokenCounter.add(tokens.cache.write, { type: "cacheCreation", model: modelId, provider: providerId });
            newTokens += tokens.cache.write;
          }
          if (tokens.reasoning) {
            tokenCounter.add(tokens.reasoning, { type: "reasoning", model: modelId, provider: providerId });
            newTokens += tokens.reasoning;
          }
        }
      } catch (e) {
        // Skip sessions we can't fetch messages for
      }
    }
    
    if (newMessages > 0 || newTokens > 0) {
      console.log(`Poll: +${newMessages} messages, +${newTokens} tokens`);
    }
    
    // Keep processedMessages from growing indefinitely
    if (processedMessages.size > 10000) {
      const toDelete = [...processedMessages].slice(0, 5000);
      toDelete.forEach(k => processedMessages.delete(k));
    }
  } catch (error) {
    if (process.env.DEBUG) {
      console.error(`Poll error: ${error.message}`);
    }
  }
}

let pollInterval;

function startPolling() {
  console.log(`Starting periodic polling every ${POLL_INTERVAL}ms...`);
  pollInterval = setInterval(pollSessions, POLL_INTERVAL);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down...");
  stopPolling();
  await meterProvider.shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("Shutting down...");
  stopPolling();
  await meterProvider.shutdown();
  process.exit(0);
});

// Start
connectAndListen();
