# Web Integration
Relevant source files
- [README.md](https://github.com/Samsung/jalangi2/blob/28d2181c/README.md)
- [scripts/mitmproxywrapper.py](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/mitmproxywrapper.py)
- [scripts/proxy.py](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/proxy.py)
- [src/plugins/pldi16/TraceAll.js](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/pldi16/TraceAll.js)

This document explains Jalangi2's proxy-based instrumentation system for analyzing JavaScript code running in web browsers. This approach enables dynamic analysis of web applications by intercepting and instrumenting JavaScript files as they are served over HTTP/HTTPS connections.

For information about command-line analysis tools, see [Command-Line Tools](/Samsung/jalangi2/3-command-line-tools). For details about the core instrumentation engine, see [Instrumentation Engine](/Samsung/jalangi2/2.1-instrumentation-engine).

## Overview

Web integration in Jalangi2 uses a man-in-the-middle proxy approach to instrument JavaScript code on-the-fly as web pages are loaded in browsers. This eliminates the need to pre-instrument web application files and enables analysis of third-party JavaScript libraries and dynamically loaded code.

### Proxy-Based Architecture

```
Web Server

Jalangi2 System

Proxy Infrastructure

Browser Environment

Web Browser

Web Application

mitmproxy
HTTP/HTTPS Interception

proxy.py
Jalangi Integration Script

mitmproxywrapper.py
macOS Proxy Management

esnstrument.js
Code Transformation

./cache/
Instrumented File Storage

Analysis Modules

Web Server

JavaScript Files
```

Sources: [scripts/proxy.py1-126](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/proxy.py#L1-L126)[scripts/mitmproxywrapper.py1-150](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/mitmproxywrapper.py#L1-L150)[README.md104-141](https://github.com/Samsung/jalangi2/blob/28d2181c/README.md#L104-L141)

## Core Components

### proxy.py Script

The `proxy.py` script serves as the bridge between mitmproxy and Jalangi2's instrumentation engine. It processes HTTP responses containing JavaScript content and applies instrumentation before serving them to the browser.

#### Key Functions
FunctionPurposeLocation`processFile()`Instruments JavaScript/HTML content[scripts/proxy.py56-81](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/proxy.py#L56-L81)`response()`Main mitmproxy response handler[scripts/proxy.py85-126](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/proxy.py#L85-L126)
#### Content Processing Flow

```
Content Type Processing

Ignored

noInstr=true

Cache Hit

Cache Miss

HTTP Response Received

Check --ignore URLs

Check noInstr Parameter

Decode Response Content

Check Content-Type Header

Process JavaScript
content-type: javascript

Process HTML
content-type: html

Process MVC
content-type: mvc

Generate MD5 Hash

Check Cache

Call esnstrument.js

Store in Cache

Return Instrumented Content
```

Sources: [scripts/proxy.py56-126](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/proxy.py#L56-L126)

### Cache System

The proxy implements a hierarchical caching system to avoid re-instrumenting identical JavaScript files:

- **Cache Structure**: `cache/{hostname}/{md5_hash}/{filename}_jalangi_.{ext}`
- **Cache Control**: `--cache` (default) or `--no-cache` flags
- **Hash-based**: Uses MD5 hashing of file content for cache keys

Cache directory example:

```
cache/
├── example.com/
│   ├── a1b2c3d4e5f6.../
│   │   ├── script.js
│   │   └── script_jalangi_.js
│   └── f6e5d4c3b2a1.../
│       ├── app.js
│       └── app_jalangi_.js

```

Sources: [scripts/proxy.py61-64](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/proxy.py#L61-L64)[scripts/proxy.py36-41](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/proxy.py#L36-L41)

### mitmproxywrapper.py (macOS)

Provides automatic proxy configuration management for macOS systems:

#### Core Functionality
MethodPurpose`toggle_proxy()`Enable/disable system proxy settings`enable_proxy_for_service()`Configure proxy for network service`wrap_mitmproxy()`Launch mitmproxy with proxy management
```
External Tools

mitmproxywrapper.py

macOS System

Network Services
(Wi-Fi, Ethernet)

System Proxy Settings

toggle_proxy()

enable_proxy_for_service()

disable_proxy_for_service()

wrap_mitmproxy()

networksetup command

scutil command

mitmdump process
```

Sources: [scripts/mitmproxywrapper.py64-71](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/mitmproxywrapper.py#L64-L71)[scripts/mitmproxywrapper.py32-40](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/mitmproxywrapper.py#L32-L40)[scripts/mitmproxywrapper.py87-92](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/mitmproxywrapper.py#L87-L92)

## Setup and Configuration

### Prerequisites

1. **mitmproxy Installation**: Version 7.0.0 tested and recommended
2. **Python Environment**: Python 3.x required
3. **SSL Certificates**: For HTTPS instrumentation

### Installation Commands

```
# Linux
sudo pip install mitmproxy==7.0.0
 
# macOS with Homebrew
brew install python
pip install -U pip
pip install mitmproxy==7.0.0
```

Sources: [README.md107-119](https://github.com/Samsung/jalangi2/blob/28d2181c/README.md#L107-L119)

### Basic Usage

#### Manual Proxy Setup

```
mitmdump --quiet --anticache -s "scripts/proxy.py --inlineIID --inlineSource --analysis src/plugins/ChainedAnalyses.js --analysis src/runtime/analysisCallbackTemplate.js"
```

Browser proxy configuration: `127.0.0.1:8080`

#### macOS Automatic Setup

```
./scripts/mitmproxywrapper.py --toggle --auto-disable --quiet --anticache -s "scripts/proxy.py --inlineIID --inlineSource --analysis src/plugins/ChainedAnalyses.js --analysis src/runtime/analysisCallbackTemplate.js"
```

Sources: [README.md128-138](https://github.com/Samsung/jalangi2/blob/28d2181c/README.md#L128-L138)

### Command-Line Options
OptionPurposeExample`--no-cache`Disable instrumentation caching`--no-cache``--cache`Enable caching (default)`--cache``--ignore`Skip instrumentation for URLs`--ignore http://cdn.com/jalangi``--inlineIID`Inline instruction IDs`--inlineIID``--inlineSource`Inline source mapping`--inlineSource``--analysis`Specify analysis modules`--analysis path/to/analysis.js`
Sources: [scripts/proxy.py36-49](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/proxy.py#L36-L49)[scripts/proxy.py83](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/proxy.py#L83-L83)

## Browser Integration

### Content Security Policy

The proxy automatically removes Content Security Policy headers that might prevent instrumented code from executing:

```
// Disable CSP to allow instrumented code execution
if (csp_key) {
    flow.response.headers.pop(csp_key, None)
}
```

Sources: [scripts/proxy.py118-120](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/proxy.py#L118-L120)

### URL Filtering

The system supports selective instrumentation through URL filtering:

- **Ignore patterns**: Skip instrumentation for specific domains
- **noInstr parameter**: Per-request instrumentation control via `?noInstr=true`

Sources: [scripts/proxy.py87-96](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/proxy.py#L87-L96)

### Browser-Specific Analysis Features

Analyses can detect browser environments and provide enhanced functionality:

```
if (sandbox.Constants.isBrowser) {
    sandbox.Results = {};
}
```

Results can be displayed in browser console or logged to analysis results system.

Sources: [src/plugins/pldi16/TraceAll.js29-31](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/pldi16/TraceAll.js#L29-L31)[src/plugins/pldi16/TraceAll.js67-71](https://github.com/Samsung/jalangi2/blob/28d2181c/src/plugins/pldi16/TraceAll.js#L67-L71)

## Environment Integration

### Environment Variables

The proxy script sets environment variables for the instrumentation process:

- `JALANGI_URL`: Original URL of the instrumented file

Sources: [scripts/proxy.py69-70](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/proxy.py#L69-L70)

### File Path Resolution

The system maps relative paths to absolute paths for analysis files and handles both file and directory references.

Sources: [scripts/proxy.py50-54](https://github.com/Samsung/jalangi2/blob/28d2181c/scripts/proxy.py#L50-L54)