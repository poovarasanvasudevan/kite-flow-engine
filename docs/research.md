# Research and design notes

This project uses Node-RED as a product model while keeping its own runtime and plugin API.

## What the reference architecture says

- Node-RED separates each node's runtime JavaScript from editor metadata and edit controls in HTML. Its runtime registers a node type, handles incoming messages, and sends outgoing messages. [Creating your first node](https://nodered.org/docs/creating-nodes/first-node), [runtime JavaScript](https://nodered.org/docs/creating-nodes/node-js), [editor HTML](https://nodered.org/docs/creating-nodes/node-html).
- Node-RED packages declare their node files in a `node-red` section of `package.json`, and are normally installed as npm packages. [Packaging guide](https://nodered.org/docs/creating-nodes/packaging), [adding nodes](https://nodered.org/docs/getting-started/adding-nodes).
- Bun runs TypeScript directly and supports many Node.js APIs and npm packages, with compatibility still evolving. This is why Wflow uses Bun's HTTP server and standard `fs`, `path`, and `module` APIs, with explicit tests for its message router. [Bun runtime](https://bun.sh/docs/runtime), [Node.js compatibility](https://bun.sh/docs/runtime/nodejs-compat), [Bun.serve](https://bun.sh/reference/bun/serve).
- React Flow supports custom node components, connection handles, and controlled node and edge state. Wflow stores the handle ID as its output port number so the editor and runtime share the same graph. [Custom nodes](https://reactflow.dev/learn/customization/custom-nodes), [handles](https://reactflow.dev/learn/customization/handles), [interactivity](https://reactflow.dev/learn/concepts/adding-interactivity).

## Decisions for this implementation

1. Keep one JSON schema for the editor and runtime. Node definitions supply palette metadata, fields, defaults, and output counts; handlers supply behavior.
2. Separate saved drafts from deployed snapshots. A running flow changes only when the user deploys it. Snapshots persist to disk and restore on server startup.
3. Start with the most useful core patterns: injection, debugging, message transformation and routing, templates, delays, JSON, outbound HTTP, and HTTP endpoints. This is an intentionally scoped core set rather than a claim of full Node-RED feature coverage.
4. Use a native Wflow npm package manifest (`wflow.entry`) for plugins. Node-RED `.html` editor scripts and `RED.nodes.registerType` expect Node-RED's editor and runtime APIs, so loading them directly would give misleading compatibility. A future adapter can translate those APIs.
5. Treat Function and plugin code as trusted operator code. It runs in the Bun process and has server permissions. The default bind address is loopback; a hosted deployment would need authentication, per-user authorization, secrets handling, and stronger execution isolation.

## Next compatibility milestones

- Node-RED flow JSON import/export mapping, including tabs and configuration nodes.
- An adapter for a documented subset of `RED.nodes.registerType`, message callbacks, and editor field metadata.
- More core nodes (such as Join, Split, Catch, Status, and persistent context), plus subflows and versioned deployments.
- Production controls for concurrent messages, queue limits, retries, auditing, and credential storage.
