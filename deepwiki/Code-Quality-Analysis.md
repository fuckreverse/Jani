# Code Quality Analysis
Relevant source files
- [scripts/test.analysis.py](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.analysis.py)
- [scripts/test.dlint.py](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.dlint.py)
- [src/js/runtime/iidToLocation.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/iidToLocation.js)
- [src/js/plugins/dlint/CheckNaN.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/plugins/dlint/CheckNaN.js)

## Purpose and Scope

This document covers Jalangi2's code quality analysis system, specifically the **dlint** (Dynamic Lint) framework that detects common programming errors and questionable patterns during JavaScript execution. The dlint system provides a collection of dynamic analyses that identify runtime issues such as NaN propagation, undefined property access, type coercion problems, and function argument mismatches.

For information about coverage analysis, see [Coverage Analysis](/Samsung/jalangi2/5.1-coverage-analysis). For execution tracing capabilities, see [Execution Tracing](/Samsung/jalangi2/5.2-execution-tracing). For general analysis development patterns, see [Analysis Development](/Samsung/jalangi2/4-analysis-development).

## Overview

The dlint system is a collection of specialized analyses built on Jalangi2's analysis framework that focus on detecting code quality issues during runtime execution. Unlike static analysis tools, dlint analyses observe actual program behavior to identify problems that may not be apparent from source code inspection alone.

### Core Components

```
Runtime Integration

Framework Integration

dlint Analysis Suite

Testing Infrastructure

test.dlint.py
dlint test runner

tests/dlint/
Test cases

Expected outputs
Validation data

Utils.js
Common utilities

CheckNaN.js
NaN detection

FunCalledWithMoreArguments.js
Argument validation

CompareFunctionWithPrimitives.js
Type comparison checks

UndefinedOffset.js
Undefined property access

ConcatUndefinedToString.js
String concatenation issues

ShadowProtoProperty.js
Prototype shadowing

ChainedAnalyses.js
Multiple analysis execution

analysisCallbackTemplate.js
Base analysis interface

J$ Sandbox

iidToLocation.js
Error location mapping

Error reporting system
```

