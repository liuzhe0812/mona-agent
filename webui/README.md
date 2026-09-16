# mona webui

The browser front-end for the mona gateway. It is built with Vite + React 19 +
TypeScript + Tailwind 3 + shadcn/ui, talks to the gateway over the WebSocket
multiplex protocol, and reads session metadata from the embedded REST surface
on the same port.

For the project overview, install guide, and general docs map, see the root
[`README.md`](../README.md).

The production UI is embedded in the Mona desktop app by Tauri. This source
tree also supports a local Vite server for frontend development; the Python
Gateway does not serve a standalone web client.

## Layout

```text
webui/                 source tree (this directory)
webui/dist/            local preview build
src-tauri/dist/        production build embedded by Tauri
```

## Develop the WebUI (Vite HMR)

### 1. Install mona from source

From the repository root:

```bash
pip install -e .
```

> Python packaging does not build or bundle the frontend.

### 2. Enable the WebSocket channel

In `~/.mona/config.json`:

```json
{ "channels": { "websocket": { "enabled": true } } }
```

### 3. Start the gateway

In one terminal:

```bash
python -m mona gateway
```

### 4. Start the WebUI dev server

In another terminal:

```bash
cd webui
npm --prefix office-editor ci  # first time only: install editor dependencies
npm run dev
```

Then open `http://127.0.0.1:9527`.

The main Vite server mounts the independent Office editor Vite build at
`/office-editor/`, so there is no second editor server to start. `npm run dev`
also starts the same integrated editor middleware used by `cargo tauri dev`.

By default the dev server proxies `/api`, `/webui`, `/auth`, and WebSocket traffic to `http://127.0.0.1:8765`.

If your gateway listens on a non-default port, point the dev server at it:

```bash
mona_API_URL=http://127.0.0.1:9000 bun run dev
```

## Build

```bash
cd webui
npm run build        # local preview output in webui/dist
npm run preview      # preview that build with Vite
npm run build:tauri  # production output in src-tauri/dist
```

Both builds include the Office editor. Python wheels contain backend code and
resources only; Tauri embeds the production frontend.

## Test

```bash
cd webui
bun run test
```

## Acknowledgements

- [`agent-chat-ui`](https://github.com/langchain-ai/agent-chat-ui) for UI and
  interaction inspiration across the chat surface.
