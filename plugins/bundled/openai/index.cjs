const OpenAI = require('openai');

const MAX_INPUT_BYTES = 65_536;
const MAX_OUTPUT_BYTES = 262_144;

function text(value) {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

function render(template, message) {
  return String(template).replace(/\{\{\s*msg\.([\w.]+)\s*\}\}/g, (_match, path) => {
    const value = path.split('.').reduce((item, key) => item == null ? undefined : item[key], message);
    return value == null ? '' : text(value);
  });
}

async function apiKey(reference, getSecret) {
  const ref = String(reference || 'OPENAI_API_KEY').trim();
  if (ref.startsWith('vault:')) {
    if (!getSecret) throw new Error('Secret Vault is unavailable for OpenAI');
    const name = ref.slice(6).trim();
    if (!name) throw new Error('OpenAI vault secret name is required');
    return getSecret(name);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new Error('OpenAI API key setting must name an environment variable or vault secret');
  const value = process.env[ref];
  if (!value) throw new Error(`OpenAI API key environment variable ${ref} is not set`);
  return value;
}

function timeout(value) {
  const ms = Number(value ?? 120_000);
  if (!Number.isInteger(ms) || ms < 1_000 || ms > 300_000) throw new Error('OpenAI timeout must be between 1000 and 300000 ms');
  return ms;
}

async function executeOpenAI(message, config, getSecret, ClientClass = OpenAI) {
  const model = String(config.model || '').trim();
  if (!model) throw new Error('OpenAI model is required');
  const prompt = String(config.prompt || '').trim() ? render(config.prompt, message) : text(message.payload);
  const instructions = String(config.instructions || '').trim();
  if (!prompt.trim()) throw new Error('OpenAI prompt is empty');
  if (Buffer.byteLength(prompt) + Buffer.byteLength(instructions) > MAX_INPUT_BYTES) throw new Error('OpenAI prompt and instructions exceed 64 KiB');
  const limit = Number(config.maxOutputTokens ?? 0);
  if (!Number.isInteger(limit) || limit < 0 || limit > 32_768) throw new Error('OpenAI max output tokens must be between 0 and 32768');
  const secret = await apiKey(config.apiKeyRef, getSecret);
  const client = new ClientClass({ apiKey: secret, timeout: timeout(config.timeoutMs), maxRetries: 0 });
  let response;
  try {
    response = await client.responses.create({ model, input: prompt, ...(instructions ? { instructions } : {}), ...(limit ? { max_output_tokens: limit } : {}), store: false });
  } catch (error) {
    throw new Error(String(error instanceof Error ? error.message : error).replaceAll(secret, '[redacted]'));
  }
  if (response.status !== 'completed') throw new Error(`OpenAI response ${response.status || 'did not complete'}`);
  const output = String(response.output_text || '');
  if (!output) throw new Error('OpenAI response contained no text');
  if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) throw new Error('OpenAI text output exceeds 256 KiB');
  message.payload = output;
  message.openai = { id: response.id, model: response.model, status: response.status, usage: response.usage || null };
  return message;
}

exports.executeOpenAI = executeOpenAI;
exports.nodes = [{
  definition: {
    type: 'openai', label: 'OpenAI', category: 'AI', color: '#183247', icon: 'sparkles',
    inputs: 1, outputs: 1, description: 'Send a prompt to the OpenAI Responses API and put the generated text in msg.payload.',
    defaults: { apiKeyRef: 'OPENAI_API_KEY', model: 'gpt-5.5', instructions: '', prompt: '{{msg.payload}}', maxOutputTokens: 0, timeoutMs: 120000 },
    fields: [
      { key: 'apiKeyRef', label: 'API key env variable or vault:name', type: 'text', placeholder: 'OPENAI_API_KEY' },
      { key: 'model', label: 'Model', type: 'text', placeholder: 'gpt-5.5' },
      { key: 'instructions', label: 'Instructions (optional)', type: 'textarea' },
      { key: 'prompt', label: 'Prompt (supports {{msg.payload}})', type: 'textarea', placeholder: '{{msg.payload}}' },
      { key: 'maxOutputTokens', label: 'Max output tokens (0 uses model default)', type: 'number' },
      { key: 'timeoutMs', label: 'Timeout (ms)', type: 'number' },
    ],
  },
  async run(message, context) { context.send(0, await executeOpenAI(message, context.config, context.getSecret)); },
}];
