# Instrumentation Engine
Relevant source files
- [src/js/instrument/esnstrument.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js)
- [tests/unit/fun_exp.js](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/unit/fun_exp.js)

The Instrumentation Engine is the core component of Jalangi2 responsible for transforming JavaScript code by injecting runtime analysis callbacks. This system converts ordinary JavaScript into instrumented code that can be dynamically analyzed during execution. The engine performs Abstract Syntax Tree (AST) transformations to wrap JavaScript constructs with logging calls that trigger analysis hooks.

For information about the runtime execution of instrumented code, see [Runtime System](/Samsung/jalangi2/2.2-runtime-system). For details about the shadow memory system that tracks object metadata, see [Shadow Memory System](/Samsung/jalangi2/2.3-shadow-memory-system).

## Core Architecture

The Instrumentation Engine centers around `esnstrument.js`, which orchestrates the entire code transformation process using external parsing and generation libraries.

```
Output

Transformation Components

Core Engine: esnstrument.js

Input Processing

JavaScript Source Code

Config.js Settings

acorn Parser

AST Transformer

esotope Generator

AST Visitors

Wrapper Functions

Scope Manager

IID Counter

Instrumented JavaScript

Source Map Information
```

Sources: [src/js/instrument/esnstrument.js31-35](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L31-L35)[src/js/instrument/esnstrument.js1859-1876](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L1859-L1876)[src/js/instrument/esnstrument.js1916-1988](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L1916-L1988)

## Instrumentation Pipeline

The transformation process follows a multi-stage pipeline that converts source code into instrumented JavaScript with embedded analysis callbacks.

### Pipeline Flow

```
Metadata Generation

Callback Injection

Original JavaScript

acorn.parse()

addScopes()

AST with Scope Info

visitorRRPost Transform

visitorOps Transform

hoistFunctionDeclaration()

esotope.generate()

Instrumented Code

J$.F, J$.M, J$.G, J$.P

J$.C, J$.Fe, J$.Fr

iidSourceInfo

Source Map Object
```

Sources: [src/js/instrument/esnstrument.js1859-1876](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L1859-L1876)[src/js/instrument/esnstrument.js1940-1949](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L1940-L1949)[src/js/instrument/esnstrument.js1972-1978](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L1972-L1978)

### AST Visitor System

The engine uses multiple visitor patterns to traverse and transform the AST:
VisitorPurposeKey Functions`visitorRRPre`Scope setup`setScope()``visitorRRPost`Core instrumentation`wrapLiteral()`, `instrumentStore()`, `instrumentLoad()``visitorOps`Operations & control flow`wrapBinaryOp()`, `wrapConditional()`
Sources: [src/js/instrument/esnstrument.js1371-1376](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L1371-L1376)[src/js/instrument/esnstrument.js1378-1553](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L1378-L1553)[src/js/instrument/esnstrument.js1565-1633](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L1565-L1633)

## Instrumentation Types

The engine wraps different JavaScript constructs with specific logging callbacks that correspond to runtime analysis hooks.

### Function and Method Calls

```
Instrumented Code

Original Code

obj.method(args)

func(args)

J$.M(iid, obj, 'method')(args)

J$.F(iid, func)(args)
```

Sources: [src/js/instrument/esnstrument.js387-398](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L387-L398)[src/js/instrument/esnstrument.js400-409](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L400-L409)[src/js/instrument/esnstrument.js1106-1120](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L1106-L1120)

### Property Access and Assignment

The engine distinguishes between property reads (`J$.G`) and writes (`J$.P`), with special handling for computed properties:
OperationCallbackWrapper FunctionProperty Get`J$.G``wrapGetField()`Property Put`J$.P``wrapPutField()`Variable Read`J$.R``wrapRead()`Variable Write`J$.W``wrapWrite()`
Sources: [src/js/instrument/esnstrument.js411-425](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L411-L425)[src/js/instrument/esnstrument.js351-367](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L351-L367)[src/js/instrument/esnstrument.js427-441](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L427-L441)[src/js/instrument/esnstrument.js476-491](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L476-L491)

### Literal Values and Expressions

```
Instrumented Literals

Literal Types

Number: 42

String: 'hello'

Object: {}

Array: []

Function: function(){}

J$.T(iid, 42, N_LOG_NUMBER_LIT)

J$.T(iid, 'hello', N_LOG_STRING_LIT)

J$.T(iid, {}, N_LOG_OBJECT_LIT)

J$.T(iid, [], N_LOG_ARRAY_LIT)

J$.T(iid, function(){}, N_LOG_FUNCTION_LIT)
```

Sources: [src/js/instrument/esnstrument.js599-635](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L599-L635)[src/js/instrument/esnstrument.js1379-1404](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L1379-L1404)[src/js/instrument/esnstrument.js56-71](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L56-L71)

## IID Management and Source Mapping

The engine assigns unique Instrumentation IDs (IIDs) to each instrumented location and maintains mapping information for debugging and analysis.

### IID Counter System

```
Source Info

IID Generation

IID Counters

memIid: Memory Operations

condIid: Conditional Expressions

opIid: Binary/Unary Operations

getIid()

getCondIid()

getOpIid()

iidSourceInfo{}

Line/Column Mapping
```

Sources: [src/js/instrument/esnstrument.js195-226](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L195-L226)[src/js/instrument/esnstrument.js229-257](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L229-L257)[src/js/instrument/esnstrument.js1883-1888](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L1883-L1888)

## Scope Management and Variable Tracking

The engine maintains scope information to properly handle variable access patterns and avoid instrumentation conflicts.

### Scope Hierarchy

```
Scope Methods

Variable Categories

Scope Types

Global Scope

Function Scope

Catch Scope

var: Variable Declaration
arg: Function Parameter
defun: Function Declaration
lambda: Function Expression
catch: Catch Parameter

hasVar(name)

isGlobal(name)

addVar(name, type)
```

Sources: [src/js/instrument/esnstrument.js1637-1713](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L1637-L1713)[src/js/instrument/esnstrument.js1721-1796](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L1721-L1796)

## Configuration and Selective Instrumentation

The engine supports selective instrumentation through `Config` settings that allow fine-grained control over which constructs get instrumented.

### Configuration Options
Config FlagPurposeDefault`INSTR_GETFIELD`Property access instrumentation`true``INSTR_PUTFIELD`Property assignment instrumentation`true``INSTR_READ`Variable read instrumentation`true``INSTR_WRITE`Variable write instrumentation`true``INSTR_LITERAL`Literal value instrumentation`true``INSTR_BINARY`Binary operation instrumentation`true``INSTR_CONDITIONAL`Conditional expression instrumentation`true`
Sources: [src/js/instrument/esnstrument.js324-331](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L324-L331)[src/js/instrument/esnstrument.js352](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L352-L352)[src/js/instrument/esnstrument.js412](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L412-L412)[src/js/instrument/esnstrument.js428](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L428-L428)[src/js/instrument/esnstrument.js477](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L477-L477)

## Code Generation and Output

The final step produces instrumented JavaScript with embedded source mapping information and runtime initialization code.

### Output Structure

```
Source Map Information

Generated Code Components

J$.iids = {source map info}

Instrumented JavaScript Body

// JALANGI DO NOT INSTRUMENT

originalCodeFileName

instrumentedCodeFileName

Line/Column Mappings

nBranches
```

Sources: [src/js/instrument/esnstrument.js1972-1978](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L1972-L1978)[src/js/instrument/esnstrument.js1958-1971](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L1958-L1971)[src/js/instrument/esnstrument.js1881](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/instrument/esnstrument.js#L1881-L1881)