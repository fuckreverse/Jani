# Sample Analyses
Relevant source files
- [src/js/sample_analyses/coverage/AddCoverage.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/sample_analyses/coverage/AddCoverage.js)
- [src/js/sample_analyses/coverage/tests/FeaturesMain.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/sample_analyses/coverage/tests/FeaturesMain.js)
- [src/js/sample_analyses/coverage/tests/FeaturesTest.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/sample_analyses/coverage/tests/FeaturesTest.js)
- [src/js/sample_analyses/coverage/tests/SetTest.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/sample_analyses/coverage/tests/SetTest.js)
- [src/js/sample_analyses/pldi16/LogLoadStore.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/sample_analyses/pldi16/LogLoadStore.js)
- [src/js/sample_analyses/pldi16/LogLoadStoreAlloc.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/sample_analyses/pldi16/LogLoadStoreAlloc.js)

This document provides an overview of the example analyses included with Jalangi2, demonstrating different types of dynamic analysis capabilities. These sample analyses serve as both functional tools for code analysis and educational examples for developing custom analyses.

For information about developing your own analyses, see [Analysis Development](/Samsung/jalangi2/4-analysis-development). For specific implementation details of individual analysis types, see the subsections: [Coverage Analysis](/Samsung/jalangi2/5.1-coverage-analysis), [Execution Tracing](/Samsung/jalangi2/5.2-execution-tracing), [Code Quality Analysis](/Samsung/jalangi2/5.3-code-quality-analysis), and [Branch Coverage](/Samsung/jalangi2/5.4-branch-coverage).

## Analysis Categories

Jalangi2 provides sample analyses organized into several categories, each demonstrating different aspects of dynamic analysis:

```
Analysis Callbacks

Core Analysis Infrastructure

Sample Analysis Categories

Coverage Analysis
AddCoverage.js

Execution Tracing
LogLoadStore*.js

Code Quality
dlint analyses

Branch Coverage
Specialized coverage

analysisCallbackTemplate.js
MyAnalysis Interface

ChainedAnalyses.js
Multiple Analysis Support

SMemory.js
Shadow Memory System

invokeFunPre/invokeFun
Function Calls

getFieldPre/putFieldPre
Property Access

read/write
Variable Access

literal
Object Creation
```

