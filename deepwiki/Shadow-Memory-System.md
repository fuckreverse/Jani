# Shadow Memory System
Relevant source files
- [src/js/runtime/SMemory.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/SMemory.js)
- [src/js/plugins/scratch/SmemTest.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/plugins/scratch/SmemTest.js)
- [tests/finally.js](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/finally.js)
- [tests/unit/Smem1.js](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/unit/Smem1.js)
- [tests/unit/getter-frame.js](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/unit/getter-frame.js)

The Shadow Memory System provides a mechanism for associating metadata and unique identifiers with JavaScript objects, functions, and activation frames during dynamic analysis. This system enables analyses to track object lifecycles, store analysis-specific information, and maintain relationships between execution contexts without modifying the original program semantics.

For information about the broader runtime environment that hosts the shadow memory system, see [Runtime System](/Samsung/jalangi2/2.2-runtime-system). For details about developing analyses that use shadow memory, see [Analysis Development](/Samsung/jalangi2/4-analysis-development).

## Purpose and Core Concepts

The Shadow Memory System (`SMemory`) serves as a metadata layer that runs parallel to normal JavaScript execution. It maintains three primary abstractions:

### Shadow Objects

Each JavaScript object and function is associated with a unique shadow object that can store analysis metadata. Shadow objects are created transparently and accessed through the `SMemory` API without affecting program behavior.

### Shadow Frames

Each function activation frame (execution context) has an associated shadow frame that tracks variable ownership and scope relationships. Shadow frames maintain the activation frame hierarchy and enable variable resolution across nested scopes.

### Unique Identification

Every shadow object and frame receives a unique numeric identifier that serves as a logical address. These IDs enable analyses to create persistent references to objects and frames across the entire execution.

