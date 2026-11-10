# Firefox Claude MCP

Let Claude control your own Firefox: the real browser, with your tabs and sign-ins. Works with Claude Code and the Claude desktop app.

```
Claude  <--MCP over stdio-->  server/index.js  <--WebSocket on 127.0.0.1:8765-->  Firefox extension
```

There are two parts, and you need both:

- `server/` is a Node MCP server. Claude starts it and calls its tools.
- `extension/` is a Firefox add-on ("MCP Browser Bridge") that connects to the server and carries out each call in your tabs.

This is an independent project. It is not affiliated with Anthropic or Mozilla.

## Want a one-click install?

Right now the add-on is not listed on addons.mozilla.org, so you have to load it yourself (steps below). **If you would use this and want a normal "Add to Firefox" install, please [open an issue](https://github.com/Sasi-Praneeth-Reddy/Firefox-Claude-MCP/issues) saying so, or add a 👍 to an existing one.** If enough people ask, I will publish it as a public add-on.

## Setup

Requires Node 18 or newer and Firefox 109 or newer.

### 1. Get the code and install the server

```bash
git clone https://github.com/Sasi-Praneeth-Reddy/Firefox-Claude-MCP.git
cd Firefox-Claude-MCP/server
npm install
```

### 2. Load the extension in Firefox

**Quick way (temporary):**

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...** and pick `extension/manifest.json`.

Firefox removes a temporary add-on when it restarts, so you repeat this each session.

**Permanent way (sign your own copy):**

Firefox only keeps add-ons that Mozilla has signed. Signing for personal use is free and takes a few minutes.

1. In `extension/manifest.json`, change the `"id"` under `gecko` to something of your own, for example `mcp-bridge-yourname@local`. Every signed add-on needs an ID nobody else has registered, and the one in this repo is already taken.
2. Zip the two files inside `extension/` (the files themselves, not the folder).
3. Sign in at the [Add-on Developer Hub](https://addons.mozilla.org/developers/), click **Submit a New Add-on**, and choose **On your own** as the distribution method.
4. Upload the zip. Answer **No** when asked whether you need to submit source code.
5. When the version shows **Approved**, download the `.xpi` and install it from `about:addons` (gear icon, **Install Add-on From File**).

### 3. Register the server with Claude

Use the full path to `server/index.js` on your machine.

**Claude Code:**

```bash
claude mcp add firefox -- node /absolute/path/to/Firefox-Claude-MCP/server/index.js
```

**Claude desktop app:** add this to `claude_desktop_config.json`.

```json
{
  "mcpServers": {
    "firefox": {
      "command": "node",
      "args": ["/absolute/path/to/Firefox-Claude-MCP/server/index.js"]
    }
  }
}
```

The file is at:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

On Windows, double every backslash in the path, for example `C:\\Users\\you\\Firefox-Claude-MCP\\server\\index.js`.

Quit the desktop app completely before editing the file (on Windows, from the system tray), because the app rewrites this file and can overwrite an edit made while it is running. Then reopen it.

### 4. Try it

Ask Claude: "List my Firefox tabs." The extension's toolbar badge shows **on** once Claude has started the server.

## Tools

| Tool | What it does |
| --- | --- |
| `tabs_list` | Every open tab with its id, title and URL |
| `tab_create`, `tab_close`, `tab_activate` | Open, close, or bring a tab to the front |
| `navigate` | Load a URL, or `back` / `forward` / `reload` |
| `get_page_text` | Readable text of the page |
| `read_page` | Visible links, buttons and inputs as numbered refs |
| `click` | Click an element by ref or CSS selector |
| `type` | Fill an input or editable area, pick a `<select>` option, optionally submit |
| `scroll` | Scroll the page, or bring an element into view |
| `screenshot` | JPEG of the tab's visible area |
| `run_javascript` | Run code in the page and return the result |

Tools that take a `tabId` use the active tab when it is omitted.

## Using several Claude apps at once

Each Claude app starts its own copy of the server. The first copy holds the Firefox connection and later copies share it, so Claude Code and the desktop app can both be open. They all drive the same Firefox, so two sessions acting on the same tab at once will get in each other's way.

## Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `FIREFOX_MCP_PORT` | `8765` | WebSocket port. Change `PORT` at the top of `extension/background.js` to match. |
| `FIREFOX_MCP_TIMEOUT_MS` | `45000` | How long to wait for Firefox to answer a call |

## Security

This gives Claude the same access to your signed-in sites that you have. Consider a separate Firefox profile for it.

- The server listens on `127.0.0.1` only. It accepts the extension (a `moz-extension://` origin) and other copies of itself, and rejects connections from web pages.
- Page content can contain text written to steer an AI. Review what Claude is about to do on sites where a wrong click costs something, such as payments, sending messages, or deleting data.
- `run_javascript` can do anything a content script can. Remove that tool from `server/index.js` if you don't want it.
- The extension sends page text and tab URLs to the local server, which passes them to Claude. It sends nothing anywhere else.

## Troubleshooting

- **The badge never shows "on".** The server only runs while Claude Code or the Claude desktop app is running and has loaded it. Check that first.
- **"firefox" is missing from the desktop app's connectors.** The config edit did not take. Quit the app fully, check the entry is still in the file, and check the JSON is valid.
- **The desktop app says the server failed to start.** It may not find `node`. Put the full path to the Node executable in `"command"`.
- **A tool fails on one page.** Firefox blocks extensions on `about:` pages, `addons.mozilla.org`, and a few other protected sites.

## Limits

- Clicks and typing are simulated DOM events, which a small number of sites ignore.
- No file uploads, download handling, or access inside cross-origin iframes yet.
- Uses Manifest V2, which Firefox still supports.

Bug reports and pull requests are welcome.
