# Wflow Studio

A local workflow engine inspired by Node-RED, built with **Bun**, **React**, **Vite**, and **React Flow**. Use the Event, Condition, Action, and More toolbox to add nodes, connect them on the canvas, edit their settings, save, and activate the workflow in the Bun process.

The architecture and compatibility scope are recorded in [research and design notes](docs/research.md).

## Run

Requires Bun 1.3 or newer and a MySQL or MariaDB database. Set `DB_PROVIDER` to `mysql` or `mariadb` and set `DB_HOST`, `DB_PORT`, `DATABASE_NAME`, `DB_USER`, and `DB_PASSWORD` in `.env`. Create the database and grant the account permission to create and update tables; the server creates its tables at startup.

```sh
bun install
bun run dev
```

Open http://127.0.0.1:5173. The API runs at http://127.0.0.1:3001. For a single-process production-style run:

```sh
bun run build
bun run start
```

Then open http://127.0.0.1:3001. `WFLOW_HOST`, `WFLOW_PORT`, `WFLOW_DATA_DIR`, and `WFLOW_FILES_DIR` override the local bind address, port, data directory, and directory used by file nodes.

## Built-in nodes

| Category | Nodes |
| --- | --- |
| Input | Inject, HTTP In, Continue, Email In, WebSocket In |
| Function | Function, Change, Switch, Template, JSON, Delay |
| Network | HTTP Request |
| Output | Debug, HTTP Response, Email Out |
| File plugin | File Read, File Write, CSV Parser |
| Command plugin | Exec, SSH |
| WebSocket plugin | WebSocket In, WebSocket Out, WebSocket Client |
| OpenAI plugin | OpenAI |
| Redis plugin | Redis, Redis Subscriber |

`msg` is a JSON-compatible object passed along each wire. Most nodes read or update `msg.payload`. Switch has two outputs: matching and non-matching. Inject nodes can repeat on an interval. HTTP In nodes expose `/hook/<path>` on the Bun server. A flow handling HTTP requests should connect to HTTP Response.

The starter flow is **Inject → Template → Debug**. Click **Activate**, then double-click Inject or select it and click **Run injection**. The bottom bar contains **Debug** and **Help** tabs; select a debug entry to inspect its JSON in Ace. JavaScript and JSON node settings also use Ace.

Workflow drafts and deployed snapshots are saved in MySQL/MariaDB and restored at startup. On first start with the database, existing `data/workflows.json` and `data/deployed.json` are imported once. Edits do not affect a running deployment until the next deploy. The editor also supports workflow JSON import and export.

Open **Automations** from the editor breadcrumb, or visit `/automations`, to see every workflow in a searchable table. It shows the description, active state, tags, last execution, average completed execution time, run count, and whether a deployment has pending changes. Click a workflow to edit it, or use **View history** to open `/automations/:id/history`. That page lists recorded executions with their status, trigger, duration, step count, and errors. Open a run to visit `/automations/:id/history/:runId`, where its step path shows each node's timing, input, output, parameters, emitted messages, and events. The tables read workflow and execution data from MySQL/MariaDB.

Open **Plugins** from the left navigation, or visit `/plugins`, to browse plugins and nodes in a full-page table. Filter by installed, built-in, or available items and by plugins or nodes. Enter a Wflow-compatible npm package name to install it, or create a custom node from the page.

Open **Connectors** from the left navigation, or visit `/connectors`, to browse HTTP, email, file, SSH, and WebSocket integration nodes. The interface uses the self-hosted Radio Canada font.

Open **Secret Vault** from the left navigation, or visit `/vault`, to create, search, update, and delete credentials. The list only returns names, descriptions, version numbers, and timestamps. A saved value is never returned to the browser; leave the value blank while editing to keep it, or enter a replacement to rotate it. Values are encrypted in MariaDB with AES-256-GCM and a random nonce per write. Set `WFLOW_VAULT_KEY` in the server environment to a persistent, random 64-character hex value (32 bytes). Back up this key separately from the database: losing it makes stored values unreadable. The local `.env` is ignored by Git and has been configured for this workspace.