Sources: [src/js/runtime/SMemory.js2-28](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/SMemory.js#L2-L28)

## Architecture Overview

```
Analysis Interface

Shadow Memory Layer

JavaScript Execution

JavaScript Objects

JavaScript Functions

Activation Frames

Variables

SMemory Instance

Shadow Objects

Shadow Frames

Frame Stack

ID Generator

getShadowObject()

getShadowFrame()

getIDFromShadowObjectOrFrame()

getActualObjectOrFunctionFromShadowObjectOrFrame()
```

The shadow memory system operates by attaching special non-enumerable properties to JavaScript objects and maintaining a separate frame stack that mirrors the execution call stack.

Sources: [src/js/runtime/SMemory.js29-54](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/SMemory.js#L29-L54)

## Shadow Object Management

### Object Association Strategy

```
Shadow Object

Shadow Properties

Original Object

JavaScript Object

property1

property2

J$O (Shadow Object)

J$A (Actual Reference)

Shadow Object

Unique ID

Analysis Metadata
```

The system uses three special properties to implement the shadow object association:
PropertyPurposeContent`*J$O*`Shadow Object ReferencePoints to the actual shadow object`*J$A*`Actual Object ReferencePoints back to the original object`*J$F*`Frame ReferenceLinks functions to their defining scope
Sources: [src/js/runtime/SMemory.js32-35](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/SMemory.js#L32-L35)[src/js/runtime/SMemory.js205-228](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/SMemory.js#L205-L228)

### Property Access Resolution

The `getShadowObject` method handles both direct property access and prototype chain traversal:

```
getOwnerAndAccess Logic

Yes

No

Yes

No

Yes

No

getShadowObject(obj, prop, isGetField)

getOwnerAndAccess(obj, prop, isGetField)

owner !== undefined?

getShadowObjectOfObject(owner)

Return {owner: shadowObj, isProperty: boolean}

Return {owner: undefined, isProperty: true}

Traverse prototype chain

Check property descriptor

Has getter/setter?

Has own property?

Move to proto
```

Sources: [src/js/runtime/SMemory.js74-80](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/SMemory.js#L74-L80)[src/js/runtime/SMemory.js175-203](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/SMemory.js#L175-L203)

## Frame Stack Management

### Activation Frame Tracking

The shadow memory system maintains a parallel frame stack that mirrors JavaScript's execution context stack:

```
Frame Properties

Shadow Frame Stack

JavaScript Call Stack

Global Context

Script Context

Function A Context

Function B Context

Global Shadow Frame

Script Shadow Frame

Function A Shadow Frame

Function B Shadow Frame

J$F (Parent Frame)

J$A (Function Reference)

Variable Declarations
```

Frame management operations correspond to execution events:
OperationTriggerAction`functionEnter`Function callPush new frame, link to defining scope`functionReturn`Function returnPop current frame`scriptEnter`Script executionHandle global/module scopes`scriptReturn`Script completionRestore previous scope
Sources: [src/js/runtime/SMemory.js257-276](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/SMemory.js#L257-L276)[src/js/runtime/SMemory.js280-305](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/SMemory.js#L280-L305)

## Core API Methods

### Primary Interface Methods

The `SMemory` class exposes several key methods for analyses:

#### Object-Oriented Operations

```
// Get shadow object for property access
getShadowObject(obj, prop, isGetField)
 
// Get shadow object for any JavaScript object  
getShadowObjectOfObject(val)
 
// Extract unique ID from shadow object
getIDFromShadowObjectOrFrame(obj)
 
// Get original object from shadow object
getActualObjectOrFunctionFromShadowObjectOrFrame(obj)
```

#### Frame-Oriented Operations

```
// Get shadow frame containing named variable
getShadowFrame(name)
 
// Get frame containing named variable (internal)
getFrame(name)
```

Sources: [src/js/runtime/SMemory.js74-125](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/SMemory.js#L74-L125)[src/js/runtime/SMemory.js135-171](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/SMemory.js#L135-L171)

### Variable Resolution Algorithm

The `getFrame` method implements lexical scope resolution:

```
Yes

No

No

Yes

getFrame(name)

tmp = current frame

tmp.hasOwnProperty(name)?

Return tmp

tmp = tmp[J$F]

tmp === null?

Return frameStack[0] (global)
```

Sources: [src/js/runtime/SMemory.js135-145](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/SMemory.js#L135-L145)

## Integration with Analysis Framework

### Analysis Callback Integration

The shadow memory system integrates with the analysis framework through a built-in `MyAnalysis` class that responds to instrumentation callbacks:

```
SMemory Operations

Instrumentation Callbacks

literal()

declare()

functionEnter()

functionExit()

scriptEnter()

scriptExit()

defineFunction()

initialize()

functionEnter()

functionReturn()

scriptEnter()

scriptReturn()
```

Sources: [src/js/runtime/SMemory.js311-353](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/SMemory.js#L311-L353)

### Usage in Custom Analyses

Analyses access shadow memory through the `sandbox.smemory` interface. A typical pattern for property access tracking:

```
// In getFieldPre callback
var shadowObj = sandbox.smemory.getShadowObject(base, offset, true);
var ownerID = sandbox.smemory.getIDFromShadowObjectOrFrame(shadowObj.owner);
console.log("GET_FIELD " + ownerID + "." + offset);
```

For variable access tracking:

```
// In read/write callbacks  
var shadowFrame = sandbox.smemory.getShadowFrame(name);
var frameID = sandbox.smemory.getIDFromShadowObjectOrFrame(shadowFrame);
console.log("READ " + frameID + "." + name);
```

Sources: [src/js/plugins/scratch/SmemTest.js20-40](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/plugins/scratch/SmemTest.js#L20-L40)

## Implementation Details

### ID Generation Strategy

The system uses a simple incrementing counter for unique ID generation:

- Object IDs start at 1 and increment by 2
- Frame IDs start at 2 and increment by 2
- This ensures objects and frames have distinct ID ranges

### Special Environment Handling

The system provides special handling for Node.js `process.env`:

```
if (processEnv) {
    shadowEnv[SPECIAL_PROP_SOBJECT] = objectId;
    shadowEnv[SPECIAL_PROP_ACTUAL] = process.env;
    objectId += 2;
}
```

### Error Resilience

The shadow object creation process includes error handling for DOM objects and other restricted objects where property attachment may fail.

Sources: [src/js/runtime/SMemory.js36-53](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/SMemory.js#L36-L53)[src/js/runtime/SMemory.js218-226](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/SMemory.js#L218-L226)