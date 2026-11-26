# Rulith Brain Agent

Rulith Brain Agent works on tasks you give it using the model and memory of [Rulith Brain](https://github.com/rulith-dev/rulith-brain).
Open it in its own desktop window or use the portable version in your browser. Brain can run on the same PC or on
another computer on your network.

## What it does

- **Work across conversations.** The Agent sends new messages and task results to Brain. Later conversations
  in the Agent or in Brain's Chat can draw on the same memory.
- **Research a question.** The Agent can search Wikipedia without an account, read a web page by its address
  and use the passages it finds in its answer. You can also choose your own search service.
- **Use a Brain anywhere on your network.** Point the Agent at Brain on this PC or on another computer, with the
  access key Brain gives you.
- **Stay up to date.** The desktop app installs new versions when you choose to; the portable version tells you
  when one is out.

## Get it

Start Rulith Brain and load its model. Choose a Windows download from [Releases](https://github.com/rulith-dev/rulith-brain-agent/releases/latest).

- **Desktop app.** Run `Rulith-Brain-Agent-Setup-<version>.exe`, then open Rulith Brain Agent from the Start menu.
- **Portable version.** Unpack `rulith-brain-agent-<version>.zip` into a folder with a short path. Run `start.cmd`
  to open the Agent in your browser. Node.js is included.

The installers are not yet code-signed: if Microsoft Defender SmartScreen shows "Windows protected your PC", check
the file name and the SHA-256 listed with the release, then choose **More info** and **Run anyway**.

## Connect to Brain

On the same PC there is nothing to set: the Agent finds Brain by itself, at the port Brain is set to use
(`http://127.0.0.1:8091` by default).

To use Brain on another computer, open Brain's **Settings** there, allow other devices on the local network and
note the address and access key it shows. In the Agent, open **Connection**, enter that address (for example
`http://192.168.1.20:8091`) and the key, then select **Save and connect**.

The Agent chooses its connection in this order:

1. The address and key saved in **Connection** (desktop and portable share them). **Use automatic settings**
   removes them.
2. The address given with `--server` or in `RULITH_MEMORY_SERVER`, with its key in `RULITH_MEMORY_KEY`.
3. Brain on this PC, read again at every connection attempt, so a changed port applies after Brain restarts.

The Agent says which problem it meets: Brain cannot be reached at the address, the access key is missing or wrong,
or Brain is still loading its model (the Agent then waits and connects when it is ready).

## Updates

The desktop app checks for a new version when it starts and once a day while it is open. When one is available,
it shows the release notes; select **Update and restart** to install it, or **Later** to keep working. Every update
is checked against the publisher's signature before it is installed. The portable version checks when it starts
and links to the download.

Desktop 0.2.0 has no updater: install 0.2.4 or later once by hand.

## Run from source

With Node.js 22.19 or newer:

```
npm install
npm start
```

| Option | What it controls |
|---|---|
| `--server <url>` | Brain's address when none is saved in **Connection**. The address may also come first, alone. |
| `--learn-research on\|off` | Learn from research (default on). The same switch is on the Agent's own page. |
| `--home <folder>` | Folder for the Agent's profile, connection settings and transcripts (default `~/.rulith-brain-agent`). |
| `--port N`, `--no-open` | Set the page's port or leave the browser closed at startup. |

## Web search

| `RULITH_BRAIN_SEARCH` | Search service | Configuration |
|---|---|---|
| `wikipedia` (the default) | Wikipedia. A query in Chinese searches the Chinese edition first. | Ready to use |
| `searxng` | A SearXNG instance with JSON results enabled. | Set `RULITH_BRAIN_SEARXNG_URL` to the instance address. |

By default the Agent uses the search service selected under **Settings** in Rulith Brain on this PC. The
environment variables above override that choice for the Agent. Queries go to the selected service.

## What it keeps where

Rulith Brain manages the memory. The Agent keeps its profile, connection settings and transcripts in
`~/.rulith-brain-agent` or the folder you choose with `--home`; a saved access key is never shown again. Its page
and forwarder listen on `127.0.0.1`. The address printed at startup includes the page's access key.

## How it speaks to Brain

The Agent has no channel of its own. It speaks to Brain by the
[Rulith Memory Protocol](https://github.com/rulith-dev/rulith-brain/blob/main/protocol/rulith-memory-protocol.md),
on the path Brain offers to every program for it, `POST /v1/brain/chat/completions` (with `GET /v1/brain/models`):
it sends what is new in a conversation, and Brain has the rest. When Brain asks for an access key, every request
carries it as `Authorization: Bearer <key>`. What the Agent can do with Brain, any other program can do the same way.

## How it is made

| File or folder | Role |
|---|---|
| `start.mjs` | Finds Brain and starts the local forwarder and the Agent's web interface. |
| `memory-transport.mjs` | Forwards chat requests from the Agent to Brain. |
| `brain-core.mjs` | Prepares each turn for Brain and handles its response. |
| `capacity.mjs` | Reads the device estimate and the licence size Rulith Brain keeps on this PC, for the capacity line and the page's context meter (a Brain on this PC only). |
| `research-learn.mjs` | Cleans the pages read on the web for a Brain that offers programs a learn queue. |
| `system-proxy.mjs` | Windows' proxy setting, handed to the Agent's process. |
| `rulith-brain-web/` | The web search (Wikipedia, a SearXNG address) as a search provider for dsh. |
| `rulith-brain-ui/` | The page's name and mark. |
| `brain-panel.html` | Shows the connection to Brain, settings and available source passages. |
| `memory-agent.cordis.yml` | The changes to dsh's web profile. |
| `test/` | Agent tests and their fixtures. |
| `tools/pack.mjs` | Builds the portable Windows package (`npm run package`) with every third-party licence text. |
| `desktop/` | The Tauri shell that starts the Agent, shows its page in a desktop window, stops it when the window closes and installs updates. |
| `tools/desktop.mjs` | Builds the desktop setup with `npm run desktop`. Requires Rust and the Tauri CLI (`npm i -D @tauri-apps/cli` or `--tauri <its tauri.js>`). |

```
npm test
```

## Attribution

It is open source (MIT). It is DeepSeek Harness (dsh, the npm package `@deepseek-ai/dsh`, MIT) with its web app, plus a
small forwarder that sends each turn to the memory instead of the whole conversation.

## Licence

MIT: [LICENSE](LICENSE). DeepSeek Harness, Node.js and the other packages the Agent runs on keep their own licences;
the Windows package lists every one of them in its `THIRD-PARTY-NOTICES.txt`.

Rulith Brain itself - the app and its engine - is a separate, closed-source product under its own licence agreement.

## Questions and problems

Report problems on [GitHub Issues](https://github.com/rulith-dev/rulith-brain-agent/issues), or write to contact@rulith.ai.
