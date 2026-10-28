const MAX_MESSAGE_BYTES = 262144;

function encode(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) throw new Error('WebSocket message exceeds 256 KiB');
  return text;
}

function timeout(value) {
  const ms = Number(value || 30000);
  if (!Number.isInteger(ms) || ms < 100 || ms > 300000) throw new Error('WebSocket timeout must be between 100 and 300000 ms');
  return ms;
}

async function requestReply(urlText, payload, config, WebSocketClass = WebSocket) {
  const url = new URL(String(urlText || '').trim());
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('WebSocket Client URL must start with ws:// or wss://');
  const mode = String(config.mode || 'receive');
  if (!['receive', 'send only'].includes(mode)) throw new Error('Invalid WebSocket Client mode');
  const text = encode(payload);
  return new Promise((resolve, reject) => {
    const socket = new WebSocketClass(url.toString());
    let finished = false;
    const timer = setTimeout(() => finish(new Error('WebSocket Client timed out')), timeout(config.timeoutMs));
    function finish(error, response) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      if (error) reject(error); else resolve(response);
    }
    socket.addEventListener('open', () => {
      try {
        socket.send(text);
        if (mode === 'send only') finish(null, { sent: true, bytes: Buffer.byteLength(text) });
      } catch (error) { finish(error); }
    });
    socket.addEventListener('message', event => {
      const value = typeof event.data === 'string' ? event.data : String(event.data);
      if (Buffer.byteLength(value) > MAX_MESSAGE_BYTES) { finish(new Error('WebSocket response exceeds 256 KiB')); return; }
      let response = value;
      if (config.parseJson) { try { response = JSON.parse(value); } catch { finish(new Error('WebSocket response is not valid JSON')); return; } }
      finish(null, response);
    });
    socket.addEventListener('error', () => finish(new Error('WebSocket Client connection failed')));
    socket.addEventListener('close', () => { if (!finished) finish(new Error('WebSocket Client closed before a response arrived')); });
  });
}

exports.requestReply = requestReply;
exports.nodes = [
  {
    definition: {
      type: 'websocket-in', label: 'WebSocket In', category: 'Input', color: '#20a8c3', icon: 'globe',
      inputs: 0, outputs: 1, description: 'Receive messages at /ws/{path} and start a workflow for each message.',
      defaults: { path: 'messages', parseJson: true, tokenEnv: '' },
      fields: [
        { key: 'path', label: 'Path after /ws/', type: 'text', placeholder: 'messages' },
        { key: 'parseJson', label: 'Parse JSON messages', type: 'boolean' },
        { key: 'tokenEnv', label: 'Access token environment variable (optional)', type: 'text', placeholder: 'WS_ACCESS_TOKEN' },
      ],
    },
    run(message, context) { context.send(0, message); },
  },
  {
    definition: {
      type: 'websocket-out', label: 'WebSocket Out', category: 'Output', color: '#20a8c3', icon: 'send',
      inputs: 1, outputs: 1, description: 'Send msg.payload to its WebSocket client, or broadcast to clients connected to a WebSocket In node.',
      defaults: { inputNodeId: '', broadcast: false },
      fields: [
        { key: 'inputNodeId', label: 'WebSocket In node ID (blank uses incoming connection)', type: 'text' },
        { key: 'broadcast', label: 'Broadcast to all clients on this input', type: 'boolean' },
      ],
    },
    run(message, context) {
      if (!context.websocketSend) throw new Error('WebSocket server is unavailable');
      const target = String(context.config.inputNodeId || message._websocket?.nodeId || '').trim();
      if (!target) throw new Error('WebSocket Out needs an input node ID or an incoming WebSocket message');
      const count = context.websocketSend(target, message._websocket?.connectionId, encode(message.payload), Boolean(context.config.broadcast));
      if (!count) throw new Error('No matching WebSocket clients are connected');
      message.websocket = { sentTo: count, inputNodeId: target };
      context.send(0, message);
    },
  },
  {
    definition: {
      type: 'websocket-client', label: 'WebSocket Client', category: 'Network', color: '#3262c4', icon: 'globe',
      inputs: 1, outputs: 1, description: 'Connect to a WebSocket URL, send msg.payload, and optionally place the first reply in msg.payload.',
      defaults: { url: 'ws://127.0.0.1:3001/ws/messages', mode: 'receive', parseJson: true, timeoutMs: 30000 },
      fields: [
        { key: 'url', label: 'WebSocket URL', type: 'text', placeholder: 'wss://example.com/socket' },
        { key: 'mode', label: 'Mode', type: 'select', options: ['receive', 'send only'] },
        { key: 'parseJson', label: 'Parse JSON reply', type: 'boolean' },
        { key: 'timeoutMs', label: 'Timeout (ms)', type: 'number' },
      ],
    },
    async run(message, context) {
      const result = await requestReply(context.config.url, message.payload, context.config);
      if (context.config.mode === 'send only') message.websocket = result;
      else message.payload = result;
      context.send(0, message);
    },
  },
];