Function nodes can use `await getSecret('servers/prod/password')`, and custom nodes receive the same helper. Package handlers can call `await context.getSecret(name)`. SSH node settings accept `vault:name` for the username, password, private key, or key passphrase; for example, set **Password env variable or vault:name** to `vault:servers/prod/password`. Existing environment variable references still work. Vault values fetched during a run are masked in execution history and debug logs. Workflow code runs with server permissions and can intentionally send a secret to an external destination; keep the server bound to loopback unless you add authentication and access controls.

The workflow overflow menu can download the full diagram as a PNG with **Save as image**.

Each execution saves its trigger, status, start and finish time, input, output, error, and debug events. Each node step saves its input, output, emitted messages, configured parameters, start and finish time, and error. Open **History** in a workflow to inspect runs and steps. JavaScript and JSON data is shown in Ace. Stored snapshots redact keys such as `password`, `secret`, `token`, `authorization`, and `apiKey`, and values above 256 KiB are truncated. Execution history remains in the database after a workflow is deleted.

**Continue** emits a message after any watched node finishes. Leave its watch setting at `*` for all nodes, or enter comma-separated node IDs, types, or names. Its output includes `msg.completion` with the source node, finish time, status, and error. A Continue branch does not create further completion events, preventing loops.

**Email In** polls one or more IMAP folders and starts an execution for each new message. Configure folder names in the node or use **Browse folders** to pick from the account. The node uses a database-backed UID cursor per folder, so processed messages are not replayed after restart. It defaults to unread messages and leaves them unread; the optional **Mark processed mail as read** setting changes that. Email body text is placed in `msg.payload`, with sender, recipients, subject, folder, UID, HTML, and attachment metadata in `msg.email`. Oversized messages are skipped and logged. Failed executions are retried on the next poll, so downstream actions should be safe to repeat. **Email Out** sends `msg.payload` as text or HTML through SMTP and forwards the delivery result in `msg.emailResult`.

Email credentials stay in environment variables. Set `IMAP_HOST`, `IMAP_USER`, `IMAP_PASSWORD` for Email In, and `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` for Email Out. Hosts, ports, and the names of credential environment variables can be changed in node settings. No email account credentials are required until an email node is activated or run. SMTP defaults to port 587 with required STARTTLS; IMAP defaults to port 993 with TLS. Email In supports password-based IMAP accounts, and Email Out supports authenticated or unauthenticated SMTP servers.

The bundled `@wflow/file-csv` plugin is available in the node library automatically. File Read loads a UTF-8 or base64 file into `msg.payload`. File Write writes `msg.payload` as text or JSON and can append or create directories. Both use paths relative to `WFLOW_FILES_DIR` (default `data/files`); paths can contain `{{msg.filename}}` style placeholders and cannot escape this directory. CSV Parser converts text in `msg.payload` to rows of objects (or arrays when headers are off). It supports quoted fields, embedded newlines, and custom one-character delimiters. Connect **File Read → CSV Parser** to parse a file.

The bundled `@wflow/exec-ssh` plugin adds **Exec** and **SSH** to the node library. Exec runs its configured shell command on the Bun server. SSH runs its configured command on a remote host. Both put stdout in `msg.payload` and include the exit code, stderr, and duration in `msg.exec` or `msg.ssh`. Both can send the incoming payload to stdin, time out after a configured interval, and fail the workflow step on a non-zero exit code.

SSH reads a password, private key, and optional key passphrase from the environment variable names entered in node settings; the secret values are not stored in the workflow. Configure a known `SHA256:...` SSH host key fingerprint so the node can verify the server before authentication. The private key variable may contain a PEM key with literal `\n` line breaks. The plugin source is in [`plugins/bundled/exec-ssh`](plugins/bundled/exec-ssh).

The bundled [`@wflow/websocket` plugin](plugins/bundled/websocket) adds **WebSocket In**, **WebSocket Out**, and **WebSocket Client**. WebSocket In accepts connections at `/ws/<path>` and starts a recorded execution for each message. It can parse JSON and optionally require a token from an environment variable, supplied as a Bearer header or `?token=` query parameter. WebSocket Out sends `msg.payload` back to the incoming connection by default; set its WebSocket In node ID and enable broadcast to send to all clients on that input. WebSocket Client connects to a `ws://` or `wss://` URL when it receives a message, sends `msg.payload`, and either waits for the first reply or returns after sending. Each incoming message and node step appears in execution history.

