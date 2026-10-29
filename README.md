<p align="center">
  <img src="docs/assets/banner.svg" alt="Jani — JavaScript dynamic analysis. Instrument, capture, and explore runtime behavior." width="100%" />
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A5%2022-43853d" alt="Node.js 22 or newer" />
  <img src="https://img.shields.io/badge/JavaScript-ESM-f7df1e" alt="JavaScript ESM" />
  <a href="LICENSE.txt"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache 2.0" /></a>
</p>

# Understand what your JavaScript actually does.

**Jani is a JavaScript dynamic analysis framework for debugging, reverse engineering, and building custom runtime analyses.** It instruments source code to record execution, then helps you follow function calls, inspect variable changes, and trace how values reach an output—in Node.js and browsers.

Use the **CLI** to capture and inspect traces, the **local Trace Analyzer** to explore them visually, or **MCP tools** to make that evidence available to an AI assistant.

[Quick start](#quick-start) · [Trace Analyzer](#explore-traces-visually) · [Custom analyses](#build-your-own-analysis) · [Documentation](#documentation)

## What can you do with Jani?

| Your question | Jani helps you investigate with |
| --- | --- |
| Which functions produced this result? | Execution events, source locations, and reconstructed call graphs |
| Where did this value come from? | Variable lifetimes, data flow, taint tracking, and backward slicing |
| What does this unfamiliar or obfuscated script do? | Optional preprocessing, runtime traces, loop analysis, and object mutation tracking |
| Which code runs most often? | Line execution counts and hot path analysis |
| Does this code resemble a known crypto or signing routine? | Pattern, crypto, and signature analysis in Trace Analyzer |
| Can I detect my own runtime patterns? | Composable hooks for reads, writes, properties, calls, operators, and more |

Crypto and algorithm detection provide investigative clues; validate conclusions against the trace and source. Traces describe the paths exercised by your inputs.

## Why Jani?

- **A complete investigation workflow.** Go from source to captured execution to CLI reports, a local web UI, or MCP-assisted exploration.
- **Source-level visibility.** Instruction IDs map runtime events back to source locations, so you can connect behavior to code.
- **Scope-aware data tracking.** Lexical scope IDs, shadow frames, and async context hooks help distinguish variables and execution contexts.
- **Selective instrumentation.** Plugin hook analysis and static def-use decisions select which hooks to emit, including lightweight variable reads. Actual overhead depends on the program and enabled analysis.
- **Node.js and browser capture.** Use file output on Node.js and WebSocket or IndexedDB backends in browsers.
- **Extend the analysis.** ESM modules, Babel-based instrumentation, runtime plugins, and offline analyzer plugins provide several integration points.

## Quick start

Requires **Node.js 22+** and **npm 10+**. Run these commands from the repository root after cloning.

```bash
git clone https://github.com/fuckreverse/Jani.git
cd Jani
npm install
```

### Capture your first execution trace

Create a tiny script, instrument it, and run it:

```bash
node --input-type=module -e "import { writeFileSync } from 'node:fs'; writeFileSync('demo.js', 'function double(x) { return x * 2; }\nconsole.log(double(21));\n');"
node bin/jalangi.mjs instrument-and-run --execution-trace --trace-file demo.bin demo.js
```

The script prints `42`. Jani also writes `demo.bin` and `demo.smap.json`: the recorded execution and its source mapping.

Decode the trace into structured events with source locations:

```bash
node tools/trace-parse.mjs demo.bin --smap demo.smap.json > demo.events.ndjson
```

For rendering, filtering, call trees, and variable timelines, see the [offline analysis guide](docs/Offline-Analysis-Tools.md). The parser accepts binary and legacy text traces; downstream tools have format-specific options described in that guide.

### Instrument for the browser

```bash
node bin/jalangi.mjs instrument --target browser --output demo.browser.js demo.js
```

Load the generated file in your browser test page. See the [CLI reference](docs/CLI-Reference.md) for capture backends, split runtimes, and module options. Always specify `--output` when you want to preserve the input: browser instrumentation otherwise defaults to replacing it.

## Explore traces visually

**Jani Trace Analyzer (JTA)** is a local web application with workspaces, an instrumentation workbench, trace collection, and analysis sessions.

Explore events, functions, data flow, loops, object mutations, value patterns, and crypto or obfuscation clues. Its MCP server exposes analysis tools to compatible AI clients.

```bash
npm install --prefix analyzer
npm install --prefix analyzer/ui
npm run analyzer:prod
```

Open [localhost:33000](http://localhost:33000). Import `demo.bin` together with `demo.smap.json` to create an analysis session, or start a workspace from your JavaScript source.

See the [Trace Analyzer guide](analyzer/README.md) for the workflow, API, development mode, and MCP configuration.

## Build your own analysis

Register only the hooks you need. This example reports variable reads:

```js
import vm from 'node:vm';
import { init, instrumentCode } from './src/instrument/esnstrument.js';
import { JalangiSandbox } from './src/runtime/JalangiSandbox.js';

const J$ = new JalangiSandbox();
J$.analysis.use({
  read(iid, name, value) {
    console.log(`${name} = ${value}`);
    return { result: value };
  },
});

init({ INSTR_READ: null });
const { code } = instrumentCode({
  code: 'var answer = 42; var result = answer + 1;',
  origCodeFileName: 'example.js',
  instCodeFileName: 'example.inst.js',
});
vm.runInNewContext(code, { J$ });
```

Start with the [plugin development guide](docs/Analysis-Development.md), [configuration reference](docs/Configuration.md), or the examples in [`src/plugins/`](src/plugins/). Included examples cover runtime checks, hook logging, coverage, and execution tracing.

## How it works

```text
JavaScript source
  → Optional preprocessing (simplification / syntax lowering)
  → Babel AST + scope and def-use analysis
  → Instrumented code + runtime hooks
  → Execute in Node.js or a browser
  → Trace + source mapping
  → CLI tools / Trace Analyzer / MCP
```

Jani builds on the instrumentation ideas of [Samsung's Jalangi2](https://github.com/Samsung/jalangi2), with an ESM codebase, a Babel-based engine, scope-aware instrumentation, and a trace analysis toolchain. Parser support for TypeScript/Flow syntax does not imply that type syntax can execute directly; prepare runnable JavaScript for the target runtime.

## Documentation

The detailed technical guides are currently primarily in Chinese.

| Guide | What you will find |
| --- | --- |
| [Documentation index](docs/README.md) | Full technical documentation map |
| [CLI reference](docs/CLI-Reference.md) | Instrument, run, capture, and browser options |
| [Instrumentation engine](docs/Instrumentation-Engine.md) | Programmatic API and transformation internals |
| [Runtime system](docs/Runtime-System.md) | Hooks, plugin dispatch, and shadow memory |
| [Analysis development](docs/Analysis-Development.md) | Implementing custom runtime analyses |
| [Preprocessing](docs/Preprocessing.md) | Simplification and syntax lowering |
| [Logging system](docs/Logger-System.md) | Trace backends and collection |
| [Offline analysis tools](docs/Offline-Analysis-Tools.md) | Parsing, rendering, filtering, and reports |
| [Trace Analyzer](analyzer/README.md) | Local web UI, analysis plugins, REST API, and MCP |

## Development

```bash
npm test                     # Core unit and integration tests
npm run test:backend         # Trace Analyzer backend tests
```

See the [testing guide](docs/Testing-System.md) for focused test commands. Bugs, reproducible trace examples, analysis plugins, and documentation improvements are welcome via [issues](https://github.com/fuckreverse/Jani/issues) and pull requests.

## License & acknowledgments

[Apache License 2.0](LICENSE.txt). Jani builds on work from Samsung Research America's Jalangi2; original code retains its authors' copyright notices.
