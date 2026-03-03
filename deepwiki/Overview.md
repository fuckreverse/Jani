# Overview
Relevant source files
- [.travis.yml](https://github.com/Samsung/jalangi2/blob/28d2181c/.travis.yml)
- [README.md](https://github.com/Samsung/jalangi2/blob/28d2181c/README.md)
- [package-lock.json](https://github.com/Samsung/jalangi2/blob/28d2181c/package-lock.json)
- [package.json](https://github.com/Samsung/jalangi2/blob/28d2181c/package.json)
- [scripts/mitmproxywrapper.py](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/mitmproxywrapper.py)
- [scripts/proxy.py](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/proxy.py)
- [src/plugins/pldi16/TraceAll.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/pldi16/TraceAll.js)

## Purpose and Scope

Jalangi2 is a dynamic analysis framework for JavaScript that enables developers to write custom analyses of JavaScript program execution. The framework provides instrumentation capabilities to inject analysis callbacks into JavaScript code and a runtime system to execute those analyses during program execution.

This document covers the overall architecture and main components of Jalangi2. For detailed information about developing custom analyses, see [Analysis Development](/Samsung/jalangi2/4-analysis-development). For specific command-line usage, see [Command-Line Tools](/Samsung/jalangi2/3-command-line-tools). For web application analysis, see [Web Integration](/Samsung/jalangi2/6-web-integration).

Sources: [README.md1-7](https://github.com/Samsung/jalangi2/blob/28d2181c/README.md#L1-L7)[package.json4](https://github.com/Samsung/jalangi2/blob/28d2181c/package.json#L4-L4)

## System Architecture

Jalangi2 follows a multi-stage architecture where JavaScript code is first instrumented to inject analysis callbacks, then executed in a runtime environment that dispatches those callbacks to analysis modules.

### High-Level Architecture

```
Sample Analyses

Analysis Framework

Runtime System

Command Interface

Instrumentation Layer

Input JavaScript

JavaScript Source Files

Web Applications

Node.js Applications

esnstrument.js
AST Transformation Engine

acorn
JavaScript Parser

esotope
Code Generator

jalangi.js
On-the-fly Analysis

instrument.js
Batch Instrumentation

esnstrument_cli.js
Single File Processing

proxy.py
Web Proxy Integration

J$ Sandbox Environment

SMemory
Shadow Memory System

Runtime Callback Dispatch

analysisCallbackTemplate.js
Analysis Interface

ChainedAnalyses.js
Multiple Analysis Support

Custom Analysis Modules

Coverage Analysis

TraceAll Execution Tracing

DLint Code Quality Checks
```

Sources: [README.md59-102](https://github.com/Samsung/jalangi2/blob/28d2181c/README.md#L59-L102)[package.json37-38](https://github.com/Samsung/jalangi2/blob/28d2181c/package.json#L37-L38)[scripts/proxy.py1-126](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/proxy.py#L1-L126)

### Code Entity Mapping

```
Integration Files

scripts/proxy.py
Web Proxy Server

scripts/sj.py
Node.js Utilities

src/Config.js
Instrumentation Configuration

Analysis Files

src/plugins/ChainedAnalyses.js
Analysis Chaining

src/plugins/pldi16/TraceAll.js
Execution Tracer

src/plugins/AddCoverage.js
Code Coverage

Command Files

src/commands/jalangi.js
Dynamic Analysis CLI

src/commands/instrument.js
Batch Processing CLI

src/commands/direct.js
Pre-instrumented Execution

src/utils/api.js
Programmatic Interface

Core Files

src/commands/esnstrument.js
Instrumentation Engine

src/runtime/analysis.js
Runtime Sandbox

src/runtime/SMemory.js
Shadow Memory

src/runtime/analysisCallbackTemplate.js
Analysis Template
```

Sources: [package.json37-38](https://github.com/Samsung/jalangi2/blob/28d2181c/package.json#L37-L38)[README.md63-91](https://github.com/Samsung/jalangi2/blob/28d2181c/README.md#L63-L91)[scripts/proxy.py1](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/proxy.py#L1-L1)[src/plugins/pldi16/TraceAll.js1](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/pldi16/TraceAll.js#L1-L1)

## Core Components

### Instrumentation Engine

The instrumentation engine transforms JavaScript source code by parsing it into an Abstract Syntax Tree (AST), inserting analysis callback invocations, and generating instrumented JavaScript code. The core engine is implemented in `esnstrument.js` and uses the `acorn` parser and `esotope` code generator.

**Key Operations:**

- Function calls transformed to `J$.F()` and `J$.M()` callbacks
- Property access transformed to `J$.G()` and `J$.P()` callbacks
- Variable access transformed to `J$.R()` and `J$.W()` callbacks
- Literal values transformed to `J$.T()` callbacks
- Control flow transformed to `J$.C()`, `J$.Fe()`, `J$.Fr()` callbacks

Sources: [README.md86-91](https://github.com/Samsung/jalangi2/blob/28d2181c/README.md#L86-L91)[package.json6-11](https://github.com/Samsung/jalangi2/blob/28d2181c/package.json#L6-L11)

### Runtime System

The runtime system provides the `J$` sandbox environment that executes instrumented JavaScript code and dispatches analysis callbacks. The sandbox includes shadow memory management for tracking object metadata and execution context.

**Key Components:**

- `J$` global sandbox object providing runtime services
- `sandbox.analysis` property containing the active analysis instance
- `sandbox.smemory` shadow memory system for object tracking
- Callback dispatch mechanism routing runtime events to analysis methods

Sources: [README.md75-77](https://github.com/Samsung/jalangi2/blob/28d2181c/README.md#L75-L77)[src/plugins/pldi16/TraceAll.js27-302](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/pldi16/TraceAll.js#L27-L302)

### Analysis Framework

The analysis framework provides a standardized interface for implementing dynamic analyses. Analyses implement callback methods defined in `analysisCallbackTemplate.js` to receive notifications about program execution events.

**Callback Categories:**

- Function execution: `invokeFunPre`, `invokeFun`, `functionEnter`, `functionExit`
- Property access: `getFieldPre`, `getField`, `putFieldPre`, `putField`
- Variable access: `read`, `write`, `declare`
- Control flow: `conditional`, `_return`, `_throw`, `_with`
- Literals and expressions: `literal`, `binary`, `unary`, `endExpression`

Sources: [README.md75-77](https://github.com/Samsung/jalangi2/blob/28d2181c/README.md#L75-L77)[src/plugins/pldi16/TraceAll.js74-298](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/pldi16/TraceAll.js#L74-L298)

## Usage Modes

Jalangi2 supports three primary modes of operation for different use cases and environments.

### Usage Mode Comparison
ModeCommandUse CaseInstrumentationTargetOn-the-fly`jalangi.js`Development, TestingRuntimeNode.jsOffline`instrument.js`, `esnstrument_cli.js`Production, BatchPre-processingNode.js, BrowserProxy`proxy.py`Web ApplicationsOn-demandBrowser
### Node.js On-the-fly Analysis

Direct analysis execution with runtime instrumentation using `jalangi.js`. Code is instrumented and analyzed in a single step.

```
node src/commands/jalangi.js --analysis MyAnalysis.js target.js
```

Sources: [README.md59-84](https://github.com/Samsung/jalangi2/blob/28d2181c/README.md#L59-L84)

### Offline Instrumentation

Two-step process where code is first instrumented using `instrument.js` or `esnstrument_cli.js`, then executed with `direct.js`.

```
node src/commands/esnstrument_cli.js --inlineIID target.js
node src/commands/direct.js --analysis MyAnalysis.js target_jalangi_.js
```

Sources: [README.md86-93](https://github.com/Samsung/jalangi2/blob/28d2181c/README.md#L86-L93)

### Browser Proxy Analysis

Web application analysis using `proxy.py` with `mitmproxy` for on-the-fly instrumentation of JavaScript served over HTTP/HTTPS.

```
mitmdump -s "scripts/proxy.py --analysis MyAnalysis.js"
```

Sources: [README.md104-141](https://github.com/Samsung/jalangi2/blob/28d2181c/README.md#L104-L141)[scripts/proxy.py83-126](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/proxy.py#L83-L126)