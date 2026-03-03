# Coverage Analysis
Relevant source files
- [scripts/instrument_folder_coverage.sh](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/instrument_folder_coverage.sh)
- [src/commands/loadjalangi.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/commands/loadjalangi.js)
- [src/plugins/coverage/AddCoverage.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/AddCoverage.js)
- [src/plugins/coverage/ProcessCoverage.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/ProcessCoverage.js)
- [src/plugins/coverage/SpecialCoverage.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/SpecialCoverage.js)
- [src/plugins/coverage/mocha_prefix.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/mocha_prefix.js)
- [src/plugins/coverage/tests/FeaturesMain.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/tests/FeaturesMain.js)
- [src/plugins/coverage/tests/FeaturesTest.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/tests/FeaturesTest.js)
- [src/plugins/coverage/tests/SetTest.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/tests/SetTest.js)
- [tests/unit/branch.js](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/unit/branch.js)

## Purpose and Scope

The Coverage Analysis system provides comprehensive code coverage tracking capabilities for JavaScript applications instrumented with Jalangi2. This system records execution coverage at statement and branch levels, manages coverage features across multiple test cases, and supports advanced coverage analysis techniques including test case minimization and delta debugging.

For information about other analysis capabilities, see [Execution Tracing](/Samsung/jalangi2/5.2-execution-tracing), [Code Quality Analysis](/Samsung/jalangi2/5.3-code-quality-analysis), and [Branch Coverage](/Samsung/jalangi2/5.4-branch-coverage).

## System Architecture

The coverage analysis system consists of several interconnected components that work together to collect, process, and analyze coverage data.

### Coverage Analysis Components

```
Integration Points

Coverage Processing

Coverage Data Management

Coverage Collection

SpecialCoverage.js
Branch & Statement Tracking

instrument_folder_coverage.sh
Batch Instrumentation

AddCoverage.js
Feature Management

Set Data Structure
Multi-dimensional Coverage Sets

Feature Graph
Test-Feature Relationships

ProcessCoverage.js
Multi-test Aggregation

Delta Debugging
Test Minimization

Coverage JSON Files
Serialized Results

mocha_prefix.js
Test Framework Integration

loadjalangi.js
Instrumentation Command
```

