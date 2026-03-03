# Core Architecture
Relevant source files
- [src/instrument/esnstrument.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/instrument/esnstrument.js)
- [src/runtime/analysis.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/runtime/analysis.js)
- [tests/test47.js](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/test47.js)
- [tests/unit/fun_exp.js](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/unit/fun_exp.js)

This document explains the fundamental components of Jalangi2's dynamic analysis framework and how they work together to enable JavaScript program analysis. The architecture consists of three primary systems: the instrumentation engine, the runtime system, and the shadow memory system.

For detailed implementation information about each component, see [Instrumentation Engine](/Samsung/jalangi2/2.1-instrumentation-engine), [Runtime System](/Samsung/jalangi2/2.2-runtime-system), and [Shadow Memory System](/Samsung/jalangi2/2.3-shadow-memory-system). For information about developing custom analyses using this architecture, see [Analysis Development](/Samsung/jalangi2/4-analysis-development).

## System Overview

Jalangi2's core architecture enables dynamic analysis of JavaScript programs through a three-stage process: code transformation, runtime execution with callback interception, and metadata tracking. The system transforms original JavaScript code by injecting analysis callbacks, executes the instrumented code within a controlled runtime environment, and maintains shadow objects to track program state.

```
Analysis Layer

Output Generation

Input Processing

Core Components

esnstrument.js
AST Transformation Engine

analysis.js
J$ Runtime Sandbox

SMemory
Shadow Memory System

Original JavaScript Code

acorn Parser

Abstract Syntax Tree

Instrumented JavaScript

esotope Generator

Executing Program

Custom Analysis Objects

Analysis Callbacks
```

