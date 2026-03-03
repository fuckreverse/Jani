# Instrumentation Commands
Relevant source files
- [node_test/instDirTests.js](https://github.com/Samsung/jalangi2/blob/28d2181c/node_test/instDirTests.js)
- [src/js/commands/esnstrument_cli.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/commands/esnstrument_cli.js)
- [src/js/commands/instrument.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/commands/instrument.js)
- [src/js/instrument/instUtil.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/instUtil.js)
- [tests/rewriteHTML.js](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/rewriteHTML.js)

This document covers the offline instrumentation commands provided by Jalangi2 for pre-processing JavaScript and HTML files before analysis. These commands transform source code by injecting callback hooks that enable dynamic analysis during execution.

For information about runtime analysis execution, see [Main Commands](/Samsung/jalangi2/3.1-main-commands). For the core instrumentation engine that these commands utilize, see [Instrumentation Engine](/Samsung/jalangi2/2.1-instrumentation-engine).

## Overview

Jalangi2 provides two primary offline instrumentation commands that pre-process source code before execution:
CommandPurposeInputOutput`instrument.js`Directory/batch instrumentationDirectory or list of filesInstrumented copy of entire directory structure`esnstrument_cli.js`Single file instrumentationSingle JS or HTML fileSingle instrumented file
Both commands utilize the core [esnstrument.js1-520](https://github.com/Samsung/jalangi2/blob/28d2181c/esnstrument.js#L1-L520) engine to perform AST transformation and callback injection.

## Directory Instrumentation Workflow

The `instrument` command processes entire directory structures, creating instrumented copies while preserving the original file organization.

```
HTML Processing

JavaScript Processing

File Processing

.js

.html

other

Input Directory/Files

ArgumentParser

Parse Options

Copy Directory Structure

transform() Function

File Extension

instrumentJS()

rewriteHtml()

Direct Copy

InstrumentJSStream

sandbox.instrumentCode()

applyASTHandler()

Write Instrumented JS

Write Original Copy

HTMLRewriteStream

proxy.rewriteHTML()

Inject Jalangi Runtime

Write Instrumented HTML
```

Sources: [src/js/commands/instrument.js68-455](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/commands/instrument.js#L68-L455)[src/js/commands/instrument.js337-363](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/commands/instrument.js#L337-L363)[src/js/commands/instrument.js250-317](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/commands/instrument.js#L250-L317)

### Core Directory Instrumentation Functions

The `instrument` function serves as the main entry point, coordinating the instrumentation process:

```
Transform Pipeline

JavaScript

HTML

Other

instrument() function

Setup & Validation

copyJalangiRuntime()

Handle extraAppScripts

ncp() with transform

transform() callback

Check file type

instrumentJS()

rewriteHtml()

readStream.pipe(writeStream)
```

Sources: [src/js/commands/instrument.js68-455](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/commands/instrument.js#L68-L455)[src/js/commands/instrument.js369-386](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/commands/instrument.js#L369-L386)[src/js/commands/instrument.js426-440](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/commands/instrument.js#L426-L440)

### Command Line Interface

The `instrument.js` command supports extensive command-line options for controlling instrumentation behavior:
OptionPurposeDefault`--exclude`Exclude files containing substringNone`--only_include`Include only specified path prefixesNone`--instrumentInline`Instrument inline HTML scriptsfalse`--analysis`Analysis scripts to injectNone`--copy_runtime`Copy Jalangi runtime to outputfalse`--extra_app_scripts`Additional scripts to injectNone
Sources: [src/js/commands/instrument.js458-498](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/commands/instrument.js#L458-L498)

## Single File Instrumentation

The `esnstrument_cli` command processes individual JavaScript or HTML files, providing fine-grained control over single-file instrumentation.

```
HTML Processing

JavaScript Processing

endsWith('.js')

HTML

Command Line Arguments

ArgumentParser

Read Input File

File Extension Check

sandbox.instrumentCode()

applyASTHandler()

Write Instrumented File

Write Source Map

parse5 HTML Parser

htmlVisitor callbacks

proxy.rewriteHTML()

rewriteInlineScript()

Inject Runtime Scripts

Write Instrumented HTML
```

Sources: [src/js/commands/esnstrument_cli.js114-255](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/commands/esnstrument_cli.js#L114-L255)[src/js/commands/esnstrument_cli.js190-204](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/commands/esnstrument_cli.js#L190-L204)[src/js/commands/esnstrument_cli.js206-254](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/commands/esnstrument_cli.js#L206-L254)

### HTML Processing Pipeline

The HTML instrumentation process involves sophisticated rewriting to inject runtime dependencies and instrument inline scripts:

```
Inline Script Processing

Runtime Injection

Node Visitors

HTML Input File

parse5.parseFragment()

rewriteOptions with onNodeVisited

head tag visitor

body tag visitor

script tag visitor

Inject charset meta tag

getInlinedScripts()

getFooterString() for results GUI

Remove integrity attributes

rewriteInlineScript() callback

MD5 hash filename generation

instrumentCode() on inline script

Write original, instrumented, sourcemap
```

Sources: [src/js/commands/esnstrument_cli.js218-244](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/commands/esnstrument_cli.js#L218-L244)[src/js/commands/esnstrument_cli.js78-108](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/commands/esnstrument_cli.js#L78-L108)[src/js/commands/esnstrument_cli.js83-84](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/commands/esnstrument_cli.js#L83-L84)

## Common Instrumentation Features

Both instrumentation commands share common functionality through the `instUtil` module and core instrumentation engine.

### Runtime Script Injection

The instrumentation commands inject necessary runtime scripts into HTML files using several strategies:
StrategyDescriptionUse CaseInline ScriptsEmbed script content directlyDefault for offline instrumentationCDN LinksReference scripts from CDN URLWhen `--cdn` option specifiedLocal File ReferencesReference local copies of runtime filesWhen `--copy_runtime` specified
Sources: [src/js/instrument/instUtil.js47-95](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/instUtil.js#L47-L95)[src/js/instrument/instUtil.js164-174](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/instUtil.js#L164-L174)

### AST Handler Integration

Both commands support custom AST processing through the `astHandler` mechanism:

```
instrumentCode() result

astHandler function

Generated AST info object

Inject J$.ast_info into code

Final instrumented code
```

Sources: [src/js/instrument/instUtil.js134-142](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/instUtil.js#L134-L142)[src/js/commands/instrument.js502-504](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/commands/instrument.js#L502-L504)[src/js/commands/esnstrument_cli.js158-161](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/commands/esnstrument_cli.js#L158-L161)

### Source Map Generation

Both commands generate source maps to maintain debugging capabilities after instrumentation:

- JavaScript files: `.json` source map files created alongside instrumented files
- Inline scripts: Source maps written to output directory with MD5-based naming
- Source map options: `--inlineIID` and `--inlineSource` control embedded metadata

Sources: [src/js/commands/instrument.js304](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/commands/instrument.js#L304-L304)[src/js/commands/esnstrument_cli.js202](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/commands/esnstrument_cli.js#L202-L202)[src/js/commands/esnstrument_cli.js104](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/commands/esnstrument_cli.js#L104-L104)