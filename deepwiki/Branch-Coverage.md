# Branch Coverage
Relevant source files
- [src/plugins/pldi16/BranchCoverage.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/pldi16/BranchCoverage.js)
- [tests/pldi16/BranchCoverageTest.html](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/pldi16/BranchCoverageTest.html)
- [tests/pldi16/BranchCoverageTest.js](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/pldi16/BranchCoverageTest.js)

## Purpose and Scope

This document describes the branch coverage analysis implementation in Jalangi2, which tracks the execution of conditional branches in JavaScript code. The analysis records how many times each branch condition evaluates to true versus false during program execution.

For general coverage analysis concepts and other coverage types, see [Coverage Analysis](/Samsung/jalangi2/5.1-coverage-analysis). For broader execution tracing capabilities, see [Execution Tracing](/Samsung/jalangi2/5.2-execution-tracing).

## Implementation Overview

The branch coverage analysis is implemented as a Jalangi2 analysis class in [src/plugins/pldi16/BranchCoverage.js13-27](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/pldi16/BranchCoverage.js#L13-L27) It extends the standard analysis template by implementing the `conditional` callback to track branch execution patterns.
ComponentPurposeKey Data Structures`MyAnalysis` classMain analysis implementationN/A`trueBranches` objectTracks true branch executions`{iid: count}` mapping`falseBranches` objectTracks false branch executions`{iid: count}` mapping`conditional` callbackIntercepts branch evaluationsN/A`endExecution` callbackReports final resultsN/A
Sources: [src/plugins/pldi16/BranchCoverage.js10-27](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/pldi16/BranchCoverage.js#L10-L27)

## Branch Tracking Mechanism

The analysis uses Jalangi2's runtime callback system to intercept conditional evaluations and maintain execution counts for each branch direction.

```
Yes

No

JavaScript Code with Conditionals

Instrumented Code

Runtime Execution

conditional(iid, result)

result === true?

trueBranches[globalIID]++

falseBranches[globalIID]++

trueBranches Object

falseBranches Object

endExecution()

print(trueBranches, 'True')

print(falseBranches, 'False')

sandbox.log() output
```

Sources: [src/plugins/pldi16/BranchCoverage.js15-26](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/pldi16/BranchCoverage.js#L15-L26)

## Core Implementation Details

### Conditional Callback Handler

The `conditional` callback intercepts every branch evaluation in the instrumented code:

```
this.conditional = function (iid, result) {
    var id = J$.getGlobalIID(iid);
    if (result)
        trueBranches[id] = (trueBranches[id]|0) + 1;
    else
        falseBranches[id] = (falseBranches[id]|0) + 1;
};
```

The implementation uses `J$.getGlobalIID(iid)` to convert local instruction identifiers to globally unique identifiers, enabling consistent tracking across different execution contexts.

Sources: [src/plugins/pldi16/BranchCoverage.js15-21](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/pldi16/BranchCoverage.js#L15-L21)

### Results Reporting System

The analysis reports results through the `endExecution` callback and helper `print` function:

```
endExecution()

print(trueBranches, 'True')

print(falseBranches, 'False')

Iterate trueBranches

Iterate falseBranches

sandbox.log('True branch taken at...')

sandbox.log('False branch taken at...')

J$.iidToLocation(id)

J$.iidToLocation(id)
```

Sources: [src/plugins/pldi16/BranchCoverage.js23-34](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/pldi16/BranchCoverage.js#L23-L34)

## Usage Examples

### Command Line Execution

The analysis can be executed in multiple modes as demonstrated in the source comments:
ModeCommandPurposeOn-the-fly`jalangi.js --inlineIID --inlineSource --analysis BranchCoverage.js`Direct execution with analysisOffline HTML`esnstrument_cli.js --analysis BranchCoverage.js --out file.html`Browser executionOffline JS`esnstrument_cli.js --analysis BranchCoverage.js --out file.js`Node.js execution
Sources: [src/plugins/pldi16/BranchCoverage.js40-43](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/pldi16/BranchCoverage.js#L40-L43)

### Test Case Analysis

The provided test case demonstrates branch coverage on various JavaScript constructs:

```
for(var i=0; i<10; i++)

if (i % 3 === 0)

switch(i)

if (i <= -1)

True: 4 times (i=0,3,6,9)

False: 6 times

case 2, case 3

case 9, case 11

default

True: 0 times

False: 10 times
```

Sources: [tests/pldi16/BranchCoverageTest.js2-26](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/pldi16/BranchCoverageTest.js#L2-L26)

## Output Format

The analysis generates human-readable output showing branch execution statistics:

- **True branches**: `"True branch taken at [location] [count] times"`
- **False branches**: `"False branch taken at [location] [count] times"`

Each output line includes:

- Branch direction (True/False)
- Source location via `J$.iidToLocation(id)`
- Execution count for that branch direction

The location information is provided by Jalangi2's source mapping system when `--inlineIID` and `--inlineSource` options are used.

Sources: [src/plugins/pldi16/BranchCoverage.js29-34](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/pldi16/BranchCoverage.js#L29-L34)

## Integration with Jalangi2 Runtime

### Sandbox Registration

The analysis registers itself with the Jalangi2 sandbox system using the standard pattern:

```
sandbox.analysis = new MyAnalysis();
```

This integration allows the analysis to receive runtime callbacks from the instrumented code execution.

Sources: [src/plugins/pldi16/BranchCoverage.js36](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/pldi16/BranchCoverage.js#L36-L36)

### Runtime Callback Flow

```
"Shadow Memory"
"BranchCoverage Analysis"
"J$ Runtime"
"Instrumented Code"
"Shadow Memory"
"BranchCoverage Analysis"
"J$ Runtime"
"Instrumented Code"
"Execute conditional"
"conditional(iid, result)"
"J$.getGlobalIID(iid)"
"Global IID"
"Update branch counters"
"Program end"
"endExecution()"
"J$.iidToLocation(id)"
"Source location"
"sandbox.log(results)"
```

Sources: [src/plugins/pldi16/BranchCoverage.js15-34](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/pldi16/BranchCoverage.js#L15-L34)