Sources: [src/plugins/coverage/AddCoverage.js1-573](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/AddCoverage.js#L1-L573)[src/plugins/coverage/SpecialCoverage.js1-92](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/SpecialCoverage.js#L1-L92)[src/plugins/coverage/ProcessCoverage.js1-92](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/ProcessCoverage.js#L1-L92)

### Coverage Data Flow

```
JavaScript Source Files

instrument_folder_coverage.sh

loadjalangi.js --analysis AddCoverage.js --analysis SpecialCoverage.js

Instrumented JavaScript

Test Execution

SpecialCoverage.conditional()

SpecialCoverage.endExpression()

branches[] array
Per-file branch data

AddCoverage.addCoverage()

features[] array
Coverage feature sets

tests[] array
Test case data

featureGraph object
Feature relationships

tmp/features.json
Persistent storage

tmp/results.json
Execution results

ProcessCoverage.js

allcoverage.json
Aggregated results
```

Sources: [scripts/instrument_folder_coverage.sh1-16](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/instrument_folder_coverage.sh#L1-L16)[src/plugins/coverage/SpecialCoverage.js55-67](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/SpecialCoverage.js#L55-L67)[src/plugins/coverage/AddCoverage.js281-348](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/AddCoverage.js#L281-L348)

## Core Components

### SpecialCoverage Analysis

The `SpecialCoverage` class implements the Jalangi2 analysis interface to track branch and statement coverage during execution.

**Key Methods:**

- `conditional(iid, result)` - Records branch coverage based on conditional evaluation [src/plugins/coverage/SpecialCoverage.js55-62](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/SpecialCoverage.js#L55-L62)
- `endExpression(iid)` - Records statement-level coverage [src/plugins/coverage/SpecialCoverage.js64-67](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/SpecialCoverage.js#L64-L67)
- `endExecution(noadd)` - Processes collected coverage data and invokes feature management [src/plugins/coverage/SpecialCoverage.js69-83](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/SpecialCoverage.js#L69-L83)

**Coverage Data Structure:**

- `branches[]` - Array indexed by script ID (`J$.sid - 1`)
- `branchSidToFileName[]` - Maps script IDs to original file names
- Coverage values: `1` for taken branches, `2` for executed statements

Sources: [src/plugins/coverage/SpecialCoverage.js28-87](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/SpecialCoverage.js#L28-L87)

### AddCoverage Feature Management

The `AddCoverage` module provides sophisticated coverage feature tracking and test case management.

#### Set Data Structure

The `Set` class implements a multi-dimensional set for tracking coverage elements:

```
Internal Structure

Set Operations

add(...args)
Insert coverage element

contains(...args)
Check membership

split(coverage)
Partition based on coverage

clone()
Deep copy

set: boolean | object

children: Object

isFinal: boolean

count: number

intersection: Set

difference: Set
```

**Key Methods:**

- `add(...args)` - Adds multi-dimensional coverage elements [src/plugins/coverage/AddCoverage.js24-52](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/AddCoverage.js#L24-L52)
- `split(coverage)` - Partitions set based on coverage type matching [src/plugins/coverage/AddCoverage.js175-187](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/AddCoverage.js#L175-L187)
- `contains(...args)` - Tests membership of coverage elements [src/plugins/coverage/AddCoverage.js54-71](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/AddCoverage.js#L54-L71)

Sources: [src/plugins/coverage/AddCoverage.js14-196](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/AddCoverage.js#L14-L196)

#### Feature Graph Management

The system maintains a directed graph representing relationships between coverage features:

**Data Structures:**

- `features[]` - Array of feature objects with `coverage`, `tests`, and `index` properties
- `tests[]` - Array of test code strings
- `featureGraph` - Object mapping feature indices to dependent features

**Key Functions:**

- `addCoverage(testCode, coverage, forceAdd)` - Primary entry point for adding coverage data [src/plugins/coverage/AddCoverage.js281-348](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/AddCoverage.js#L281-L348)
- `addEdge(x, y)` - Adds dependency relationship between features [src/plugins/coverage/AddCoverage.js201-208](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/AddCoverage.js#L201-L208)
- `resetEdges(x, testIndex)` - Updates edges based on test coverage [src/plugins/coverage/AddCoverage.js238-248](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/AddCoverage.js#L238-L248)

Sources: [src/plugins/coverage/AddCoverage.js197-348](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/AddCoverage.js#L197-L348)

### Delta Debugging Integration

The system includes delta debugging functionality for test case minimization:

```
Combined Test String

deltaDebug(str, predicate)

predicate(str)
Test execution & validation

Execute test via shelljs

Check tmp/results.json

Minimal test case

Write mintest*.js files
```

**Delta Debugging Process:**

- `getMinTestForEachFeature()` - Finds minimal test cases for each coverage feature [src/plugins/coverage/AddCoverage.js488-556](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/AddCoverage.js#L488-L556)
- `deltaDebug(str, pred)` - Implements delta debugging algorithm [src/plugins/coverage/AddCoverage.js444-486](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/AddCoverage.js#L444-L486)
- Predicate function executes test cases and validates coverage results

Sources: [src/plugins/coverage/AddCoverage.js422-556](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/AddCoverage.js#L422-L556)

## Coverage Types and Constants

The system uses specific coverage type constants:
ConstantValuePurpose`coverageType`1Active coverage elements`unusedCoverageType`3Previously covered elements
Coverage data maps file names to objects containing instruction ID (`iid`) to coverage type mappings.

Sources: [src/plugins/coverage/AddCoverage.js3-4](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/AddCoverage.js#L3-L4)[src/plugins/coverage/AddCoverage.js179-181](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/AddCoverage.js#L179-L181)

## Integration and Usage

### Mocha Test Framework Integration

The system integrates with Mocha through callback hooks:

```
// mocha_prefix.js content
beforeEach(function() {
    J$.analysis.beginExecution();
});
 
afterEach(function() {
    J$.analysis.endExecution();
});
```

Sources: [src/plugins/coverage/mocha_prefix.js1-8](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/mocha_prefix.js#L1-L8)

### Batch Instrumentation

The `instrument_folder_coverage.sh` script provides batch instrumentation for entire directories:

**Process:**

1. Finds all `.js` files in target directory
2. Backs up originals as `.org` files
3. Instruments with both `AddCoverage.js` and `SpecialCoverage.js` analyses
4. Replaces original files with instrumented versions

**Command:**`loadjalangi.js --inlineIID --inlineSource --analysis AddCoverage.js --analysis SpecialCoverage.js`

Sources: [scripts/instrument_folder_coverage.sh5-16](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/instrument_folder_coverage.sh#L5-L16)

### Coverage Data Processing

The `ProcessCoverage.js` utility aggregates coverage data from multiple test runs:

**Input:** Multiple `coverage*.json` files
**Output:**`allcoverage.json` containing:

- `statementMap` - Source location mapping for coverage elements
- `testCov` - Per-test coverage data

**Usage:**`node ProcessCoverage.js 1|2` (1 for branch coverage, 2 for statement coverage)

Sources: [src/plugins/coverage/ProcessCoverage.js10-70](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/ProcessCoverage.js#L10-L70)

## API Interface

The system exports a public API through `sandbox.Features`:
MethodPurpose`Set`Access to Set constructor`addCoverage(testCode, coverage, forceAdd)`Add coverage data`getFeaturesFromTest(testIndex)`Get features covered by test`getTestsFromFeature(index)`Get tests covering feature`getTestCode(testIndex)`Retrieve test code string`loadFeatures()`Load persistent feature data`storeFeatures()`Save feature data to disk
Sources: [src/plugins/coverage/AddCoverage.js559-567](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/coverage/AddCoverage.js#L559-L567)