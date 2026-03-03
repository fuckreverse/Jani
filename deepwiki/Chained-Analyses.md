# Chained Analyses
Relevant source files
- [src/js/plugins/ChainedAnalyses.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/plugins/ChainedAnalyses.js)
- [src/js/plugins/ChainedAnalysesNoCheck.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/plugins/ChainedAnalysesNoCheck.js)

The Chained Analyses system enables combining multiple dynamic analyses to run simultaneously on the same instrumented JavaScript code. This system provides a transparent mechanism for composing analyses, where each analysis callback is executed in sequence when the corresponding runtime event occurs.

For information about implementing individual analyses, see [Analysis Template](/Samsung/jalangi2/4.1-analysis-template). For the programmatic API to configure analyses, see [Programmatic API](/Samsung/jalangi2/4.3-programmatic-api).

## System Overview

The Chained Analyses system acts as a multiplexer for analysis callbacks, allowing multiple `MyAnalysis` instances to be registered and executed together. When the instrumented code triggers a callback (such as `invokeFun` or `getField`), the system automatically invokes the corresponding method in each registered analysis.

The system supports two variants:

- `ChainedAnalyses` - includes exception handling and error reporting
- `ChainedAnalysesNoCheck` - optimized version without exception handling for performance

**Chained Analysis Architecture**

```
Callback Methods

Individual Analyses

Chained Analysis System

Runtime System

J$ Runtime

Runtime Callbacks

ChainedAnalyses

addAnalysis()

Chained Callbacks

Analysis 1

Analysis 2

Analysis N

invokeFun()

getField()

putField()

...other callbacks
```

