# Command-Line Tools
Relevant source files
- [node_test/instDirTests.js](https://github.com/Samsung/jalangi2/blob/28d2181c/node_test/instDirTests.js)
- [src/commands/direct.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/direct.js)
- [src/commands/esnstrument_cli.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/esnstrument_cli.js)
- [src/commands/instrument.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/instrument.js)
- [src/commands/jalangi.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/jalangi.js)
- [src/instrument/instUtil.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/instrument/instUtil.js)
- [tests/rewriteHTML.js](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/rewriteHTML.js)

This document covers the command-line interfaces and utilities provided by Jalangi2 for instrumenting JavaScript code and running dynamic analyses. These tools serve as the primary entry points for users to apply Jalangi2's instrumentation and analysis capabilities to their applications.

For information about developing custom analyses that work with these tools, see [Analysis Development](/Samsung/jalangi2/4-analysis-development). For details about the underlying instrumentation engine, see [Instrumentation Engine](/Samsung/jalangi2/2.1-instrumentation-engine).

## Tool Architecture Overview

Jalangi2 provides multiple command-line tools that serve different instrumentation and execution workflows:

```
Output

Supporting Infrastructure

Instrumentation Commands

Core Commands

User Entry Points

Command Line Interface

JavaScript/HTML Files

Web Applications

jalangi.js
On-the-fly Instrumentation

direct.js
Pre-instrumented Execution

instrument.js
Directory Processing

esnstrument_cli.js
Single File Processing

instUtil.js
Shared Utilities

Module._extensions['.js']
Node.js Hook

argparse
CLI Parsing

Instrumented Code

Source Maps

Analysis Results
```

Sources: [src/commands/jalangi.js1-129](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/jalangi.js#L1-L129)[src/commands/direct.js1-93](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/direct.js#L1-L93)[src/commands/instrument.js1-520](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/instrument.js#L1-L520)[src/commands/esnstrument_cli.js1-266](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/esnstrument_cli.js#L1-L266)[src/instrument/instUtil.js1-208](https://github.com/Samsung/jalangi2/blob/28d2181c/src/instrument/instUtil.js#L1-L208)

## Command Execution Flow

The tools follow different execution patterns based on when instrumentation occurs:

```
Runtime Instrumentation

Pre-instrumented

Batch Directory

Single File

JavaScript/HTML Files

Execution Mode

jalangi.js

direct.js

instrument.js

esnstrument_cli.js

Module._extensions['.js']

J$.instrumentCode()

module._compile()

Analysis Execution

require(analysis)

Module.runMain()

Batch Instrumentation

ncp() with transform

Instrumented Directory

Single File Instrumentation

Instrumented File + Source Map

J$.endExecution()
```

Sources: [src/commands/jalangi.js94-122](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/jalangi.js#L94-L122)[src/commands/direct.js60-78](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/direct.js#L60-L78)[src/commands/instrument.js442-454](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/instrument.js#L442-L454)[src/commands/esnstrument_cli.js186-255](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/esnstrument_cli.js#L186-L255)

## Core Execution Commands

### jalangi.js - Dynamic Instrumentation

The `jalangi.js` command provides on-the-fly instrumentation by hooking into Node.js's module loading system:

**Key Functions:**

- `makeInstCodeFileName()` - Generates instrumented file names with `_jalangi_` suffix
- `makeSMapFileName()` - Creates source map file names
- `Module._extensions['.js']` - Overrides JavaScript file loading to instrument code before execution
- `startProgram()` - Initializes execution with proper `process.argv` handling

**Usage Pattern:**

```
node jalangi.js --analysis path/to/analysis.js script.js [script_args...]
```

**Key Parameters:**

- `--analysis`: Analysis modules to load (can be specified multiple times)
- `--initParam`: Key-value pairs for analysis initialization
- `--inlineIID`: Include instruction ID metadata in instrumented code
- `--inlineSource`: Include original source in instrumented code

Sources: [src/commands/jalangi.js25-129](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/jalangi.js#L25-L129)[src/commands/jalangi.js94-111](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/jalangi.js#L94-L111)

### direct.js - Pre-instrumented Execution

The `direct.js` command executes already-instrumented JavaScript files without additional instrumentation:

**Key Functions:**

- `runAnalysis()` - Main execution function that loads analyses and runs the target script
- `startProgram()` - Sets up `process.argv` and calls `Module.runMain()`

**Usage Pattern:**

```
node direct.js --analysis path/to/analysis.js instrumented_script.js [script_args...]
```

This tool is useful when working with code that has been pre-instrumented using `instrument.js` or `esnstrument_cli.js`.

Sources: [src/commands/direct.js24-92](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/direct.js#L24-L92)[src/commands/direct.js37-78](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/direct.js#L37-L78)

## Instrumentation Commands

### instrument.js - Directory Processing

The `instrument.js` command performs batch instrumentation of entire directory structures:

**Key Functions:**

- `instrument()` - Main instrumentation function with comprehensive options
- `HTMLRewriteStream` - Stream processor for HTML files that injects Jalangi runtime
- `InstrumentJSStream` - Stream processor for JavaScript files
- `transform()` - File transformation dispatcher based on extension
- `copyJalangiRuntime()` - Copies Jalangi runtime files to output directory

**Core Processing:**

- Uses `ncp()` with custom transform function to copy and instrument files
- Handles HTML files by injecting script tags in `<head>` section
- Supports selective instrumentation via `--exclude` and `--only_include` options
- Can inline Jalangi runtime or copy it to a subdirectory

**Key Options:**

- `--outputDir`: Target directory for instrumented files
- `--exclude`: Skip files containing specified substring
- `--only_include`: Only instrument files matching path prefixes
- `--instrumentInline`: Instrument inline scripts in HTML
- `--copy_runtime`: Copy Jalangi runtime to `jalangiRuntime/` subdirectory
- `--extra_app_scripts`: Additional scripts to inject and instrument

Sources: [src/commands/instrument.js68-455](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/instrument.js#L68-L455)[src/commands/instrument.js160-244](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/instrument.js#L160-L244)[src/commands/instrument.js337-363](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/instrument.js#L337-L363)

### esnstrument_cli.js - Single File Processing

The `esnstrument_cli.js` command instruments individual JavaScript or HTML files:

**Key Functions:**

- `instrumentFile()` - Main entry point with argument parsing
- `rewriteInlineScript()` - Closure that returns inline script processor
- `makeInstCodeFileName()` - Creates output filename with `_jalangi_` suffix
- `createOrigScriptFilename()` - Creates backup filename with `_orig_` suffix

**Processing Logic:**

- For `.js` files: Direct instrumentation using `J$.instrumentCode()`
- For HTML files: Uses `parse5` parser with `proxy.rewriteHTML()` for inline script processing
- Generates source maps for debugging support
- Supports CDN-based script loading for web deployment

**Key Options:**

- `--out`: Output filename (defaults to adding `_jalangi_` suffix)
- `--outDir`: Directory for extracted inline scripts
- `--url`: URL metadata for source maps
- `--cdn`: CDN URL for runtime script loading instead of inlining

Sources: [src/commands/esnstrument_cli.js114-261](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/esnstrument_cli.js#L114-L261)[src/commands/esnstrument_cli.js78-108](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/esnstrument_cli.js#L78-L108)[src/commands/esnstrument_cli.js186-255](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/esnstrument_cli.js#L186-L255)

## Supporting Utilities

### instUtil.js - Shared Infrastructure

The `instUtil.js` module provides common functionality used by all command-line tools:

**Key Functions:**

- `setHeaders()` - Initializes header source list from `require("../headers").headerSources`
- `getInlinedScripts()` - Generates HTML script tags for Jalangi runtime and analyses
- `genInitParamsCode()` - Creates JavaScript code to set `J$.initParams`
- `applyASTHandler()` - Applies custom AST processing functions
- `getHeaderCodeAsScriptTags()` - Creates HTML script tags with absolute paths

**Header Management:**
The module manages a list of required JavaScript files in `headerSources` array:

- `"node_modules/esotope/esotope.js"` - JavaScript code generator
- `"node_modules/acorn/dist/acorn.js"` - JavaScript parser
- Additional headers from `require("../headers").headerSources`

**Script Injection Patterns:**

- Inline mode: Embeds all JavaScript directly in HTML
- CDN mode: Uses external URLs for script loading
- Copy mode: Copies scripts to local `jalangiRuntime/` directory

Sources: [src/instrument/instUtil.js38-44](https://github.com/Samsung/jalangi2/blob/28d2181c/src/instrument/instUtil.js#L38-L44)[src/instrument/instUtil.js47-95](https://github.com/Samsung/jalangi2/blob/28d2181c/src/instrument/instUtil.js#L47-L95)[src/instrument/instUtil.js120-142](https://github.com/Samsung/jalangi2/blob/28d2181c/src/instrument/instUtil.js#L120-L142)[src/instrument/instUtil.js164-174](https://github.com/Samsung/jalangi2/blob/28d2181c/src/instrument/instUtil.js#L164-L174)

## Command-Line Interface Patterns

All tools use the `argparse` library with consistent patterns:
ParameterPurposeUsed By`--analysis`Analysis module pathsjalangi.js, direct.js, instrument.js, esnstrument_cli.js`--initParam`Analysis initialization (key:value)jalangi.js, direct.js, instrument.js, esnstrument_cli.js`--inlineIID`Include instruction ID metadatajalangi.js, instrument.js, esnstrument_cli.js`--inlineSource`Include original sourcejalangi.js, instrument.js, esnstrument_cli.js`--astHandlerModule`Custom AST processingjalangi.js, instrument.js, esnstrument_cli.js
**Argument Processing:**

- `parser.parseArgs()` - Standard argparse processing
- `script_and_args` with `nargs: argparse.Const.REMAINDER` - Captures target script and its arguments
- `args.script_and_args.shift()` - Extracts target script from argument list

Sources: [src/commands/jalangi.js25-44](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/jalangi.js#L25-L44)[src/commands/direct.js24-35](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/direct.js#L24-L35)[src/commands/instrument.js458-511](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/instrument.js#L458-L511)[src/commands/esnstrument_cli.js115-149](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/esnstrument_cli.js#L115-L149)