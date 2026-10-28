const { exec } = require('node:child_process');
const { createHash, timingSafeEqual } = require('node:crypto');
const { Client } = require('ssh2');

const MAX_OUTPUT_BYTES = 262_144;

function timeoutMs(value) {
  const number = Number(value || 30_000);
  if (!Number.isInteger(number) || number < 1_000 || number > 300_000) throw new Error('Timeout must be between 1000 and 300000 ms');
  return number;
}

function inputText(message) {
  const payload = message.payload;
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
  if (Buffer.byteLength(input) > MAX_OUTPUT_BYTES) throw new Error('Input exceeds 256 KiB');
  return input;
}

async function credential(envName, label, required = true, getSecret) {
  const key = String(envName || '').trim();
  if (!key && !required) return undefined;
  if (key.startsWith('vault:')) {
    if (!getSecret) throw new Error('Secret Vault is unavailable for SSH');
    return getSecret(key.slice(6));
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`${label} must name an environment variable`);
  const value = process.env[key];
  if (!value) throw new Error(`${label} environment variable ${key} is not set`);
  return value;
}

function executeLocal(command, config, input) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = exec(command, {
      cwd: String(config.workingDirectory || '').trim() || undefined,
      timeout: timeoutMs(config.timeoutMs),
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error && (error.killed || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')) {
        reject(new Error(error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'Exec output exceeds 256 KiB' : 'Exec command timed out'));
        return;
      }
      if (error && typeof error.code !== 'number') { reject(error); return; }
      resolve({ stdout, stderr, exitCode: error ? error.code : 0, durationMs: Date.now() - started });
    });
    child.stdin?.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin?.end(input);
  });
}

async function executeSsh(config, input, ClientClass = Client, getSecret) {
  const host = String(config.host || '').trim();
  const usernameRef = String(config.username || '').trim();
  const username = usernameRef.startsWith('vault:') ? await credential(usernameRef, 'SSH username', true, getSecret) : usernameRef;
  const command = String(config.command || '').trim();
  const port = Number(config.port || 22);
  const expected = String(config.hostKeySha256 || '').trim().replace(/^SHA256:/i, '').replace(/=+$/, '');
  if (!host || !username || !command) throw new Error('SSH host, username, and command are required');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH port must be between 1 and 65535');
  if (!/^[A-Za-z0-9+/]{43}$/.test(expected)) throw new Error('SSH host key SHA256 fingerprint is required (SHA256:base64)');
  const authMode = String(config.authMode || 'privateKey');
  const auth = authMode === 'password'
    ? { password: await credential(config.passwordEnv, 'SSH password', true, getSecret) }
    : authMode === 'privateKey'
      ? { privateKey: (await credential(config.privateKeyEnv, 'SSH private key', true, getSecret)).replace(/\\n/g, '\n'), passphrase: await credential(config.passphraseEnv, 'SSH key passphrase', false, getSecret) }
      : null;
  if (!auth) throw new Error('SSH authentication must be password or privateKey');
  const limit = timeoutMs(config.timeoutMs);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const client = new ClientClass();
    let settled = false;
    let hostKeyMismatch = false;
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    const timer = setTimeout(() => fail(new Error('SSH command timed out')), limit);
    function finish(result, error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end();
      if (error) reject(error);
      else resolve(result);
    }
    function fail(error) {
      finish(null, hostKeyMismatch ? new Error('SSH host key fingerprint does not match') : error);
    }
    function collect(chunk, output) {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) { fail(new Error('SSH output exceeds 256 KiB')); return; }
      if (output === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    }
    client.on('ready', () => {
      client.exec(command, (error, stream) => {
        if (error) { fail(error); return; }
        stream.on('data', chunk => collect(chunk, 'stdout'));
        stream.stderr.on('data', chunk => collect(chunk, 'stderr'));
        stream.on('error', fail);
        stream.on('close', (code, signal) => {
          if (signal) { fail(new Error(`SSH command ended with signal ${signal}`)); return; }
          finish({ stdout, stderr, exitCode: Number.isInteger(code) ? code : 0, durationMs: Date.now() - started });
        });
        stream.end(input);
      });
    });
    client.on('error', fail);
    client.on('close', () => { if (!settled) fail(new Error('SSH connection closed before the command finished')); });
    try {
      client.connect({
        host, port, username, ...auth,
        readyTimeout: Math.min(limit, 20_000),
        hostVerifier(key) {
          const actual = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
          const wanted = Buffer.from(expected);
          const received = Buffer.from(actual);
          const valid = wanted.length === received.length && timingSafeEqual(wanted, received);
          if (!valid) hostKeyMismatch = true;
          return valid;
        },
      });
    } catch (error) { fail(error); }
  });
}

