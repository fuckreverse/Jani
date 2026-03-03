# Execution Tracing
Relevant source files
- [src/plugins/datatraces/LogData.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/datatraces/LogData.js)
- [src/plugins/datatraces/TraceWriter.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/datatraces/TraceWriter.js)
- [src/plugins/pldi16/LogLoadStore.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/pldi16/LogLoadStore.js)
- [src/plugins/pldi16/LogLoadStoreAlloc.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/pldi16/LogLoadStoreAlloc.js)

This document covers Jalangi2's execution tracing capabilities, which capture detailed runtime execution information including function calls, memory accesses, variable operations, and object allocations. These tracing analyses produce comprehensive logs of program execution that can be used for debugging, performance analysis, and program understanding.

For information about code coverage analysis, see [Coverage Analysis](/Samsung/jalangi2/5.1-coverage-analysis). For dynamic code quality checks, see [Code Quality Analysis](/Samsung/jalangi2/5.3-code-quality-analysis).

## Core Tracing Analyses

Jalangi2 provides several specialized tracing analyses that capture different aspects of program execution:

### LogData Analysis

The primary execution tracer is implemented in `LogData` class, which captures comprehensive execution events including function calls, property accesses, variable operations, and control flow.

```
LogData Analysis

Execution Events

Function Calls (C, E)

Property Access (G, P)

Variable Ops (R, W)

TraceWriter

trace.log

strings.json

smap.json

Shadow Memory

Object ID Tracking

Frame ID Tracking
```

Sources: [src/plugins/datatraces/LogData.js1-144](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/datatraces/LogData.js#L1-L144)

### Load/Store Tracing Analyses

Two specialized analyses focus on memory access patterns:
AnalysisPurposeKey Features`LogLoadStore`Basic load/store loggingLogs property and variable access with object/frame IDs`LogLoadStoreAlloc`Load/store with allocation trackingIncludes allocation site information for objects
Sources: [src/plugins/pldi16/LogLoadStore.js1-96](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/pldi16/LogLoadStore.js#L1-L96)[src/plugins/pldi16/LogLoadStoreAlloc.js1-91](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/pldi16/LogLoadStoreAlloc.js#L1-L91)

## Trace Event Types and Format

The `LogData` analysis generates structured trace events with specific formats:

### Event Type Categories

```
Variable Events

Property Events

Function Events

C - Function Call

E - Function Exit

G - Property Get

P - Property Put

R - Variable Read

W - Variable Write

Trace Events
```

### Event Format Structure

Each trace event follows a comma-separated format with consistent fields:
Event TypeFormat PatternFieldsFunction Call`C,sid,iid,functionId,frameId`Source ID, Instruction ID, Function Object ID, Frame IDFunction Exit`E,sid,iid,returnValue,valueType`Source ID, Instruction ID, Return Value, Value TypeProperty Get`G,sid,iid,objectId,ownerId,offset,value,type`Object access details with ownershipProperty Put`P,sid,iid,objectId,ownerId,offset,value,type`Property assignment detailsVariable Read`R,sid,iid,frameId,name,value,type`Frame-based variable accessVariable Write`W,sid,iid,frameId,name,value,type`Frame-based variable assignment
Sources: [src/plugins/datatraces/LogData.js75-97](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/datatraces/LogData.js#L75-L97)

## Value Encoding System

The tracing system uses a sophisticated value encoding mechanism to handle different JavaScript value types:

### Type System

```
object/function

string

primitive

object/function

string

primitive

getValue()

Value Type?

Get Shadow Object ID

Get String Index

Return Raw Value

sandbox.smemory.getShadowObjectOfObject()

stringMap lookup

getType()

Type Result

'O'

'S'

'P'
```

### String Interning

The system maintains a string interning mechanism to optimize trace file size:

- `stringMap`: Maps strings to numeric indices
- `stringList`: Array of unique strings encountered
- Negative indices indicate first occurrence of a string
- Positive indices indicate string reuse

Sources: [src/plugins/datatraces/LogData.js19-55](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/datatraces/LogData.js#L19-L55)

## TraceWriter System

The `TraceWriter` class handles efficient trace data output with buffering and multiple transport mechanisms:

### Architecture

```
Yes

No

Node.js

Browser

TraceWriter

Internal Buffer

Buffer Size > MAX_BUF_SIZE?

flush()

Continue Buffering

Environment?

fs.writeSync()

WebSocket to ws://127.0.0.1:8080

trace.log

Log Server
```

### Key Methods
MethodPurposeUsage`logToFile(line)`Add line to trace bufferCalled by analysis for each event`flush()`Write buffered data to outputAuto-triggered when buffer full`stopTracing()`Finalize tracing and flushCalled at analysis completion`remoteLog(message)`Send data via WebSocketBrowser-based tracing
Sources: [src/plugins/datatraces/TraceWriter.js1-136](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/datatraces/TraceWriter.js#L1-L136)

## Integration with Shadow Memory

Execution tracing relies heavily on the shadow memory system to track object and frame identities:

### Object Tracking

```
Yes

Property Access

getShadowObject(base, offset)

Shadow Object

shadowObj.owner

shadowObj.isProperty

getIDFromShadowObjectOrFrame()

Log Event?

Generate Trace Event
```

### Frame Tracking

Variable reads and writes use shadow frames to track execution context:

- `getShadowFrame(name)`: Gets shadow frame for variable
- `getIDFromShadowObjectOrFrame()`: Extracts unique frame ID
- Frame IDs provide execution context for variable operations

Sources: [src/plugins/datatraces/LogData.js90-98](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/datatraces/LogData.js#L90-L98)

## Usage Patterns

### Command Line Execution

```
# Basic execution tracing
node src/commands/jalangi.js \
  --inlineIID --inlineSource \
  --analysis src/plugins/ChainedAnalyses.js \
  --analysis src/runtime/SMemory.js \
  --analysis src/plugins/datatraces/TraceWriter.js \
  --analysis src/plugins/datatraces/LogData.js \
  target_program.js
```

### Analysis Chain Requirements

Execution tracing analyses require specific dependencies:

1. `ChainedAnalyses.js`: Enables multiple analysis composition
2. `SMemory.js`: Provides shadow memory system
3. `TraceWriter.js`: Handles trace output
4. Target tracing analysis (`LogData.js`, `LogLoadStore.js`, etc.)

Sources: [src/plugins/datatraces/LogData.js142](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/datatraces/LogData.js#L142-L142)

## Output File Structure

### Primary Outputs
FileContentFormat`trace.log`Main execution traceEvent records, one per line`strings.json`String interning tableJSON array of unique strings`smap.json`Source map informationJSON object mapping locations
### Trace Log Format

Each line in `trace.log` represents a single execution event with comma-separated values. The format varies by event type but maintains consistency in field ordering and meaning.

### String Resolution

To interpret string indices in trace events:

1. Load `strings.json` as an array
2. Negative indices: `strings[Math.abs(index) - 1]` (first occurrence)
3. Positive indices: `strings[index - 1]` (subsequent occurrences)

Sources: [src/plugins/datatraces/LogData.js109-117](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/datatraces/LogData.js#L109-L117)