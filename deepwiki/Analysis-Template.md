# Analysis Template
Relevant source files
- [src/js/runtime/analysisCallbackTemplate.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysisCallbackTemplate.js)
- [tests/test45.js](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/test45.js)

This page explains the `MyAnalysis` callback template that serves as the foundation for developing custom analyses in Jalangi2. The template defines a standardized interface of callback methods that are invoked during JavaScript execution to enable observation and modification of program behavior.

For information about combining multiple analyses, see [Chained Analyses](/Samsung/jalangi2/4.2-chained-analyses). For the programmatic API to instrument code and run analyses, see [Programmatic API](/Samsung/jalangi2/4.3-programmatic-api).

## Template Overview

The analysis template is implemented as the `MyAnalysis` class in [src/js/runtime/analysisCallbackTemplate.js101-640](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysisCallbackTemplate.js#L101-L640) This template provides a complete interface specification with documentation and example implementations for all available callback methods.

```
Instrumented Code

Jalangi2 Runtime

Analysis Development

Developer

analysisCallbackTemplate.js
MyAnalysis Class

Custom Analysis
Implementation

J$ Sandbox

Runtime Callbacks
J$.F, J$.G, J$.P, etc.

Shadow Memory
SMemory

Instrumented JavaScript

Code Execution
```

**Analysis Template Integration Flow**

The template establishes the contract between custom analyses and the Jalangi2 runtime system. Each callback method corresponds to a specific type of JavaScript operation that can be intercepted during execution.

Sources: [src/js/runtime/analysisCallbackTemplate.js28-100](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysisCallbackTemplate.js#L28-L100)

## Callback Categories

The analysis callbacks are organized into several functional categories based on the types of JavaScript operations they monitor:
CategoryCallbacksPurpose**Function Operations**`invokeFunPre`, `invokeFun`, `functionEnter`, `functionExit`Monitor function calls and execution lifecycle**Property Access**`getFieldPre`, `getField`, `putFieldPre`, `putField`Track object property reads and writes**Variable Operations**`read`, `write`, `declare`Monitor variable access and declarations**Value Creation**`literal`, `forinObject`Track literal value creation and for-in operations**Control Flow**`conditional`, `_return`, `_throw`, `_with`Monitor branching and control flow changes**Operations**`binaryPre`, `binary`, `unaryPre`, `unary`Track arithmetic and logical operations**Script Lifecycle**`scriptEnter`, `scriptExit`, `endExecution`Monitor script execution boundaries**Code Generation**`instrumentCodePre`, `instrumentCode`Control dynamic code instrumentation
```
MyAnalysis Callbacks

JavaScript Operations

Function Call
f(args)

Property Get
obj.prop

Property Set
obj.prop = val

Variable Read
x

Variable Write
x = val

Literal
'string', 42, {}

Binary Op
a + b

Conditional
if (x)

invokeFunPre()

invokeFun()

getFieldPre()

getField()

putFieldPre()

putField()

read()

write()

literal()

binaryPre()

binary()

conditional()
```

**JavaScript Operation to Callback Mapping**

Sources: [src/js/runtime/analysisCallbackTemplate.js142-625](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysisCallbackTemplate.js#L142-L625)

## Core Callback Patterns

### Pre/Post Callback Pairs

Many operations use paired callbacks that execute before and after the operation. The "Pre" callback can modify inputs or skip the operation entirely, while the "Post" callback can observe or modify results.

**Function Invocation Pattern:**

- `invokeFunPre(iid, f, base, args, isConstructor, isMethod, functionIid, functionSid)`[src/js/runtime/analysisCallbackTemplate.js142-144](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysisCallbackTemplate.js#L142-L144)
- `invokeFun(iid, f, base, args, result, isConstructor, isMethod, functionIid, functionSid)`[src/js/runtime/analysisCallbackTemplate.js190-192](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysisCallbackTemplate.js#L190-L192)

**Property Access Pattern:**

- `getFieldPre(iid, base, offset, isComputed, isOpAssign, isMethodCall)`[src/js/runtime/analysisCallbackTemplate.js288-290](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysisCallbackTemplate.js#L288-L290)
- `getField(iid, base, offset, val, isComputed, isOpAssign, isMethodCall)`[src/js/runtime/analysisCallbackTemplate.js307-309](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysisCallbackTemplate.js#L307-L309)

### Return Object Specifications

Callbacks can return objects with specific properties to control execution behavior:
PropertyPurposeAvailable In`skip`Skip the actual operationPre callbacks`result`Replace the operation resultPost callbacks, some pre callbacks`isBacktrack`Re-execute function/script body`functionExit`, `scriptExit`Operation-specificReplace operation inputsVarious callbacks
```
Effects

Callback Return Patterns

Skip Pattern
{skip: true}

Result Pattern
{result: newValue}

Modify Pattern
{f: newF, args: newArgs}

Backtrack Pattern
{isBacktrack: true}

Operation Skipped

Modified Result

Modified Input

Re-execution
```

**Callback Return Value Effects**

Sources: [src/js/runtime/analysisCallbackTemplate.js36-49](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysisCallbackTemplate.js#L36-L49)

## Key Callback Methods

### Function Monitoring

The function-related callbacks provide comprehensive monitoring of JavaScript function execution:

**`invokeFunPre`** - Called before function invocation with the ability to modify or skip the call [src/js/runtime/analysisCallbackTemplate.js142-144](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysisCallbackTemplate.js#L142-L144)

**`functionEnter`** - Called when entering a function body, useful for tracking execution context [src/js/runtime/analysisCallbackTemplate.js424-425](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysisCallbackTemplate.js#L424-L425)

**`functionExit`** - Called when exiting a function, supports backtracking for symbolic execution [src/js/runtime/analysisCallbackTemplate.js442-444](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysisCallbackTemplate.js#L442-L444)

### Property Access Monitoring

Property access callbacks enable tracking of object property interactions:

**`getFieldPre`/`getField`** - Monitor property reads, including method calls [src/js/runtime/analysisCallbackTemplate.js288-309](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysisCallbackTemplate.js#L288-L309)

**`putFieldPre`/`putField`** - Monitor property writes and assignments [src/js/runtime/analysisCallbackTemplate.js326-346](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysisCallbackTemplate.js#L326-L346)

### Variable Access Monitoring

Variable callbacks track all variable operations in the program:

**`declare`** - Called for variable declarations, parameters, and function definitions [src/js/runtime/analysisCallbackTemplate.js268-270](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysisCallbackTemplate.js#L268-L270)

**`read`** - Called when reading variable values [src/js/runtime/analysisCallbackTemplate.js359-361](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysisCallbackTemplate.js#L359-L361)

**`write`** - Called when writing to variables [src/js/runtime/analysisCallbackTemplate.js375-377](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysisCallbackTemplate.js#L375-L377)

## Source Map Integration

The analysis template provides access to source mapping information through the global `J$.smap` object. This enables analyses to correlate instruction identifiers (`iid`) with source code locations.

**Source Map Structure:**

- `J$.smap[sid]` - Maps script ID to source information
- `J$.getGlobalIID(iid)` - Creates global instruction identifier
- `J$.iidToLocation(giid)` - Maps global IID to source location

Key properties available in source map objects [src/js/runtime/analysisCallbackTemplate.js58-78](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysisCallbackTemplate.js#L58-L78):

- `originalCodeFileName` - Original script file path
- `instrumentedCodeFileName` - Instrumented script file path
- `url` - Optional script URL
- `nBranches` - Number of conditional statements
- `code` - Original source code (with --inlineSource)

Sources: [src/js/runtime/analysisCallbackTemplate.js58-89](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysisCallbackTemplate.js#L58-L89)

## Implementation Guidelines

### Passive vs. Active Analysis

**Passive Analysis:** Return nothing from callbacks to observe execution without modification [src/js/runtime/analysisCallbackTemplate.js36-39](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysisCallbackTemplate.js#L36-L39)

**Active Analysis:** Return objects with appropriate properties to modify execution behavior [src/js/runtime/analysisCallbackTemplate.js39-49](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysisCallbackTemplate.js#L39-L49)

### Asynchronous Initialization

The `onReady` callback supports asynchronous initialization for Node.js environments [src/js/runtime/analysisCallbackTemplate.js637-639](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysisCallbackTemplate.js#L637-L639):

```
this.onReady = function (cb) {
    // Perform async initialization
    cb(); // Signal ready to start execution
};
```

### Sampling Support

The `runInstrumentedFunctionBody` callback enables selective instrumentation when `J$.Config.ENABLE_SAMPLING = true`[src/js/runtime/analysisCallbackTemplate.js623-625](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysisCallbackTemplate.js#L623-L625)

Sources: [src/js/runtime/analysisCallbackTemplate.js627-640](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysisCallbackTemplate.js#L627-L640)