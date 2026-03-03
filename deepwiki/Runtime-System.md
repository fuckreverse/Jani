# Runtime System
Relevant source files
- [src/js/runtime/analysis.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js)
- [tests/test47.js](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/test47.js)

The Runtime System provides the execution environment for instrumented JavaScript code in Jalangi2. It implements the J$ sandbox that receives and processes callback invocations from instrumented code, managing execution context, analysis integration, and runtime state.

For information about code instrumentation that generates these callbacks, see [Instrumentation Engine](/Samsung/jalangi2/2.1-instrumentation-engine). For details about shadow memory and object tracking, see [Shadow Memory System](/Samsung/jalangi2/2.3-shadow-memory-system).

## J$ Sandbox Environment

The runtime system centers around the global `J$` object which serves as the sandbox environment for instrumented code execution. The sandbox is initialized and populated with runtime callback functions that instrumented code will invoke during execution.

```
Control Flow

Runtime Callbacks

J$ Sandbox Object

J$

sandbox.analysis

sandbox.smemory

sandbox.Utils

sandbox.sid

sandbox.smap

sandbox.iids

J$.F (Function Call)

J$.M (Method Call)

J$.G (Property Read)

J$.P (Property Write)

J$.R (Variable Read)

J$.W (Variable Write)

J$.B (Binary Operation)

J$.U (Unary Operation)

J$.T (Literal)

J$.Fe (Function Enter)

J$.Fr (Function Return)

J$.Se (Script Enter)

J$.Sr (Script Return)

J$.C (Conditional)

J$.C1 (Switch Key)

J$.C2 (Case Label)

J$.Rt (Return Value)

J$.Th (Throw)

J$.Ex (Exception)
```

Sources: [src/js/runtime/analysis.js25-27](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L25-L27)[src/js/runtime/analysis.js775-810](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L775-L810)

## Runtime Callback Functions

The instrumented code invokes specific J$ callback functions for different JavaScript operations. These callbacks serve as interception points where analyses can observe and modify program behavior.
CallbackPurposeKey ParametersAnalysis Hooks`J$.F`Function call`iid`, `f`, `flags``invokeFunPre`, `invokeFun``J$.M`Method call`iid`, `base`, `offset`, `flags``invokeFunPre`, `invokeFun``J$.G`Property read`iid`, `base`, `offset`, `flags``getFieldPre`, `getField``J$.P`Property write`iid`, `base`, `offset`, `val`, `flags``putFieldPre`, `putField``J$.R`Variable read`iid`, `name`, `val`, `flags``read``J$.W`Variable write`iid`, `name`, `val`, `lhs`, `flags``write``J$.B`Binary operation`iid`, `op`, `left`, `right`, `flags``binaryPre`, `binary``J$.U`Unary operation`iid`, `op`, `left``unaryPre`, `unary``J$.T`Literal creation`iid`, `val`, `type`, `hasGetterSetter``literal`
Sources: [src/js/runtime/analysis.js229-244](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L229-L244)[src/js/runtime/analysis.js314-367](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L314-L367)[src/js/runtime/analysis.js372-401](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L372-L401)[src/js/runtime/analysis.js534-630](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L534-L630)[src/js/runtime/analysis.js634-679](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L634-L679)[src/js/runtime/analysis.js253-277](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L253-L277)

## Execution Context Management

The runtime system maintains execution context through function entry/exit tracking, script boundaries, and exception handling. This context is essential for analyses that need to understand the execution stack.

```

```

Sources: [src/js/runtime/analysis.js455-463](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L455-L463)[src/js/runtime/analysis.js466-490](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L466-L490)[src/js/runtime/analysis.js493-498](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L493-L498)[src/js/runtime/analysis.js502-518](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L502-L518)[src/js/runtime/analysis.js80-91](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L80-L91)[src/js/runtime/analysis.js42-48](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L42-L48)

## Analysis Integration Pattern

The runtime system follows a consistent pattern for integrating with analyses: pre-hooks for modification, execution of the actual operation, and post-hooks for observation.

```
Post-Hook Phase

Execution Phase

Pre-Hook Phase

skip=false

skip=true

Instrumented Code
Invokes J$ Callback

analysis.xxxPre()

Modify Parameters
(base, offset, args, etc.)

Skip Operation
(aret.skip)

Execute Operation
(property access, function call, etc.)

Generate Result

analysis.xxx()

Modify Result
(aret.result)

Return Final Result
Update lastComputedValue
```

Sources: [src/js/runtime/analysis.js320-327](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L320-L327)[src/js/runtime/analysis.js329-338](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L329-L338)[src/js/runtime/analysis.js347-355](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L347-L355)[src/js/runtime/analysis.js357-366](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L357-L366)

## Exception and Control Flow Handling

The runtime system carefully preserves JavaScript's exception handling and control flow semantics while allowing analyses to observe and modify behavior.

```

```

Sources: [src/js/runtime/analysis.js415-417](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L415-L417)[src/js/runtime/analysis.js420-428](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L420-L428)[src/js/runtime/analysis.js432-442](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L432-L442)[src/js/runtime/analysis.js448-452](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L448-L452)[src/js/runtime/analysis.js696-698](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L696-L698)[src/js/runtime/analysis.js702-719](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L702-L719)[src/js/runtime/analysis.js482-488](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L482-L488)

## Special Function Handling

The runtime system provides special handling for `eval` and `Function` constructor calls, ensuring proper instrumentation of dynamically generated code.

```
Function Constructor

Code Instrumentation

Dynamic Code Generation

eval() call

Function() call

Detect Special Functions
f === EVAL_ORG
f === Function

sandbox.instrumentEvalCode()
Instrument Dynamic Code

EVAL_ORG(instrumentedCode)
Execute with Original eval

Validate Parameters
f.apply(base, args)

Build Function Code
function(params) { body }

Instrument Function Code

EVAL_ORG(instrumentedCode)
Create Instrumented Function
```

Sources: [src/js/runtime/analysis.js166-168](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L166-L168)[src/js/runtime/analysis.js170-183](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L170-L183)[src/js/runtime/analysis.js189-192](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L189-L192)[src/js/runtime/analysis.js48](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L48-L48)[tests/test47.js3-10](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/test47.js#L3-L10)

## Instrumentation ID and Source Map Management

The runtime system maintains instrumentation identifiers (`iid`) and source map information (`sid`) to track code locations and enable precise analysis reporting.
VariablePurposeScope`iid`Instrumentation ID - unique identifier for each instrumented locationPer callback invocation`sid`Source ID - identifies the source file/script being executedGlobal, managed via stack`smap`Source map - maps source IDs to their corresponding `iids` arraysGlobal`sidStack`Stack of source IDs for nested script executionGlobal`sidCounter`Counter for generating unique source IDsGlobal
Sources: [src/js/runtime/analysis.js80-91](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L80-L91)[src/js/runtime/analysis.js82-87](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L82-L87)[src/js/runtime/analysis.js89-91](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L89-L91)[src/js/runtime/analysis.js50-51](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/runtime/analysis.js#L50-L51)