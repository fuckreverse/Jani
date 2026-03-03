# Configuration
Relevant source files
- [src/js/Config.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/Config.js)
- [tests/Esequence1.js](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/Esequence1.js)
- [tests/unit/throw-undefined.js](https://github.com/Samsung/jalangi2/blob/28d2181c/tests/unit/throw-undefined.js)

This document covers Jalangi2's configuration system, which controls instrumentation behavior, debugging options, and selective code transformation. The configuration system allows users to customize which JavaScript constructs get instrumented and how the analysis framework operates.

For information about the instrumentation engine that uses these configurations, see [Core Architecture](/Samsung/jalangi2/2-core-architecture). For details about command-line options and tool-specific settings, see [Command-Line Tools](/Samsung/jalangi2/3-command-line-tools).

## Configuration Structure

Jalangi2's configuration is centralized in the `Config` object, which is attached to the global `J$` sandbox. The configuration system provides both global settings and fine-grained control over which AST nodes get instrumented during code transformation.

```
J$ (Global Sandbox)

Config Object

Debug & Warning Flags

Buffer Configuration

Sampling Settings

Selective Instrumentation Functions

Config.DEBUG

Config.WARN

Config.SERIOUS_WARN

Config.MAX_BUF_SIZE

Config.LOG_ALL_READS_AND_BRANCHES

Config.ENABLE_SAMPLING

Config.INSTR_READ

Config.INSTR_WRITE

Config.INSTR_GETFIELD

Config.INSTR_PUTFIELD

Config.INSTR_BINARY

Config.INSTR_LITERAL

Config.INSTR_CONDITIONAL
```

*Configuration Object Structure and Main Categories*

Sources: [src/js/Config.js18-55](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/Config.js#L18-L55)

## Core Configuration Options

The configuration system provides several categories of settings that control Jalangi2's runtime behavior and instrumentation process.

### Debug and Logging Settings
SettingDefaultPurpose`Config.DEBUG``false`Enables debug output during instrumentation and runtime`Config.WARN``false`Controls warning message display`Config.SERIOUS_WARN``false`Controls display of serious warning messages`Config.LOG_ALL_READS_AND_BRANCHES``false`Enables comprehensive logging of memory accesses and control flow
### Buffer and Performance Settings
SettingDefaultPurpose`Config.MAX_BUF_SIZE``64000`Maximum buffer size for instrumentation data, set below 2^16 for overhead management`Config.ENABLE_SAMPLING``false`Controls whether sampling-based instrumentation is enabled
Sources: [src/js/Config.js29-42](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/Config.js#L29-L42)

## Selective Instrumentation System

The most powerful feature of Jalangi2's configuration is the selective instrumentation system, which allows fine-grained control over which JavaScript operations get instrumented. Each instrumentation function receives the operation name/type and the AST node, returning `true` to instrument or `false` to skip.

```
JavaScript AST Node

Instrumentation Decision

Config.INSTR_READ(name, ast)

Config.INSTR_WRITE(name, ast)

Config.INSTR_GETFIELD(offset, ast)

Config.INSTR_PUTFIELD(offset, ast)

Config.INSTR_BINARY(operator, ast)

Config.INSTR_UNARY(operator, ast)

Config.INSTR_LITERAL(literal, ast)

Config.INSTR_CONDITIONAL(type, ast)

return true → Instrument

return false → Skip

Instrumented JavaScript

Original JavaScript (unchanged)
```

*Selective Instrumentation Decision Flow*

### Available Instrumentation Controls
FunctionParametersPurpose`INSTR_INIT``(name, ast)`Controls initialization instrumentation`INSTR_READ``(name, ast)`Controls variable read instrumentation`INSTR_WRITE``(name, ast)`Controls variable write instrumentation`INSTR_GETFIELD``(offset, ast)`Controls property read instrumentation (offset null for computed properties)`INSTR_PUTFIELD``(offset, ast)`Controls property write instrumentation (offset null for computed properties)`INSTR_BINARY``(operator, ast)`Controls binary operation instrumentation`INSTR_PROPERTY_BINARY_ASSIGNMENT``(operator, offset, ast)`Controls compound property assignments like `a.x += e``INSTR_UNARY``(operator, ast)`Controls unary operation instrumentation`INSTR_LITERAL``(literal, ast)`Controls literal value instrumentation`INSTR_CONDITIONAL``(type, ast)`Controls conditional instrumentation (`&&`, ``INSTR_END_EXPRESSION``(ast)`Controls top-level expression markers
Sources: [src/js/Config.js39-54](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/Config.js#L39-L54)

## Configuration Integration with Instrumentation Pipeline

The configuration system integrates directly with the instrumentation engine to control code transformation behavior. When `esnstrument.js` processes JavaScript code, it consults the configuration functions for each AST node to determine whether to inject analysis callbacks.

```
Yes

No

true

false

esnstrument.js

Check Config Function

Config Function Defined?

Call Config.INSTR_* Function

Default: Instrument

Function Returns?

Inject J$ Callbacks

Skip AST Node

Process Next Node

Instrumented JavaScript Output
```

*Configuration Integration in Instrumentation Pipeline*

Sources: [src/js/Config.js39-41](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/Config.js#L39-L41)

## Customization Examples

To customize Jalangi2's instrumentation behavior, users can define configuration functions before running instrumentation. The configuration functions are checked during AST transformation to make selective instrumentation decisions.

### Example: Instrumenting Only Function Calls

```
// Configure to instrument only function calls, skip all other operations
Config.INSTR_READ = function(name, ast) { return false; };
Config.INSTR_WRITE = function(name, ast) { return false; };
Config.INSTR_GETFIELD = function(offset, ast) { return false; };
Config.INSTR_PUTFIELD = function(offset, ast) { return false; };
// Function call instrumentation enabled by default (no INSTR_CALL function defined)
```

### Example: Selective Property Access Instrumentation

```
// Instrument only computed property access, skip dot notation
Config.INSTR_GETFIELD = function(offset, ast) { 
    return offset === null; // null offset indicates computed property like obj[key]
};
Config.INSTR_PUTFIELD = function(offset, ast) { 
    return offset === null; // null offset indicates computed property like obj[key] = value
};
```

### Example: Conditional Instrumentation Based on AST Properties

```
// Instrument only binary operations in specific locations
Config.INSTR_BINARY = function(operator, ast) {
    // Only instrument arithmetic operators, skip logical operators
    return ['+', '-', '*', '/', '%'].indexOf(operator) !== -1;
};
```

Sources: [src/js/Config.js43-52](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/Config.js#L43-L52)

## Configuration Loading and Initialization

The configuration system initializes as part of the global `J$` sandbox setup. The configuration object is created only once and shared across all instrumentation and analysis operations within a Jalangi2 session.

```
No

Yes

J$ Defined?

Create J$ Object

Use Existing J$

Config Defined?

Create Config Object

Reuse Existing Config

Set Default Values

Configuration Ready

Available to esnstrument.js

Available to analysis.js

Available to User Code
```

*Configuration Initialization Process*

The configuration system includes a safety check to prevent multiple initialization and ensures the `JALANGI DO NOT INSTRUMENT` comment prevents the configuration code itself from being instrumented.

Sources: [src/js/Config.js16-27](https://github.com/Samsung/jalangi2/blob/28d2181c/src/js/Config.js#L16-L27)