Sources: [src/js/plugins/ChainedAnalyses.js21-103](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/plugins/ChainedAnalyses.js#L21-L103)[src/js/plugins/ChainedAnalysesNoCheck.js21-89](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/plugins/ChainedAnalysesNoCheck.js#L21-L89)

## Core Components

The `ChainedAnalyses` class manages the registration and execution of multiple analyses through several key components:
ComponentPurposeImplementation`funList`Defines all supported callback namesStatic array of callback method names`addAnalysis()`Registers a new analysis instanceDynamically chains callback methods`globals`Shared state between analysesObject accessible by all registered analysesException handlingManages analysis errorsTry-catch wrapper with process termination
### Supported Callback Methods

The system supports the complete set of Jalangi2 analysis callbacks:

```
Expressions

literal

binaryPre

binary

unaryPre

unary

conditional

Function Calls

invokeFunPre

invokeFun

_return

_throw

Memory Operations

read

write

getFieldPre

getField

putFieldPre

putField

Execution Flow

scriptEnter

functionEnter

functionExit

scriptExit

endExecution
```

Sources: [src/js/plugins/ChainedAnalyses.js34-43](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/plugins/ChainedAnalyses.js#L34-L43)[src/js/plugins/ChainedAnalysesNoCheck.js24-33](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/plugins/ChainedAnalysesNoCheck.js#L24-L33)

## Analysis Registration Process

When an analysis is registered via `addAnalysis()`, the system performs dynamic callback chaining:

**Registration Flow**

```
No

Yes

No

Yes

addAnalysis(analysis)

Iterate through funList

Check if analysis[callback] exists

Next callback

Does chained callback exist?

Create chained function

Append to existing chain

Setup afs[] and afThis[] arrays

Add callback to chain

function() { try { ... } catch(e) { ... } }

Set afs=[], afThis=[], afName properties
```

The registration process involves:

1. **Iteration**: Loop through all callback names in `funList`
2. **Detection**: Check if the analysis implements each callback
3. **Chain Creation**: Create a chained function if none exists for that callback
4. **Function Storage**: Store the analysis function and context in arrays
5. **Dynamic Execution**: Execute all registered functions when callback is invoked

Sources: [src/js/plugins/ChainedAnalyses.js47-81](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/plugins/ChainedAnalyses.js#L47-L81)[src/js/plugins/ChainedAnalysesNoCheck.js37-67](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/plugins/ChainedAnalysesNoCheck.js#L37-L67)

## Callback Execution Flow

When a runtime callback is triggered, the chained function executes all registered analysis callbacks sequentially:

**Execution Mechanism**

```
"Analysis N"
"Analysis 2"
"Analysis 1"
"Chained Function"
"J$ Runtime"
"Analysis N"
"Analysis 2"
"Analysis 1"
"Chained Function"
"J$ Runtime"
callback(args...)
Copy arguments to args[]
analysis1.callback.apply(analysis1, args)
return value
analysis2.callback.apply(analysis2, args)
return value
analysisN.callback.apply(analysisN, args)
return value
final return value
```

The execution process:

1. **Argument Preparation**: Copy all arguments to a local array
2. **Sequential Execution**: Call each registered analysis function in order
3. **Return Value**: Return the result from the last analysis (if any)
4. **Exception Handling**: Catch and report any analysis errors

Sources: [src/js/plugins/ChainedAnalyses.js55-71](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/plugins/ChainedAnalyses.js#L55-L71)[src/js/plugins/ChainedAnalysesNoCheck.js45-57](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/plugins/ChainedAnalysesNoCheck.js#L45-L57)

## System Variants

### ChainedAnalyses (Standard)

The standard implementation includes comprehensive error handling:

- **Exception Handling**: Try-catch blocks around analysis execution
- **Error Reporting**: Console logging with stack traces
- **Process Termination**: Exits process on analysis errors
- **Browser Integration**: Keyboard shortcut (Alt-Shift-T) for ending execution

### ChainedAnalysesNoCheck (Optimized)

The optimized variant removes error handling for better performance:

- **No Exception Handling**: Direct function calls without try-catch
- **Faster Execution**: Reduced overhead for production use
- **Same Interface**: Identical API but without error recovery

FeatureChainedAnalysesChainedAnalysesNoCheckException Handling✓✗Error Reporting✓✗PerformanceStandardOptimizedBrowser Integration✓✓
Sources: [src/js/plugins/ChainedAnalyses.js56-70](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/plugins/ChainedAnalyses.js#L56-L70)[src/js/plugins/ChainedAnalysesNoCheck.js46-56](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/plugins/ChainedAnalysesNoCheck.js#L46-L56)

## Integration with J$ Sandbox

The Chained Analyses system integrates with the J$ sandbox through property descriptors:

**Sandbox Integration**

```
ChainedAnalyses Instance

Property Descriptor

J$ Sandbox

J$ Sandbox Object

analysis property

get: function()

set: function(a)

thisAnalysis

addAnalysis()
```

The integration works through:

1. **Property Definition**: `Object.defineProperty()` creates `sandbox.analysis`
2. **Getter**: Returns the current `ChainedAnalyses` instance
3. **Setter**: Automatically calls `addAnalysis()` when assigned
4. **Transparent Usage**: Analyses can be added via simple assignment

This allows natural syntax like:

```
sandbox.analysis = new MyAnalysis();
```

Sources: [src/js/plugins/ChainedAnalyses.js84-92](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/plugins/ChainedAnalyses.js#L84-L92)[src/js/plugins/ChainedAnalysesNoCheck.js70-78](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/plugins/ChainedAnalysesNoCheck.js#L70-L78)

## Browser Features

Both variants include browser-specific functionality:

- **Keyboard Shortcut**: Alt-Shift-T triggers `endExecution()`
- **Event Listener**: Registered on window for keydown events
- **Manual Termination**: Allows users to stop analysis interactively

This feature enables interactive control of analysis execution in web applications.

Sources: [src/js/plugins/ChainedAnalyses.js94-101](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/plugins/ChainedAnalyses.js#L94-L101)[src/js/plugins/ChainedAnalysesNoCheck.js80-87](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/plugins/ChainedAnalysesNoCheck.js#L80-L87)