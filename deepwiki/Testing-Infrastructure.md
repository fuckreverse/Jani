# Testing Infrastructure
Relevant source files
- [scripts/test.analysis.py](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.analysis.py)
- [scripts/test.dlint.py](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.dlint.py)
- [tests/sunspider1/unitTests.txt](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/sunspider1/unitTests.txt)
- [tests/unit/es6_const.js](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/unit/es6_const.js)
- [tests/unit/obj_prototype_eval.js](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/unit/obj_prototype_eval.js)
- [tests/unit/shebang.js](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/unit/shebang.js)
- [tests/unit/unitTests.txt](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/unit/unitTests.txt)

This document covers Jalangi2's comprehensive testing infrastructure, including test suite organization, automated test execution scripts, and the various categories of tests used to validate the framework's correctness. The testing system ensures that JavaScript instrumentation, runtime analysis, and sample analyses work correctly across different JavaScript language features and execution environments.

For information about developing custom analyses, see [Analysis Development](/Samsung/jalangi2/4-analysis-development). For details about the specific sample analyses being tested, see [Sample Analyses](/Samsung/jalangi2/5-sample-analyses).

## Test Suite Organization

Jalangi2's testing infrastructure is organized into several distinct test suites, each targeting different aspects of the framework's functionality.

### Test Suite Structure

```
Test Orchestration

Test Execution Scripts

Test Configuration

Test Suites

tests/unit/
Core Language Features

tests/sunspider1/
Performance Benchmarks

tests/octane/
Modern JS Benchmarks

tests/dlint/
Code Quality Analysis

unitTests.txt
Test Case Lists

*.js Test Files
Individual Test Cases

test.analysis.py
Main Test Runner

test.dlint.py
DLint Test Runner

sj.py
Test Utilities

runalltests.py
Complete Test Suite

Travis CI
Continuous Integration
```

