# Analysis Development
Relevant source files
- [node_test/apiTests.js](https://github.com/Samsung/jalangi2/blob/28d2181c/node_test/apiTests.js)
- [src/runtime/analysisCallbackTemplate.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/runtime/analysisCallbackTemplate.js)
- [src/utils/api.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/utils/api.js)
- [tests/test45.js](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/test45.js)

This document covers the framework and processes for developing custom dynamic analyses using Jalangi2's callback-based analysis system. It explains the overall architecture, development workflow, and key components that analysis developers need to understand.

For specific implementation details of the analysis callback template, see [Analysis Template](/Samsung/jalangi2/4.1-analysis-template). For combining multiple analyses, see [Chained Analyses](/Samsung/jalangi2/4.2-chained-analyses). For programmatic instrumentation and execution, see [Programmatic API](/Samsung/jalangi2/4.3-programmatic-api).

## Overview

Jalangi2 enables developers to write custom dynamic analyses by implementing callback functions that are invoked during JavaScript execution. The analysis development process involves creating a class that extends the `MyAnalysis` template, implementing the desired callback methods, and integrating with Jalangi2's runtime system.

## Analysis Development Workflow

The following diagram illustrates the complete development and testing workflow for custom analyses:

**Analysis Development and Testing Process**

```
Execution Modes

Testing Infrastructure

Analysis Implementation

Development Tools

api.js
Programmatic Interface

analysisCallbackTemplate.js
Callback Template

Documentation
MyAnalysis.html

Developer

Custom Analysis
MyAnalysis class

Callback Methods
invokeFun, getField, etc.

Unit Tests
tests/unit/

Benchmark Tests
tests/sunspider1/

Test Scripts
test.analysis.py

direct.js
Pre-instrumented

jalangi.js
On-the-fly

instrument.js
Batch Processing

SMemory API

J$ Utilities
```

Sources: [src/runtime/analysisCallbackTemplate.js1-647](https://github.com/Samsung/jalangi2/blob/28d2181c/src/runtime/analysisCallbackTemplate.js#L1-L647)[src/utils/api.js1-251](https://github.com/Samsung/jalangi2/blob/28d2181c/src/utils/api.js#L1-L251)[node_test/apiTests.js1-67](https://github.com/Samsung/jalangi2/blob/28d2181c/node_test/apiTests.js#L1-L67)

## Analysis Runtime Integration

Custom analyses integrate with Jalangi2's runtime system through a well-defined callback interface. The following diagram shows how analysis code connects to the instrumented execution environment:

**Analysis Runtime Architecture**

```
Analysis State Management

Custom Analysis Layer

J$ Sandbox Environment

Instrumented JavaScript Execution

Callback Methods

Instrumented Code

J$ Runtime Callbacks
J$.F, J$.G, J$.P, J$.R, J$.W

J$ Sandbox Object

sandbox.analysis

sandbox.smemory
Shadow Memory System

sandbox.Utils

MyAnalysis Class

invokeFunPre/invokeFun

getFieldPre/getField

putFieldPre/putField

read

write

literal

binaryPre/binary

conditional

Shadow Objects

Shadow Frames

Source Maps
J$.smap
```

Sources: [src/runtime/analysisCallbackTemplate.js28-643](https://github.com/Samsung/jalangi2/blob/28d2181c/src/runtime/analysisCallbackTemplate.js#L28-L643)

## Core Development Components

### MyAnalysis Template Class

The `MyAnalysis` class in `analysisCallbackTemplate.js` serves as the foundation for all custom analyses. It defines the complete callback interface with detailed documentation for each method:
Callback TypeMethodsPurposeFunction Calls`invokeFunPre`, `invokeFun`Function invocation trackingProperty Access`getFieldPre`, `getField`, `putFieldPre`, `putField`Object property operationsVariable Access`read`, `write`Variable read/write operationsLiterals`literal`Literal value creationOperations`binaryPre`, `binary`, `unaryPre`, `unary`Binary and unary operationsControl Flow`conditional`Branching decisionsExecution Flow`functionEnter`, `functionExit`, `scriptEnter`, `scriptExit`Execution boundaries
Sources: [src/runtime/analysisCallbackTemplate.js101-640](https://github.com/Samsung/jalangi2/blob/28d2181c/src/runtime/analysisCallbackTemplate.js#L101-L640)

### Programmatic API

The `api.js` module provides programmatic interfaces for instrumenting code and running analyses from Node.js applications:
FunctionPurposeReturn Type`instrumentString`Instrument JavaScript code stringsObject with `code`, `instAST`, `sourceMapObject``instrumentDir`Instrument entire directoriesPromise resolving to output directory`analyze`Run analysis on instrumented codePromise with execution results
Sources: [src/utils/api.js105-251](https://github.com/Samsung/jalangi2/blob/28d2181c/src/utils/api.js#L105-L251)

### Runtime Integration Points

Custom analyses access runtime information through several key interfaces:

- **Source Maps**: `J$.smap` provides mapping from instruction IDs to source locations
- **Shadow Memory**: `sandbox.smemory` for tracking object metadata and execution frames
- **Utilities**: `sandbox.Utils` for common analysis operations
- **Global State**: `J$.sid` for current script ID, `J$.getGlobalIID()` for unique instruction identification

Sources: [src/runtime/analysisCallbackTemplate.js58-90](https://github.com/Samsung/jalangi2/blob/28d2181c/src/runtime/analysisCallbackTemplate.js#L58-L90)

## Development Process

### 1. Analysis Implementation

Developers create custom analyses by:

1. Copying the `MyAnalysis` template from `analysisCallbackTemplate.js`
2. Implementing the required callback methods for their analysis logic
3. Accessing runtime state through the sandbox APIs
4. Managing analysis-specific data structures

### 2. Testing and Validation

The development workflow includes comprehensive testing:

- Unit tests using the programmatic API
- Integration tests with sample JavaScript programs
- Performance benchmarking with standard test suites
- Automated testing scripts for continuous validation

### 3. Deployment Options

Analyses can be executed through multiple interfaces:

- **Command-line**: Using `jalangi.js` or `direct.js` commands
- **Programmatic**: Through the `api.js` interface from Node.js
- **Web-based**: Via proxy instrumentation for browser analysis

Sources: [src/utils/api.js224-246](https://github.com/Samsung/jalangi2/blob/28d2181c/src/utils/api.js#L224-L246)[node_test/apiTests.js25-66](https://github.com/Samsung/jalangi2/blob/28d2181c/node_test/apiTests.js#L25-L66)