Sources: [src/js/sample_analyses/coverage/AddCoverage.js1-573](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/sample_analyses/coverage/AddCoverage.js#L1-L573)[src/js/sample_analyses/pldi16/LogLoadStoreAlloc.js1-91](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/sample_analyses/pldi16/LogLoadStoreAlloc.js#L1-L91)[src/js/sample_analyses/pldi16/LogLoadStore.js1-96](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/sample_analyses/pldi16/LogLoadStore.js#L1-L96)

## Coverage Analysis Framework

The coverage analysis system demonstrates sophisticated data structure management and feature tracking:

```
Data Persistence

Feature Management

Set Operations

AddCoverage.js Components

Set
Multi-dimensional coverage tracking

features[]
Coverage feature array

tests[]
Test case array

featureGraph
Feature dependency graph

add()
Add coverage points

split()
Intersect with new coverage

clone()
Deep copy sets

contains()
Check membership

addCoverage()
Process test coverage

getFeatures()
Retrieve feature data

deltaDebug()
Minimize test cases

readData()
Load from features.json

saveData()
Save to features.json

results.json
Analysis results
```

Sources: [src/js/sample_analyses/coverage/AddCoverage.js14-573](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/sample_analyses/coverage/AddCoverage.js#L14-L573)

## Execution Tracing Analyses

The execution tracing analyses demonstrate how to monitor program execution and memory operations:
AnalysisPurposeKey Features`LogLoadStore.js`Basic load/store loggingTracks property and variable access`LogLoadStoreAlloc.js`Advanced allocation trackingAssociates memory operations with allocation sites
### Load/Store Tracking Implementation

```
Shadow Memory Integration

Memory Operation Callbacks

LogLoadStore.js Structure

MyAnalysis
Analysis class

indentationCount
Call stack depth

logs[]
Execution log

getFieldPre()
Property reads

putFieldPre()
Property writes

read()
Variable reads

write()
Variable writes

sandbox.smemory
Shadow memory system

getShadowObject()
Object metadata

getShadowFrame()
Frame metadata

getIDFromShadowObjectOrFrame()
Unique IDs
```

Sources: [src/js/sample_analyses/pldi16/LogLoadStore.js15-84](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/sample_analyses/pldi16/LogLoadStore.js#L15-L84)[src/js/sample_analyses/pldi16/LogLoadStoreAlloc.js15-79](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/sample_analyses/pldi16/LogLoadStoreAlloc.js#L15-L79)

## Analysis Callback Interface

All sample analyses implement the standard `MyAnalysis` callback interface:
CallbackPurposeParameters`invokeFunPre`Pre-function call`iid, f, base, args, isConstructor, isMethod``invokeFun`Post-function call`iid, f, base, args, result, isConstructor, isMethod``getFieldPre`Pre-property read`iid, base, offset, isComputed, isOpAssign, isMethodCall``putFieldPre`Pre-property write`iid, base, offset, val, isComputed, isOpAssign``read`Variable read`iid, name, val, isGlobal, isScriptLocal``write`Variable write`iid, name, val, lhs, isGlobal, isScriptLocal``literal`Object creation`iid, val, hasGetterSetter``endExecution`Analysis cleanupNone
Sources: [src/js/sample_analyses/pldi16/LogLoadStore.js37-82](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/sample_analyses/pldi16/LogLoadStore.js#L37-L82)[src/js/sample_analyses/pldi16/LogLoadStoreAlloc.js37-76](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/sample_analyses/pldi16/LogLoadStoreAlloc.js#L37-L76)

## Usage Examples

### Running Coverage Analysis

```
# Basic coverage analysis
node src/js/commands/jalangi.js --analysis src/js/sample_analyses/coverage/AddCoverage.js program.js
 
# Coverage with chained analyses
node src/js/commands/jalangi.js --analysis src/js/sample_analyses/ChainedAnalyses.js --analysis src/js/sample_analyses/coverage/AddCoverage.js program.js
```

### Running Execution Tracing

```
# Basic load/store tracing
node src/js/commands/jalangi.js --analysis src/js/runtime/SMemory.js --analysis src/js/sample_analyses/pldi16/LogLoadStore.js program.js
 
# Advanced allocation tracking
node src/js/commands/jalangi.js --analysis src/js/runtime/SMemory.js --analysis src/js/sample_analyses/pldi16/LogLoadStoreAlloc.js program.js
```

Sources: [src/js/sample_analyses/pldi16/LogLoadStore.js89-93](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/sample_analyses/pldi16/LogLoadStore.js#L89-L93)[src/js/sample_analyses/pldi16/LogLoadStoreAlloc.js84-88](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/sample_analyses/pldi16/LogLoadStoreAlloc.js#L84-L88)

## Browser Integration

Sample analyses support browser execution with specialized result handling:

```
Analysis Integration

Output Handling

Browser Environment Detection

sandbox.Constants.isBrowser
Environment check

sandbox.Results
Browser result container

console.log()
Node.js output

HTML formatting
Browser output

logs[]
Buffered results

MyAnalysis
Analysis implementation

endExecution()
Result finalization

sandbox.log()
Browser logging
```

Sources: [src/js/sample_analyses/pldi16/LogLoadStore.js11-81](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/sample_analyses/pldi16/LogLoadStore.js#L11-L81)[src/js/sample_analyses/pldi16/LogLoadStoreAlloc.js11-76](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/sample_analyses/pldi16/LogLoadStoreAlloc.js#L11-L76)

## Testing Infrastructure

The sample analyses include comprehensive test suites demonstrating proper analysis development:
Test FilePurposeCoverage`SetTest.js`Set data structure operationsAdd, contains, split, clone operations`FeaturesTest.js`Feature management systemCoverage addition and feature tracking`FeaturesMain.js`Integration testingEnd-to-end coverage analysis
Sources: [src/js/sample_analyses/coverage/tests/SetTest.js1-442](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/sample_analyses/coverage/tests/SetTest.js#L1-L442)[src/js/sample_analyses/coverage/tests/FeaturesTest.js1-17](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/sample_analyses/coverage/tests/FeaturesTest.js#L1-L17)[src/js/sample_analyses/coverage/tests/FeaturesMain.js1-13](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/sample_analyses/coverage/tests/FeaturesMain.js#L1-L13)