Sources: [tests/unit/unitTests.txt1-67](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/unit/unitTests.txt#L1-L67)[tests/sunspider1/unitTests.txt1-22](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/sunspider1/unitTests.txt#L1-L22)[scripts/test.analysis.py1-54](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.analysis.py#L1-L54)[scripts/test.dlint.py1-61](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.dlint.py#L1-L61)

### Unit Test Categories

The unit test suite covers core JavaScript language features and edge cases:
CategoryExamplesPurpose**Language Constructs**`for_in`, `switch`, `try_catch_finally_2`Test control flow instrumentation**Object Operations**`gettersetter`, `prototype_property`, `object_lit`Validate object manipulation tracking**Function Calls**`fun_call`, `call_order1`, `method_sub`Ensure function instrumentation accuracy**Variable Access**`field_read`, `field_inc`, `vars`Test variable read/write instrumentation**Edge Cases**`eval_global`, `shebang`, `JSON_nan_bug`Handle special JavaScript scenarios**Type Operations**`boolean`, `string`, `instanceof`Validate type conversion tracking
Sources: [tests/unit/unitTests.txt1-67](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/unit/unitTests.txt#L1-L67)

## Test Execution Infrastructure

### Analysis Test Runner

The primary test execution is handled by `test.analysis.py`, which implements a comprehensive testing workflow:

```
Success

Failure

Match

Mismatch

Yes

No

Test Execution Start

Read unitTests.txt

Parse Test Arguments

sj.create_and_cd_jalangi_tmp()

Execute Instrumentation
sj.INSTRUMENTATION_SCRIPT

Instrumentation
Success?

Execute Normal JS
prefix+file+'.js '+rest

Mark Test Failed

Execute with Analysis
sj.ANALYSIS_SCRIPT + ChainedAnalyses

Compare Outputs
normal != ana

Test Passed

sj.cd_parent()

More Tests?

exit(status)
```

Sources: [scripts/test.analysis.py6-25](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.analysis.py#L6-L25)

### Test Execution Details

The test runner performs the following operations for each test case:

1. **Environment Setup**: Creates temporary directory using `sj.create_and_cd_jalangi_tmp()`[scripts/test.analysis.py8](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.analysis.py#L8-L8)
2. **Instrumentation**: Executes instrumentation with `--inlineIID --inlineSource` flags [scripts/test.analysis.py9](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.analysis.py#L9-L9)
3. **Dual Execution**: Runs both original and instrumented versions [scripts/test.analysis.py12-13](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.analysis.py#L12-L13)
4. **Output Comparison**: Validates that outputs match exactly [scripts/test.analysis.py14](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.analysis.py#L14-L14)
5. **Cleanup**: Returns to parent directory [scripts/test.analysis.py24](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.analysis.py#L24-L24)

### DLint Analysis Testing

The `test.dlint.py` script provides specialized testing for code quality analyses:

```
Expected Outputs

Test Cases

DLint Test Configuration

Analysis Chain
ChainedAnalyses.js
Utils.js
FunCalledWithMoreArguments.js
CompareFunctionWithPrimitives.js
UndefinedOffset.js
CheckNaN.js
ConcatUndefinedToString.js
ShadowProtoProperty.js

testNaN.js
NaN Detection

dlint1.js
Undefined Access + Prototype Shadow

dlint2.js
Function Argument Mismatch

dlint3.js
Undefined String Concatenation

dlint4.js
Function-Primitive Comparison

Hard-coded Expected Results
Line Numbers + Occurrence Counts
```

Sources: [scripts/test.dlint.py6-13](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.dlint.py#L6-L13)[scripts/test.dlint.py17-31](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.dlint.py#L17-L31)

## Test Categories and Coverage

### Core Language Feature Tests

The unit test suite provides comprehensive coverage of JavaScript language constructs:

**Control Flow Tests**:

- `do_while`, `while`: Loop constructs [tests/unit/unitTests.txt15-57](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/unit/unitTests.txt#L15-L57)
- `for_and_seq`, `for_in`, `forin1-6`: For loop variations [tests/unit/unitTests.txt24-30](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/unit/unitTests.txt#L24-L30)
- `switch`, `switch2`: Switch statement handling [tests/unit/unitTests.txt51-52](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/unit/unitTests.txt#L51-L52)
- `cond`: Conditional expressions [tests/unit/unitTests.txt12](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/unit/unitTests.txt#L12-L12)

**Function and Method Tests**:

- `fun_call`: Function invocation [tests/unit/unitTests.txt32](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/unit/unitTests.txt#L32-L32)
- `call_order1`: Call sequence validation [tests/unit/unitTests.txt11](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/unit/unitTests.txt#L11-L11)
- `method_sub`: Method substitution [tests/unit/unitTests.txt42](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/unit/unitTests.txt#L42-L42)

**Object and Property Tests**:

- `object_lit`: Object literal creation [tests/unit/unitTests.txt44](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/unit/unitTests.txt#L44-L44)
- `gettersetter`, `gettersetter2`: Property accessor methods [tests/unit/unitTests.txt34-35](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/unit/unitTests.txt#L34-L35)
- `prototype_property`: Prototype chain operations [tests/unit/unitTests.txt47](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/unit/unitTests.txt#L47-L47)

Sources: [tests/unit/unitTests.txt1-67](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/unit/unitTests.txt#L1-L67)

### Benchmark Test Suites

**SunSpider Benchmarks**: Classic JavaScript performance tests including:

- Cryptographic algorithms: `crypto-aes`, `crypto-md5`, `crypto-sha1`[tests/sunspider1/unitTests.txt1-13](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/sunspider1/unitTests.txt#L1-L13)
- 3D graphics: `3d-cube`, `3d-morph`, `3d-raytrace`[tests/sunspider1/unitTests.txt2-4](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/sunspider1/unitTests.txt#L2-L4)
- Mathematical computations: `math-cordic`, `math-partial-sums`[tests/sunspider1/unitTests.txt15-16](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/sunspider1/unitTests.txt#L15-L16)

**Octane Benchmarks**: Modern JavaScript performance tests for ES5+ features [scripts/test.analysis.py44-51](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.analysis.py#L44-L51)

Sources: [tests/sunspider1/unitTests.txt1-22](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/sunspider1/unitTests.txt#L1-L22)[scripts/test.analysis.py35-51](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.analysis.py#L35-L51)

### Analysis-Specific Tests

**DLint Code Quality Tests**:

- `testNaN`: NaN value detection [scripts/test.dlint.py36](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.dlint.py#L36-L36)
- `dlint1`: Undefined property access and prototype shadowing [scripts/test.dlint.py43](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.dlint.py#L43-L43)
- `dlint2`: Function argument count mismatches [scripts/test.dlint.py49](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.dlint.py#L49-L49)
- `dlint3`: Undefined string concatenation [scripts/test.dlint.py54](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.dlint.py#L54-L54)
- `dlint4`: Function-primitive comparisons [scripts/test.dlint.py58](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.dlint.py#L58-L58)

Sources: [scripts/test.dlint.py34-59](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.dlint.py#L34-L59)

## Test Automation and Utilities

### Test Utility Functions

The `sj.py` module provides essential test infrastructure utilities:
FunctionPurpose`sj.create_and_cd_jalangi_tmp()`Create isolated test environment`sj.execute_np()`Execute commands without output capture`sj.execute_return_np()`Execute commands with output capture`sj.cd_parent()`Clean up test environment`sj.INSTRUMENTATION_SCRIPT`Path to instrumentation command`sj.ANALYSIS_SCRIPT`Path to analysis execution command
Sources: [scripts/test.analysis.py8-24](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.analysis.py#L8-L24)

### Continuous Integration Integration

The testing infrastructure integrates with continuous integration systems:

1. **Test Orchestration**: `runalltests.py` coordinates execution of all test suites
2. **CI Configuration**: Travis CI configuration in `.travis.yml` automates testing
3. **Exit Status Handling**: Tests report success/failure status for CI systems [scripts/test.analysis.py53](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.analysis.py#L53-L53)[scripts/test.dlint.py60](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.dlint.py#L60-L60)

### Test Result Validation

Test validation follows different strategies based on test type:

**Output Comparison Tests**: Most unit and benchmark tests validate by comparing execution outputs between original and instrumented code [scripts/test.analysis.py14](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.analysis.py#L14-L14)

**Expected Output Tests**: DLint tests validate against pre-defined expected outputs with specific error messages and line numbers [scripts/test.dlint.py22](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.dlint.py#L22-L22)

**Error Condition Tests**: Some tests validate that specific errors or edge cases are handled correctly

Sources: [scripts/test.analysis.py14-23](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.analysis.py#L14-L23)[scripts/test.dlint.py22-30](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/test.dlint.py#L22-L30)