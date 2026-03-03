# Results and UI
Relevant source files
- [src/frame.html](https://github.com/Samsung/jalangi2/blob/28d2181c/src/frame.html)
- [src/mid.html](https://github.com/Samsung/jalangi2/blob/28d2181c/src/mid.html)
- [src/pre.html](https://github.com/Samsung/jalangi2/blob/28d2181c/src/pre.html)

The Results and UI system provides a browser-based interface for displaying dynamic analysis results when analyzing web applications. This system creates an overlay interface that appears on instrumented web pages, allowing users to view analysis results without leaving the browser context.

This document covers the browser-based UI components for result display. For information about analysis development and callback implementation, see [Analysis Development](/Samsung/jalangi2/4-analysis-development). For web integration and proxy setup, see [Web Integration](/Samsung/jalangi2/6-web-integration).

## Architecture Overview

The Results and UI system consists of two main HTML components that work together to provide an integrated analysis results display:

```
Jalangi2 Runtime

External Libraries

UI Components

Web Page Context

Instrumented Web Page

jalangi_results_show_button

jalangi_results_frame

pre.html

frame.html

jQuery

DataTables

CodeMirror

J$ Runtime

J$.smap (Source Maps)

J$.endExecution
```

**Sources**: [src/pre.html1-53](https://github.com/Samsung/jalangi2/blob/28d2181c/src/pre.html#L1-L53)[src/frame.html1-100](https://github.com/Samsung/jalangi2/blob/28d2181c/src/frame.html#L1-L100)

## UI Components

### Overlay Button System

The main entry point for the results UI is a floating button that appears on instrumented web pages:

```
Event Handlers

Button Properties

pre.html Components

jalangi_results_show_button

Jalangi

jalangi_results_frame

J$.Results

position: absolute, top: 0%, left: 0%

width: 50px, height: 20px

z-index: 10003

opacity: 0.8

onclick: J$.Results.showHideResults()

showHideResults function

J$.Results.execute()
```

The button is styled with CSS properties that ensure it remains visible and accessible:

- Positioned absolutely at the top-left corner
- Semi-transparent background with high z-index
- Light blue styling for visibility

**Sources**: [src/pre.html2-19](https://github.com/Samsung/jalangi2/blob/28d2181c/src/pre.html#L2-L19)[src/pre.html39-47](https://github.com/Samsung/jalangi2/blob/28d2181c/src/pre.html#L39-L47)

### Results Frame Structure

The results are displayed in a full-screen iframe that contains the actual analysis interface:
ComponentPurposeStyling`jalangi_results_frame`Container iframe`position: fixed, width: 100%, height: 100%``jalangi_results_window`Results display area`width: 50%, float: left, overflow: scroll``code` textareaCode display`width: 48%, float: right`Close buttonUI control`float: right, vertical-align: top`
**Sources**: [src/pre.html21-23](https://github.com/Samsung/jalangi2/blob/28d2181c/src/pre.html#L21-L23)[src/frame.html47-56](https://github.com/Samsung/jalangi2/blob/28d2181c/src/frame.html#L47-L56)

## Code Display System

The code display system uses CodeMirror to provide syntax-highlighted JavaScript code viewing with location highlighting:

```
Location Highlighting

Source Map Integration

CodeMirror Integration

code textarea

CodeMirror.fromTextArea()

mode: 'javascript'

lineNumbers: true

readOnly: true

iidToDisplayCodeLocation(gid)

parent.J$.smap

sid:iid parsing

ret.code

editor.markText()

className: 'styled-background'

editor.setCursor()

editor.scrollIntoView()
```

The `iidToDisplayCodeLocation` function processes global identifiers in the format `"sid:iid"` to highlight specific code locations:

- Parses the source ID (`sid`) and instruction ID (`iid`)
- Retrieves source code from `J$.smap[sid].code`
- Highlights the relevant code section using `markText` with background styling
- Automatically scrolls the editor to show the highlighted location

**Sources**: [src/frame.html58-96](https://github.com/Samsung/jalangi2/blob/28d2181c/src/frame.html#L58-L96)

## Library Dependencies

The UI system integrates several external libraries for enhanced functionality:

```
Styling Features

JavaScript Dependencies

CSS Dependencies

jquery.dataTables.min.css

codemirror.css

Custom Styles

jquery.min.js

jquery.dataTables.min.js

codemirror.js

javascript.js

styled-background class

CodeMirror border styling

DataTables styling
```

All dependencies are embedded using the `fileExpand` function, which inlines the library content into the HTML:

- **jQuery**: Provides DOM manipulation and AJAX functionality
- **DataTables**: Enables tabular data presentation with sorting and filtering
- **CodeMirror**: Provides syntax-highlighted code editing/viewing

**Sources**: [src/frame.html3-44](https://github.com/Samsung/jalangi2/blob/28d2181c/src/frame.html#L3-L44)

## Integration with Analysis Framework

The Results UI integrates with the Jalangi2 analysis framework through several key interfaces:

```
Analysis Integration

UI Functions

J$ Runtime Interface

J$ Global Object

J$.Results

J$.smap

J$.endExecution

J$.Results.log(str)

J$.Results.execute(f)

J$.Results.showHideResults()

Analysis Callbacks

Analysis Results

Source Map Data

Code Location Display
```

### Key Integration Points
FunctionPurposeUsage`J$.Results.log(str)`Append text to results displayCalled by analyses to display messages`J$.Results.execute(f)`Execute function with UI contextProvides access to jQuery, editor, and results div`J$.Results.showHideResults()`Toggle results displayTriggered by button click`J$.endExecution()`Signal analysis completionCalled when results panel is opened
The UI system provides a bridge between analysis results and user presentation, allowing analyses to display their findings in a structured, interactive format within the browser context.

**Sources**: [src/pre.html26-48](https://github.com/Samsung/jalangi2/blob/28d2181c/src/pre.html#L26-L48)[src/frame.html67-73](https://github.com/Samsung/jalangi2/blob/28d2181c/src/frame.html#L67-L73)