The bundled [`@wflow/openai` plugin](plugins/bundled/openai) adds an **OpenAI** node. Set `OPENAI_API_KEY` in the server environment or put the key in Secret Vault and enter `vault:name` in the node. Configure a model, optional instructions, and a prompt; `{{msg.payload}}` and other `{{msg.path}}` placeholders insert values from the incoming message. The node calls the Responses API without storing the response on OpenAI, writes generated text to `msg.payload`, and writes response ID, model, status, and usage to `msg.openai`. The default model is `gpt-5.5`; change it to a model available to your API project.

The bundled [`@wflow/redis` plugin](plugins/bundled/redis) adds **Redis** and **Redis Subscriber** nodes. Set `REDIS_URL` to a `redis://` or `rediss://` URL, or store the URL in Secret Vault and enter `vault:name`. A credential-free local URL can also be entered directly. Redis supports **get**, **set**, **delete**, **increment**, and **publish**; the key/channel supports `{{msg.topic}}` and other message placeholders. Set and publish send `msg.payload` as text or JSON. Get writes the fetched value to `msg.payload` (or `null` if missing) and can parse JSON. Other operations keep `msg.payload` and add their result to `msg.redis`. Each operation opens and closes its own connection.

Redis Subscriber is an input node. Enter one or more comma/newline-separated channels and optionally enable Redis pattern subscriptions (for example, `orders:*`). Deploying the workflow opens a dedicated subscription connection. Each received message starts a recorded execution with the channel in `msg.topic`, the value in `msg.payload`, and subscription details in `msg.redis`; JSON values are parsed when enabled. Stopping or redeploying the workflow closes the connection. Redis Pub/Sub does not retain messages while the workflow is offline, so use a stream or queue when delivery must survive disconnections.

## Custom nodes

Use **Manage plugins → Create custom node** in the editor. Give it a `custom-` type ID, a label, optional editor fields, and JavaScript. A handler receives `msg`, saved `config`, a per-node `context` Map, `send(port, msg)`, and `log(value)`. Returning a message sends it to output 1. Returning `null` stops it. An editor field JSON array can look like:

```json
[{"key":"prefix","label":"Prefix","type":"text","default":"Hello"}]
```

The node's saved properties are available to package handlers through `context.config`.

An npm plugin has a `package.json` with `"wflow": { "entry": "./index.cjs" }`. The entry exports `nodes`, each containing a `definition` (the same metadata as a built-in node) and a `run(message, context)` handler. Input plugins can also provide `start({ workflowId, node, emit, log, getSecret })`, returning a function that closes their resources when the workflow stops. See [`examples/uppercase-plugin`](examples/uppercase-plugin) and the bundled [`redis` plugin](plugins/bundled/redis). Publish a package to npm, then install its package name in **Manage plugins**. Wflow installs packages into the local `plugins/` directory and loads them into the palette.

Plugins, Function nodes, and custom JavaScript execute with the Bun server's permissions. The server binds to loopback by default. Add authentication and network isolation before exposing it beyond a trusted local machine.

## API

The editor uses `/api/bootstrap`, `/api/automations`, `/api/workflows`, `/api/workflows/:id`, `/api/workflows/:id/deploy`, `/api/workflows/:id/stop`, `/api/workflows/:id/inject/:nodeId`, `/api/workflows/:id/executions`, `/api/executions/:id`, `/api/email/folders`, `/api/logs`, `/api/plugins/install`, `/api/custom-nodes`, and `/api/secrets`. Secret API responses never include stored values. The workflow and node schema lives in `src/shared.ts`.

## Development

```sh
bun test
bun run build
```

This is a Node-RED-inspired engine, not a drop-in Node-RED runtime. Node-RED's `.js` + `.html` packages and exported flow format need an adapter to run here; Wflow plugins use the package format above.
