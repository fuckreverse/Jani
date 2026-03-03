# Main Commands
Relevant source files
- [src/commands/direct.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/direct.js)
- [src/commands/jalangi.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/jalangi.js)

This section documents the two primary entry points for running dynamic analysis with Jalangi2: `jalangi.js` and `direct.js`. These commands provide different approaches to executing JavaScript code under analysis - one with on-the-fly instrumentation and one with pre-instrumented code.

For offline code instrumentation utilities, see [Section 3.2](/Samsung/jalangi2/3.2-instrumentation-commands). For testing and utility scripts, see [Section 3.3](/Samsung/jalangi2/3.3-utility-scripts).

## Overview

Jalangi2 provides two main commands for dynamic analysis execution:
CommandPurposeInstrumentationUse Case`jalangi.js`On-the-fly analysisAutomatic during executionDevelopment, debugging, simple analysis`direct.js`Pre-instrumented analysisCode must be pre-instrumentedProduction, performance-critical analysis
Both commands use the same analysis framework and callback system, but differ in when and how code instrumentation occurs.

## Command Architecture

```
On-the-fly

Pre-instrumented

User

Choose Command

jalangi.js Frontend

direct.js Frontend

argparse.ArgumentParser

argparse.ArgumentParser

Module._extensions['.js'] Override

Load Analysis Modules

J$.instrumentCode()

Write .js and .json files

module._compile()

startProgram()

Hack process.argv

process.on('exit')

Module.runMain()

JavaScript Execution

J$ Runtime Callbacks

Analysis Hooks
```

Sources: [src/commands/jalangi.js1-129](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/jalangi.js#L1-L129)[src/commands/direct.js1-93](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/direct.js#L1-L93)

## jalangi.js - On-the-fly Analysis

The `jalangi.js` command provides dynamic analysis with automatic code instrumentation. It intercepts JavaScript module loading to instrument code transparently.

### Command Line Interface

```
jalangi.js [options] script.js [script_args...]
```

**Key Arguments:**

- `--analysis`: Path to analysis file (can be specified multiple times)
- `--initParam`: Analysis initialization parameters as `key:value` pairs
- `--inlineIID`: Include inline IID mapping in instrumented files
- `--inlineSource`: Include original source code in instrumented files
- `--astHandlerModule`: Custom AST handler module path

### Instrumentation Process

```
File Generation

Module Load Request

Module._extensions['.js']

fs.readFileSync()

J$.instrumentCode()

instCodeAndData Object

instUtil.applyASTHandler()

Write Source Map (.json)

Write Instrumented Code (.js)

module._compile()

filename_jalangi_.json

filename_jalangi_.js
```

Sources: [src/commands/jalangi.js94-111](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/jalangi.js#L94-L111)[src/commands/jalangi.js62-68](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/jalangi.js#L62-L68)

The instrumentation process overrides Node.js's module loading mechanism at [src/commands/jalangi.js94](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/jalangi.js#L94-L94) to intercept `.js` file loads. For each file, it:

1. Reads the original source code
2. Calls `J$.instrumentCode()` with configuration options
3. Applies any custom AST handlers via `instUtil.applyASTHandler()`
4. Writes both the instrumented code and source map to disk
5. Compiles the instrumented code using `module._compile()`

### Analysis Loading and Initialization

The command loads analysis modules before starting execution:

```
// Analysis loading at runtime
if (args.analysis) {
    args.analysis.forEach(function (src) {
        require(path.resolve(src));
    });
}
```

Sources: [src/commands/jalangi.js88-92](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/jalangi.js#L88-L92)

## direct.js - Pre-instrumented Analysis

The `direct.js` command runs analysis on code that has already been instrumented offline. This approach offers better performance since instrumentation is not performed during execution.

### Command Line Interface

```
direct.js [options] instrumented_script.js [script_args...]
```

**Arguments:**

- `--analysis`: Path to analysis file (can be specified multiple times)
- `--initParam`: Analysis initialization parameters as `key:value` pairs

### Execution Flow

```
Yes

No

direct.js Start

argparse.parseArgs()

Process initParam

Load Jalangi2 Headers

Load Analysis Modules

J$.analysis.onReady?

Wait for onReady callback

Start immediately

startProgram()

Set process.argv

Register exit handler

Module.runMain()

Execute Pre-instrumented Code
```

Sources: [src/commands/direct.js37-78](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/direct.js#L37-L78)

### Key Differences from jalangi.js

The `direct.js` command differs from `jalangi.js` in several important ways:

1. **No Module Hook**: Does not override `Module._extensions['.js']`
2. **No File Generation**: Does not write instrumented files or source maps
3. **Simpler Flow**: Directly executes the provided script without transformation
4. **Performance**: Faster execution since instrumentation is skipped

## Common Execution Pattern

Both commands follow a similar pattern for script execution:

```
startProgram()

path.resolve(script)

Build new process.argv

Set process.argv

process.on('exit', J$.endExecution)

Module.runMain(script)

Script Execution

J$ Runtime Callbacks

Analysis Callback Methods

J$.endExecution() on exit
```

Sources: [src/commands/jalangi.js112-128](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/jalangi.js#L112-L128)[src/commands/direct.js60-77](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/direct.js#L60-L77)

Both commands manipulate `process.argv` to make the target script appear as if it was invoked directly, and register an exit handler to ensure `J$.endExecution()` is called when the program terminates.

## Analysis Integration

Both commands support the same analysis integration patterns:

### Analysis Loading

- Multiple analysis files can be loaded using repeated `--analysis` flags
- Analysis modules are loaded using `require(path.resolve(src))`
- All analysis modules are loaded before script execution begins

### Initialization Parameters

- Parameters are passed via `--initParam key:value` format
- Multiple parameters can be specified
- Parameters are available as `J$.initParams` object in analysis code

### Ready Callback Support

- Both commands check for `J$.analysis.onReady` callback
- If present, script execution waits for analysis readiness
- Enables asynchronous analysis initialization

Sources: [src/commands/jalangi.js76-92](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/jalangi.js#L76-L92)[src/commands/direct.js37-78](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/direct.js#L37-L78)[src/commands/jalangi.js124-128](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/jalangi.js#L124-L128)[src/commands/direct.js73-77](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/direct.js#L73-L77)