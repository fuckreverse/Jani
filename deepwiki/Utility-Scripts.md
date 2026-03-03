# Utility Scripts
Relevant source files
- [.github/workflows/continuous-integration.yml](https://github.com/Samsung/jalangi2/blob/28d2181c/.github/workflows/continuous-integration.yml)
- [scripts/runalltests.py](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/runalltests.py)
- [scripts/sj.py](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/sj.py)
- [scripts/test.analysis.py](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.analysis.py)
- [scripts/test.dlint.py](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.dlint.py)
- [scripts/test.inst.py](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.inst.py)

This document covers the Python utility scripts, Node.js execution helpers, and testing infrastructure that support Jalangi2 development and deployment. These scripts provide automation, testing capabilities, and cross-platform Node.js execution support.

For information about the main analysis commands, see [Main Commands](/Samsung/jalangi2/3.1-main-commands). For offline instrumentation tools, see [Instrumentation Commands](/Samsung/jalangi2/3.2-instrumentation-commands).

## Node.js Execution Utilities

The core utility for Node.js execution is provided by `sj.py`, which offers cross-platform Node.js detection and execution capabilities for all Jalangi2 operations.

### Node.js Detection and Execution

The `find_node()` function provides robust Node.js executable detection across different platforms and installation paths:

```
Yes

No

find_node()

Check NODE_EXECUTABLE env var

Try standard locations

node (PATH)

/usr/bin/node

/usr/local/bin/node

C:/Program Files/nodejs/node.exe

C:/Program Files (x86)/nodejs/node.exe

is_node_exe() validation

Valid Node.js?

Cache result

Print error and exit

Return executable path
```

Sources: [scripts/sj.py28-44](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/sj.py#L28-L44)

### Script Execution Functions

The module provides multiple execution modes for different use cases:
FunctionPurposeOutput HandlingUse Case`execute()`Execute with live outputPrint to stdoutInteractive execution`execute_np()`Execute without printingReturn exit codeSilent execution`execute_return()`Execute and capture outputReturn output stringOutput processing`execute_return_np()`Execute and capture quietlyReturn output stringSilent output capture
Sources: [scripts/sj.py84-104](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/sj.py#L84-L104)

### Script Path Constants

The utility defines standard paths to core Jalangi2 commands:

```
sj.py

JALANGI_HOME

INSTRUMENTATION_SCRIPT
esnstrument_cli.js

INST_DIR_SCRIPT
instrument.js

ANALYSIS_SCRIPT
direct.js

JALANGI_SCRIPT
jalangi.js
```

Sources: [scripts/sj.py108-117](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/sj.py#L108-L117)

## Testing Infrastructure

The testing system provides comprehensive validation of Jalangi2 functionality through automated test suites and comparison frameworks.

### Test Orchestration

The main test runner coordinates multiple test suites:

```
runalltests.py

test.analysis.py
Core Analysis Tests

test.dlint.py
Code Quality Tests

test.inst.py
Instrumentation Tests

Unit Tests

SunSpider Benchmarks

Octane Benchmarks

dlint Rule Validation

Expected Output Comparison

Directory Instrumentation
```

Sources: [scripts/runalltests.py28-30](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/runalltests.py#L28-L30)

### Analysis Testing Framework

The `test.analysis.py` script implements a comparison-based testing approach:

```
"direct.js"
"esnstrument_cli.js"
"sj.py"
"test.analysis.py"
"direct.js"
"esnstrument_cli.js"
"sj.py"
"test.analysis.py"
alt
[Outputs
match]
[Outputs
differ]
create_and_cd_jalangi_tmp()
Instrument test file
Execute original file
Execute instrumented file with analysis
Compare outputs
Test passed
Test failed, print diff
cd_parent()
```

The testing process validates that instrumented code with analysis callbacks produces identical output to the original code.

Sources: [scripts/test.analysis.py6-25](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.analysis.py#L6-L25)

### Test File Processing

Test cases are organized in configuration files that specify test parameters:
Test SuiteConfiguration FilePurposeUnit Tests`tests/unit/unitTests.txt`Core functionality validationSunSpider`tests/sunspider1/unitTests.txt`JavaScript benchmark testingOctane`tests/octane/unitTests.txt`Performance benchmark testing
Each configuration file contains test case specifications with optional command-line arguments.

Sources: [scripts/test.analysis.py26-52](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.analysis.py#L26-L52)

### Code Quality Testing

The dlint testing framework validates specific code quality analyses:

```
test.dlint.py

Analysis Chain

ChainedAnalyses.js

Utils.js

FunCalledWithMoreArguments.js

CompareFunctionWithPrimitives.js

UndefinedOffset.js

CheckNaN.js

ConcatUndefinedToString.js

ShadowProtoProperty.js

Test Cases

testNaN.js

dlint1.js

dlint2.js

dlint3.js

dlint4.js

Expected Output Validation
```

The dlint tests validate specific error detection patterns with exact expected output matching.

Sources: [scripts/test.dlint.py6-15](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.dlint.py#L6-L15)[scripts/test.dlint.py34-58](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.dlint.py#L34-L58)

## Continuous Integration

The project uses GitHub Actions for automated testing across multiple Node.js versions:

```
GitHub Push/PR

CI Workflow

Node.js 10

Node.js 12

Node.js 14

npm install

npm test

runalltests.py
```

The CI configuration ensures compatibility across supported Node.js versions and runs the complete test suite on every code change.

Sources: [.github/workflows/continuous-integration.yml1-19](https://github.com/Samsung/jalangi2/blob/28d2181c/.github/workflows/continuous-integration.yml#L1-L19)

## File Management Utilities

The utility scripts provide helper functions for temporary file and directory management:
FunctionPurposeUsage`create_and_cd_jalangi_tmp()`Create isolated test environmentTest execution`cd_parent()`Return to parent directoryTest cleanup`mkempty()`Create empty fileFile initialization`full_path()`Get absolute file pathPath resolution
These utilities support isolated test execution by creating temporary working directories and managing file system operations.

Sources: [scripts/sj.py15-131](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/sj.py#L15-L131)

## Text Encoding Support

The utilities handle various text encodings for JavaScript files:

```
UTF-16

UTF-16-BE

UTF-16-LE

None

encode_input()

Check BOM

Decode UTF-16 → UTF-8

Decode UTF-16-BE → UTF-8

Decode UTF-16-LE → UTF-8

Return as-is
```

This encoding support ensures proper handling of JavaScript files with different character encodings during instrumentation and analysis.

Sources: [scripts/sj.py46-53](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/sj.py#L46-L53)