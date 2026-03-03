# Advanced Features
Relevant source files
- [docs/MyAnalysis.html](https://github.com/Samsung/jalangi2/blob/28d2181c/docs/MyAnalysis.html)
- [docs/SMemory.html](https://github.com/Samsung/jalangi2/blob/28d2181c/docs/SMemory.html)
- [docs/index.html](https://github.com/Samsung/jalangi2/blob/28d2181c/docs/index.html)
- [generatedocs.sh](https://github.com/Samsung/jalangi2/blob/28d2181c/generatedocs.sh)
- [scripts/test.traceall.py](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.traceall.py)
- [src/plugins/frames/FrameAnalysis.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/frames/FrameAnalysis.js)
- [src/plugins/frames/Frames.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/frames/Frames.js)

This document covers advanced capabilities of Jalangi2 that extend beyond basic analysis development. These features include sophisticated frame management for tracking execution contexts, detailed shadow memory mechanisms, automated documentation generation, and advanced testing infrastructure. For basic analysis development, see [Analysis Development](/Samsung/jalangi2/4-analysis-development). For shadow memory fundamentals, see [Shadow Memory System](/Samsung/jalangi2/2.3-shadow-memory-system).

## Frame Management System

Jalangi2 provides an advanced frame management system that tracks JavaScript execution contexts, closures, and scope chains. This system enables analyses to understand variable scoping, function call hierarchies, and closure relationships during execution.

### Frame Stack Architecture

The frame management system maintains a stack of execution frames that mirrors JavaScript's call stack behavior:

```
Frame Navigation

Frame Operations

Frame Management Components

frameStack[]
Current execution frames

frame
Current active frame

evalFrames[]
Eval context stack

functionEnter()
Push new frame

functionReturn()
Pop frame

scriptEnter()
Script context

scriptReturn()
Exit script

evalBegin()
Eval context

evalEnd()
Restore context

getFrame(name)
Find variable owner

getCurrentFrame()
Active frame

getParentFrame()
Closure chain

getClosureFrame(fun)
Function closure
```

**Frame Stack Management**

The `Frames` class in [src/plugins/frames/Frames.js14-17](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/frames/Frames.js#L14-L17) maintains three core data structures:

- `frame`: Current active execution frame
- `frameStack`: Stack of all active frames
- `evalFrames`: Separate stack for eval contexts

**Function Frame Lifecycle**

Function calls create new frames with proper closure chain linking:
OperationMethodFrame Stack EffectFunction Entry`functionEnter(val)`Push new frame, link to closureFunction Exit`functionReturn()`Pop current frameScript Entry`scriptEnter()`Create script-level frameScript Exit`scriptReturn()`Remove script frame
Sources: [src/plugins/frames/Frames.js80-95](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/frames/Frames.js#L80-L95)[src/plugins/frames/Frames.js97-111](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/frames/Frames.js#L97-L111)

### Closure Chain Tracking

The frame system tracks closure relationships through the `SPECIAL_PROP_FRAMES` property:

```
Frame Properties

Closure Chain Example

Function f1
Global scope

Function f2
Closure of f1

Function f3
Closure of f2

SPECIAL_PROP_FRAMES
Points to closure frame

defineFunction(val)
Set closure property

getClosureFrame(fun)
Get closure frame
```

The `defineFunction` method [src/plugins/frames/Frames.js53-63](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/frames/Frames.js#L53-L63) establishes closure relationships by setting the `SPECIAL_PROP_FRAMES` property on function objects to point to their lexical scope frame.

**Variable Resolution**

The `getFrame(name)` method [src/plugins/frames/Frames.js23-34](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/frames/Frames.js#L23-L34) implements JavaScript's variable resolution algorithm by traversing the closure chain until finding a frame containing the variable.

Sources: [src/plugins/frames/Frames.js48-50](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/frames/Frames.js#L48-L50)[src/plugins/frames/Frames.js23-34](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/frames/Frames.js#L23-L34)

### Frame Analysis Integration

The `FrameAnalysis` class demonstrates how to integrate frame tracking with Jalangi2's callback system:

```
Frame Operations

Analysis Callbacks

literal(iid, val)
Track function definitions

declare(iid, name)
Initialize variables

functionEnter(iid, f)
Push frame

functionExit(iid, ret)
Pop frame

scriptEnter(iid, file)
Script context

scriptExit(iid, exc)
Exit script

instrumentCodePre(iid)
Eval begin

instrumentCode(iid, code)
Eval end

frames.defineFunction()

frames.initialize()

frames.functionEnter()

frames.functionReturn()

frames.scriptEnter()

frames.scriptReturn()

frames.evalBegin()

frames.evalEnd()
```

The frame analysis registers itself as `sandbox.frames`[src/plugins/frames/FrameAnalysis.js31](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/frames/FrameAnalysis.js#L31-L31) making the frame management system available to other analyses.

Sources: [src/plugins/frames/FrameAnalysis.js28-82](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/frames/FrameAnalysis.js#L28-L82)

## Documentation System

Jalangi2 includes an automated documentation generation system that produces comprehensive API documentation for analysis development.

### JSDoc Generation Pipeline

The documentation system uses JSDoc with a custom theme to generate HTML documentation:

```
Output Documentation

Generation Process

Source Files

analysisCallbackTemplate.js
Analysis API

SMemory.js
Shadow Memory API

JSDoc 3.4.0
Documentation parser

jaguarjs-jsdoc
Custom theme

conf.json
Configuration

MyAnalysis.html
Analysis callbacks

SMemory.html
Shadow memory API

index.html
Documentation index
```

**Generation Script**

The `generatedocs.sh` script [generatedocs.sh1-10](https://github.com/Samsung/jalangi2/blob/28d2181c/generatedocs.sh#L1-L10) automates the documentation build process:

1. Installs JSDoc and the custom theme
2. Clones the jaguarjs-jsdoc theme repository
3. Generates documentation with pedantic mode enabled
4. Outputs to the `docs/` directory

**Documentation Structure**

The generated documentation includes:
ComponentFilePurposeAnalysis Template`MyAnalysis.html`Complete callback API referenceShadow Memory`SMemory.html`Shadow memory operationsIndex`index.html`Navigation and overview
Sources: [generatedocs.sh9](https://github.com/Samsung/jalangi2/blob/28d2181c/generatedocs.sh#L9-L9)[docs/MyAnalysis.html1-10](https://github.com/Samsung/jalangi2/blob/28d2181c/docs/MyAnalysis.html#L1-L10)[docs/SMemory.html1-10](https://github.com/Samsung/jalangi2/blob/28d2181c/docs/SMemory.html#L1-L10)

### Analysis Callback Documentation

The `MyAnalysis.html` documentation provides comprehensive coverage of all analysis callbacks:

```
Documentation Features

Callback Categories

Execution Flow
functionEnter, functionExit
scriptEnter, scriptExit

Memory Operations
getField, putField
read, write

Operations
binary, unary
conditional

Control Flow
_return, _throw
_with

Meta Operations
literal, declare
instrumentCode

Parameter Details
Type information
Usage examples

Return Values
Modification capabilities
Skip options

Descriptions
When callbacks fire
Modification effects
```

Each callback method includes detailed parameter documentation, return value specifications, and usage guidelines for modifying program execution.

Sources: [docs/MyAnalysis.html330-1180](https://github.com/Samsung/jalangi2/blob/28d2181c/docs/MyAnalysis.html#L330-L1180)

### Shadow Memory API Documentation

The shadow memory documentation [docs/SMemory.html](https://github.com/Samsung/jalangi2/blob/28d2181c/docs/SMemory.html) details the advanced memory tracking capabilities:

**Core Methods**
MethodPurposeUsage Context`getShadowObject(obj, prop, isGetField)`Get property shadow objectField access callbacks`getShadowFrame(name)`Get variable's frame shadowVariable callbacks`getIDFromShadowObjectOrFrame(obj)`Get unique shadow IDObject identification`getShadowObjectOfObject(val)`Get object's shadowObject tracking
The documentation includes prototype chain handling, getter/setter detection, and shadow object lifecycle management details.

Sources: [docs/SMemory.html850-1176](https://github.com/Samsung/jalangi2/blob/28d2181c/docs/SMemory.html#L850-L1176)

## Advanced Testing Infrastructure

Jalangi2 provides specialized testing infrastructure for comprehensive analysis validation, including trace-based testing and analysis chaining verification.

### TraceAll Testing System

The TraceAll testing framework enables comprehensive execution tracing for analysis validation:

```
Test Results

Analysis Chain

Test Execution Flow

unitTests.txt
Test specification

test.traceall.py
Test runner

Jalangi execution
--inlineIID --inlineSource

ChainedAnalyses.js
Multiple analysis support

SMemory.js
Shadow memory tracking

TraceAll.js
Comprehensive tracing

Test passed
Clean execution

Test failed
Analysis exception

Trace output
Execution details
```

**Test Execution Process**

The `test.traceall.py` script [scripts/test.traceall.py6-16](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.traceall.py#L6-L16) implements a comprehensive testing workflow:

1. Creates isolated test environment
2. Executes Jalangi with analysis chain
3. Detects analysis exceptions
4. Reports test results

**Analysis Chain Configuration**

The test uses a specific analysis chain for comprehensive coverage:

- `ChainedAnalyses.js`: Enables multiple analysis composition
- `SMemory.js`: Provides shadow memory tracking
- `TraceAll.js`: Captures complete execution traces

The command line configuration [scripts/test.traceall.py8](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.traceall.py#L8-L8) includes:

- `--inlineIID`: Embed instruction IDs for source mapping
- `--inlineSource`: Include original source for analysis

**Test Suite Integration**

The system processes test specifications from `unitTests.txt`[scripts/test.traceall.py17-24](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.traceall.py#L17-L24) supporting both simple test execution and parameterized test cases with additional arguments.

Sources: [scripts/test.traceall.py1-26](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.traceall.py#L1-L26)

### Error Detection and Reporting

The testing infrastructure includes sophisticated error detection:

```
Result Processing

Error Detection

Execute analysis

Check for 'analysis exception!!!'

Capture stderr output

Print test passed

Print full error output

Update exit status
```

The test runner captures both stdout and stderr [scripts/test.traceall.py8](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.traceall.py#L8-L8) to detect analysis exceptions and provide detailed error reporting for debugging complex analysis interactions.

Sources: [scripts/test.traceall.py9-15](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.traceall.py#L9-L15)