exports.executeLocal = executeLocal;
exports.executeSsh = executeSsh;
exports.nodes = [
  {
    definition: {
      type: 'exec', label: 'Exec', category: 'System', color: '#3262c4', icon: 'code',
      inputs: 1, outputs: 1, description: 'Run a configured shell command on the Wflow server and put stdout in msg.payload.',
      defaults: { command: '', workingDirectory: '', stdinFromPayload: false, timeoutMs: 30000, failOnNonZero: true },
      fields: [
        { key: 'command', label: 'Shell command', type: 'textarea', placeholder: 'bun --version' },
        { key: 'workingDirectory', label: 'Working directory (optional)', type: 'text' },
        { key: 'stdinFromPayload', label: 'Send msg.payload to stdin', type: 'boolean' },
        { key: 'timeoutMs', label: 'Timeout (ms)', type: 'number' },
        { key: 'failOnNonZero', label: 'Fail on non-zero exit', type: 'boolean' },
      ],
    },
    async run(message, context) {
      const command = String(context.config.command || '').trim();
      if (!command) throw new Error('Exec shell command is required');
      const input = context.config.stdinFromPayload ? inputText(message) : '';
      const result = await executeLocal(command, context.config, input);
      if (result.exitCode !== 0 && context.config.failOnNonZero !== false) {
        throw new Error(`Exec exited with code ${result.exitCode}: ${result.stderr.trim().slice(0, 500)}`);
      }
      message.payload = result.stdout;
      message.exec = { exitCode: result.exitCode, stderr: result.stderr, durationMs: result.durationMs };
      context.send(0, message);
    },
  },
  {
    definition: {
      type: 'ssh', label: 'SSH', category: 'Network', color: '#20a8c3', icon: 'globe',
      inputs: 1, outputs: 1, description: 'Run a command over SSH with environment or vault credentials and a verified host key.',
      defaults: { host: '', port: 22, username: '', command: '', authMode: 'privateKey', privateKeyEnv: 'SSH_PRIVATE_KEY', passwordEnv: 'SSH_PASSWORD', passphraseEnv: '', hostKeySha256: '', stdinFromPayload: false, timeoutMs: 30000, failOnNonZero: true },
      fields: [
        { key: 'host', label: 'Host', type: 'text', placeholder: 'server.example.com' },
        { key: 'port', label: 'Port', type: 'number' },
        { key: 'username', label: 'Username or vault:name', type: 'text' },
        { key: 'command', label: 'Remote command', type: 'textarea', placeholder: 'uptime' },
        { key: 'authMode', label: 'Authentication', type: 'select', options: ['privateKey', 'password'] },
        { key: 'privateKeyEnv', label: 'Private key env variable or vault:name', type: 'text', placeholder: 'SSH_PRIVATE_KEY' },
        { key: 'passwordEnv', label: 'Password env variable or vault:name', type: 'text', placeholder: 'vault:servers/prod/password' },
        { key: 'passphraseEnv', label: 'Key passphrase env variable or vault:name (optional)', type: 'text' },
        { key: 'hostKeySha256', label: 'Host key fingerprint', type: 'text', placeholder: 'SHA256:...' },
        { key: 'stdinFromPayload', label: 'Send msg.payload to stdin', type: 'boolean' },
        { key: 'timeoutMs', label: 'Timeout (ms)', type: 'number' },
        { key: 'failOnNonZero', label: 'Fail on non-zero exit', type: 'boolean' },
      ],
    },
    async run(message, context) {
      const input = context.config.stdinFromPayload ? inputText(message) : '';
      const result = await executeSsh(context.config, input, Client, context.getSecret);
      if (result.exitCode !== 0 && context.config.failOnNonZero !== false) {
        throw new Error(`SSH command exited with code ${result.exitCode}: ${result.stderr.trim().slice(0, 500)}`);
      }
      message.payload = result.stdout;
      message.ssh = { host: String(context.config.host).trim(), port: Number(context.config.port || 22), exitCode: result.exitCode, stderr: result.stderr, durationMs: result.durationMs };
      context.send(0, message);
    },
  },
];