Sources: [scripts/test.dlint.py6-13](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.dlint.py#L6-L13)[src/js/plugins/dlint/CheckNaN.js25-65](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/plugins/dlint/CheckNaN.js#L25-L65)

## dlint Analysis Architecture

Each dlint analysis follows a consistent pattern of hooking into runtime callbacks to detect specific error conditions and accumulating statistics for end-of-execution reporting.

### Analysis Implementation Pattern

```
Error Reporting

dlint Analysis Instance

Runtime Execution

Increment counters

Check conditions

Instrumented JavaScript Code

J$ Runtime Callbacks
invokeFun, getField, binary, unary

MyAnalysis constructor
Initialize tracking data

Analysis hooks
Pattern detection logic

info object
Error occurrence tracking

endExecution
Report accumulated errors

Utils.printInfo
Format error reports

iidToLocation
Source location mapping

Console output
Error summaries
```

Sources: [src/js/plugins/dlint/CheckNaN.js26-64](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/plugins/dlint/CheckNaN.js#L26-L64)[src/js/runtime/iidToLocation.js29-57](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/iidToLocation.js#L29-L57)

## Available Code Quality Analyses

The dlint suite includes analyses for detecting common JavaScript programming errors:
AnalysisFilePurposeDetected Issues**NaN Detection**`CheckNaN.js`Identifies NaN value propagationFunction results, property access, arithmetic operations**Argument Validation**`FunCalledWithMoreArguments.js`Detects excess function argumentsFunctions called with more parameters than declared**Type Comparison**`CompareFunctionWithPrimitives.js`Identifies problematic comparisonsFunctions compared with primitives**Undefined Access**`UndefinedOffset.js`Tracks undefined property accessProperty reads that return undefined**String Concatenation**`ConcatUndefinedToString.js`Detects undefined in string operationsConcatenating undefined values to strings**Prototype Shadowing**`ShadowProtoProperty.js`Identifies property shadowingProperties that shadow prototype properties
Sources: [scripts/test.dlint.py6-13](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.dlint.py#L6-L13)

### NaN Detection Implementation

The `CheckNaN` analysis demonstrates the typical dlint pattern by hooking multiple runtime callbacks to detect NaN values:

```
Reporting

NaN Detection Logic

Runtime Callbacks

invokeFun
Function calls

getField
Property access

binary
Binary operations

unary
Unary operations

result !== result
NaN test

info[iid] counter
Occurrence tracking

endExecution

Utils.printInfo

Observed NaN at location
```

The NaN detection uses JavaScript's property that `NaN !== NaN` to identify when operations produce NaN values:

- **Function calls**: [src/js/plugins/dlint/CheckNaN.js34-38](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/plugins/dlint/CheckNaN.js#L34-L38)
- **Property access**: [src/js/plugins/dlint/CheckNaN.js40-44](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/plugins/dlint/CheckNaN.js#L40-L44)
- **Binary operations**: [src/js/plugins/dlint/CheckNaN.js46-50](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/plugins/dlint/CheckNaN.js#L46-L50)
- **Unary operations**: [src/js/plugins/dlint/CheckNaN.js52-56](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/plugins/dlint/CheckNaN.js#L52-L56)

Sources: [src/js/plugins/dlint/CheckNaN.js34-56](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/plugins/dlint/CheckNaN.js#L34-L56)

## Testing Framework

The dlint analyses are validated through a comprehensive testing system that verifies expected error detection and reporting:

### Test Execution Flow

```
"Output Validation"
"Analysis Execution"
"Instrumentation"
"test.dlint.py"
"Output Validation"
"Analysis Execution"
"Instrumentation"
"test.dlint.py"
"instrument --inlineIID --inlineSource test.js"
"Instrumented test_jalangi_.js"
"Run with chained dlint analyses"
"Error report output"
"Compare with expected output"
"Pass/fail result"
```

The test framework runs each dlint analysis against specific test cases and validates the output format and content:

**Test Structure:**

- **Instrumentation**: [scripts/test.dlint.py20](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.dlint.py#L20-L20)
- **Analysis execution**: [scripts/test.dlint.py21](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.dlint.py#L21-L21)
- **Output validation**: [scripts/test.dlint.py22-31](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.dlint.py#L22-L31)

**Example test case for NaN detection:**

```
Expected: "Observed NaN at (../tests/dlint/testNaN.js:7:5:7:10) 1 time(s)."

```

Sources: [scripts/test.dlint.py17-31](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.dlint.py#L17-L31)[scripts/test.dlint.py34-36](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.dlint.py#L34-L36)

## Error Location Mapping

The dlint system provides precise source location information for detected errors through the `iidToLocation` system:

### Location Resolution Process

```
Output Formatting

Location Mapping

Error Detection

dlint Analysis

Instruction ID (iid)

getGlobalIID(iid)

sandbox.smap
Source map data

iidToLocation function

Line:Column coordinates

File name extraction

Location string format

HTML link generation
```

The location system produces formatted strings like:

- `(../tests/dlint/testNaN.js:7:5:7:10)` for console output
- `<a href="javascript:iidToDisplayCodeLocation('sid:iid');">...</a>` for web UI

**Key functions:**

- **Global IID generation**: [src/js/runtime/iidToLocation.js59-61](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/iidToLocation.js#L59-L61)
- **Location resolution**: [src/js/runtime/iidToLocation.js29-57](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/iidToLocation.js#L29-L57)
- **Format generation**: [src/js/runtime/iidToLocation.js46-52](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/iidToLocation.js#L46-L52)

Sources: [src/js/runtime/iidToLocation.js29-61](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/iidToLocation.js#L29-L61)

## Integration with Analysis Framework

The dlint analyses integrate with Jalangi2's broader analysis system through the `ChainedAnalyses` mechanism, allowing multiple quality checks to run simultaneously:

### Multi-Analysis Execution

The test framework demonstrates running all dlint analyses together:

```
// Analysis chain from test.dlint.py
analyses = [
    '../src/js/plugins/ChainedAnalyses.js',
    '../src/js/plugins/dlint/Utils.js',
    '../src/js/plugins/dlint/FunCalledWithMoreArguments.js',
    // ... other dlint analyses
]
```

This allows comprehensive code quality checking in a single analysis pass, with each dlint analysis contributing its specific error detection capabilities.

**Framework integration points:**

- **Analysis chaining**: [scripts/test.dlint.py6-15](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.dlint.py#L6-L15)
- **Template inheritance**: References to `analysisCallbackTemplate.js`
- **Utility sharing**: Common `Utils.js` for formatting and reporting

Sources: [scripts/test.dlint.py6-15](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.dlint.py#L6-L15)