**Sources:**[src/instrument/esnstrument.js1-50](https://github.com/Samsung/jalangi2/blob/28d2181c/src/instrument/esnstrument.js#L1-L50)[src/runtime/analysis.js1-50](https://github.com/Samsung/jalangi2/blob/28d2181c/src/runtime/analysis.js#L1-L50)

## Instrumentation Engine

The instrumentation engine, implemented in `esnstrument.js`, serves as the core transformation system that converts standard JavaScript code into analysis-ready instrumented code. It parses JavaScript using the `acorn` parser, transforms the Abstract Syntax Tree (AST) by injecting callback invocations, and generates new JavaScript code using the `esotope` code generator.

The engine injects specific callback functions at key program points:
Callback FunctionPurposeInjection Point`J$.F`Function callsBefore function invocation`J$.M`Method callsBefore method invocation`J$.G`Property readsDuring field access`J$.P`Property writesDuring field assignment`J$.R`Variable readsDuring variable access`J$.W`Variable writesDuring variable assignment`J$.Fe`Function entryAt function start`J$.Fr`Function exitAt function end`J$.Se`Script entryAt script start`J$.Sr`Script exitAt script end
```
Transformation Rules

JavaScript Source

acorn.parse()

Original AST

astUtil.transformAst()

Function Calls → J$.F()

Method Calls → J$.M()

Property Access → J$.G()

Property Assignment → J$.P()

Variable Read → J$.R()

Variable Write → J$.W()

Instrumented AST

esotope.generate()

Instrumented JavaScript
```

**Sources:**[src/instrument/esnstrument.js73-106](https://github.com/Samsung/jalangi2/blob/28d2181c/src/instrument/esnstrument.js#L73-L106)[src/instrument/esnstrument.js333-441](https://github.com/Samsung/jalangi2/blob/28d2181c/src/instrument/esnstrument.js#L333-L441)

## Runtime System

The runtime system, implemented in `analysis.js`, provides the `J$` sandbox environment that executes instrumented JavaScript code. The sandbox object contains all the callback functions injected by the instrumentation engine and manages the execution context, analysis invocation, and exception handling.

Key runtime components include:

- **J$ Sandbox Object**: Contains all runtime callback functions (`J$.F`, `J$.M`, `J$.G`, etc.)
- **Analysis Management**: Routes callbacks to registered analysis objects
- **Execution Context**: Maintains call stacks, return values, and exception state
- **Script/Function Lifecycle**: Handles entry/exit events and scope management

```
Analysis Integration

Execution Management

J$ Sandbox Functions

J$.F(iid, f, flags)
Function Call Handler

J$.M(iid, base, offset, flags)
Method Call Handler

J$.G(iid, base, offset, flags)
Property Read Handler

J$.P(iid, base, offset, val, flags)
Property Write Handler

J$.R(iid, name, val, flags)
Variable Read Handler

J$.W(iid, name, val, lhs, flags)
Variable Write Handler

J$.Fe(iid, f, dis, args)
Function Entry

J$.Fr(iid)
Function Exit

J$.Se(iid, val, origFileName)
Script Entry

J$.Sr(iid)
Script Exit

sandbox.analysis
Analysis Object Reference

Analysis Callback Methods

Analysis Results
```

**Sources:**[src/runtime/analysis.js228-244](https://github.com/Samsung/jalangi2/blob/28d2181c/src/runtime/analysis.js#L228-L244)[src/runtime/analysis.js454-518](https://github.com/Samsung/jalangi2/blob/28d2181c/src/runtime/analysis.js#L454-L518)[src/runtime/analysis.js29-52](https://github.com/Samsung/jalangi2/blob/28d2181c/src/runtime/analysis.js#L29-L52)

## Shadow Memory System

The shadow memory system provides metadata tracking capabilities that enable analyses to associate additional information with JavaScript objects and execution contexts. This system maintains parallel data structures that mirror the program's memory layout while storing analysis-specific metadata.

The shadow memory system supports:

- **Shadow Objects**: Metadata associated with JavaScript objects
- **Shadow Frames**: Execution context information for function calls
- **Source Location Mapping**: Mapping between runtime events and source code positions
- **Object Lifecycle Tracking**: Creation, modification, and access patterns

## Component Interaction Flow

The three core components work together in a coordinated fashion to enable dynamic analysis. The following diagram illustrates the complete flow from source code to analysis results:

```
"SMemory"
"Analysis Object"
"J$ Runtime"
"esnstrument.js"
"JavaScript Source"
"SMemory"
"Analysis Object"
"J$ Runtime"
"esnstrument.js"
"JavaScript Source"
Original JavaScript Code
Parse with acorn
Transform AST
Generate with esotope
Instrumented JavaScript
Execute instrumented code
invokeFunPre(iid, f, base, args)
Access shadow objects
Shadow metadata
Modified arguments/skip flag
Execute original operation
getField(iid, base, offset, val)
Update shadow state
Modified result
functionExit(iid, returnVal, exception)
Record execution metadata
Analysis results
```

**Sources:**[src/instrument/esnstrument.js280-350](https://github.com/Samsung/jalangi2/blob/28d2181c/src/instrument/esnstrument.js#L280-L350)[src/runtime/analysis.js204-226](https://github.com/Samsung/jalangi2/blob/28d2181c/src/runtime/analysis.js#L204-L226)[src/runtime/analysis.js315-339](https://github.com/Samsung/jalangi2/blob/28d2181c/src/runtime/analysis.js#L315-L339)

## Data Flow Architecture

The system processes data through multiple abstraction layers, each adding analysis capabilities while preserving program semantics:

```
Analysis Layer

Runtime Layer

Transformation Layer

Input Layer

Original
JavaScript

Source Maps

acorn Parser

AST Transformer

esotope Generator

Instrumented
JavaScript

J$ Sandbox

Execution Engine

Analysis Callbacks

Shadow Memory

Analysis Results
```

**Sources:**[src/instrument/esnstrument.js206-288](https://github.com/Samsung/jalangi2/blob/28d2181c/src/instrument/esnstrument.js#L206-L288)[src/runtime/analysis.js80-114](https://github.com/Samsung/jalangi2/blob/28d2181c/src/runtime/analysis.js#L80-L114)[src/runtime/analysis.js755-810](https://github.com/Samsung/jalangi2/blob/28d2181c/src/runtime/analysis.js#L755-L810)