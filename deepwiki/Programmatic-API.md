# Programmatic API
Relevant source files
- [node_test/apiTests.js](https://github.com/Samsung/jalangi2/blob/28d2181c/node_test/apiTests.js)
- [src/js/utils/api.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/utils/api.js)

The Programmatic API provides a Node.js interface for programmatically instrumenting JavaScript code and running dynamic analyses from within Node.js applications. This API allows developers to integrate Jalangi2's instrumentation and analysis capabilities into custom tooling, build systems, and automated workflows.

For information about developing custom analyses that work with this API, see [Analysis Template](/Samsung/jalangi2/4.1-analysis-template). For details about command-line tools that provide similar functionality, see [Main Commands](/Samsung/jalangi2/3.1-main-commands).

## API Overview

The programmatic interface is exposed through the `api.js` module, which provides three primary functions for different aspects of the instrumentation and analysis workflow:

```
Supporting Components

Output Results

Input Sources

Programmatic API Functions

uses

uses

uses

instrumentString()

instrumentDir()

analyze()

Code String

Directory Path

Instrumented Script

Instrumented Code Object

Instrumented Directory

Analysis Results

Configuration Setup

Temporary Files

Child Process Management

esnstrument.js

instrument command

direct.js
```

**Main API Functions**
FunctionPurposeInputOutput`instrumentString()`Instrument JavaScript code stringCode string + optionsInstrumented code object`instrumentDir()`Instrument entire directoryDirectory path + optionsPromise resolving to output directory`analyze()`Execute analysis on instrumented codeScript path + analysesPromise resolving to analysis results
Sources: [src/js/utils/api.js1-251](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/utils/api.js#L1-L251)

## String Instrumentation

The `instrumentString()` function transforms JavaScript source code by injecting analysis callbacks. It operates entirely in memory without writing files to disk.

### Function Signature and Options

```
Return Object

Options Properties

instrumentString Input

code: string

options: object

inputFileName

outputFile

inlineSourceMap

inlineSource

instHandler

astHandler

code: instrumented string

instAST: instrumented AST

sourceMapObject: IID mappings

instrumentString
```

**Key Options:**

- `inputFileName`: Associates original filename with source map
- `outputFile`: Target filename for source map (not actually written)
- `inlineSourceMap`: Embeds source map in instrumented code
- `inlineSource`: Embeds original source in instrumented code
- `instHandler`: Controls selective instrumentation of language constructs
- `astHandler`: Processes instrumented AST and stores result in `J$.ast_info`

### Instrumentation Handler Configuration

The `instHandler` option provides fine-grained control over which JavaScript constructs get instrumented:

```
Global Config Object

Configuration Process

Instrumentation Handler Properties

instrRead

instrWrite

instrGetfield

instrPutfield

instrBinary

instrPropBinaryAssignment

instrUnary

instrLiteral

instrConditional

setupConfig()

clearConfig()

J$.Config properties
```

The `setupConfig()` function maps handler properties to corresponding `J$.Config` properties, while `clearConfig()` resets them after instrumentation.

Sources: [src/js/utils/api.js49-76](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/utils/api.js#L49-L76)[src/js/utils/api.js105-129](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/utils/api.js#L105-L129)

## Directory Instrumentation

The `instrumentDir()` function processes entire directory trees, instrumenting all JavaScript files while preserving directory structure.

### Directory Processing Flow

```
Output

Configuration

Processing

Input

options object

source directory

temp.mkdirSync()

instDir.instrument()

Q.defer()

setupConfig()

clearConfig()

Promise<{outputDir}>

instrumented directory
```

**Key Features:**

- Creates temporary output directory if none specified
- Uses promise-based asynchronous API
- Supports same `instHandler` configuration as string instrumentation
- Delegates to `src/js/commands/instrument.js` for actual processing

Sources: [src/js/utils/api.js138-155](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/utils/api.js#L138-L155)

## Analysis Execution

The `analyze()` function executes dynamic analyses on instrumented JavaScript code by spawning a child process running the `direct.js` command.

### Analysis Execution Architecture

```
Result Promise

Process Communication

Child Process Setup

analyze() Function

script path

clientAnalyses array

initParam object

direct.js command

CLI arguments array

cp.fork()

stdout capture

stderr capture

exit code handling

Promise resolution

Promise rejection

analysis result object
```

**Process Management:**

The `runChildAndCaptureOutput()` function handles child process execution:

- Captures stdout and stderr streams incrementally
- Converts buffer chunks to strings
- Resolves promise with output on success (exit code 0)
- Rejects promise with error details on failure

**CLI Argument Construction:**

- Each analysis in `clientAnalyses` becomes `--analysis <path>`
- `initParam` object keys become `--initParam key:value` pairs
- Script path is passed as final positional argument

Sources: [src/js/utils/api.js224-246](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/utils/api.js#L224-L246)[src/js/utils/api.js180-210](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/utils/api.js#L180-L210)

## Configuration Integration

The API integrates with Jalangi2's global configuration system to control instrumentation behavior.

```
Config Properties

API Configuration Flow

instHandler object

setupConfig()

J$.Config globals

instrumentation process

clearConfig()

INSTR_READ

INSTR_WRITE

INSTR_GETFIELD

INSTR_PUTFIELD

INSTR_BINARY

INSTR_UNARY

INSTR_LITERAL

INSTR_CONDITIONAL
```

This configuration mechanism allows fine-grained control over which JavaScript language constructs get instrumented with analysis callbacks.

Sources: [src/js/utils/api.js49-76](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/utils/api.js#L49-L76)

## Usage Examples

### Basic String Instrumentation

```
var jalangi = require('./src/js/utils/api');
 
var testCode = "var x = 3; console.log(x);";
var options = {
    inputFileName: 'test.js',
    outputFile: 'instrumented.js',
    inlineSourceMap: true
};
 
var result = jalangi.instrumentString(testCode, options);
console.log(result.code); // instrumented JavaScript
console.log(result.sourceMapObject); // IID to source location mapping
```

### Directory Instrumentation with Promise

```
var options = {
    inputDir: './src',
    outputDir: './instrumented',
    instHandler: {
        instrRead: function(iid, name, val, isGlobal) { return true; },
        instrWrite: function(iid, name, val, isGlobal) { return true; }
    }
};
 
jalangi.instrumentDir(options)
    .then(function(result) {
        console.log('Instrumented to:', result.outputDir);
    })
    .catch(function(error) {
        console.error('Instrumentation failed:', error);
    });
```

### Analysis Execution

```
var script = './instrumented/app.js';
var analyses = ['./src/js/plugins/ChainedAnalyses.js'];
var initParam = { analysis: 'coverage' };
 
jalangi.analyze(script, analyses, initParam)
    .then(function(result) {
        console.log('Exit code:', result.exitCode);
        console.log('Analysis output:', result.stdout);
        if (result.result) {
            console.log('Analysis result:', result.result);
        }
    })
    .catch(function(error) {
        console.error('Analysis failed:', error);
    });
```

Sources: [node_test/apiTests.js26-65](https://github.com/Samsung/jalangi2/blob/28d2181c/node_test/apiTests.js#L26-L65)