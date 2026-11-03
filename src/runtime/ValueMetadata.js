// JALANGI DO NOT INSTRUMENT
/** Metadata belongs to the observer, never to the observed object's properties. */
import { $wmGet, $wmSet, $wmHas } from './NativeProxy.js';

const names = new WeakMap();
const identities = new WeakMap();
const getDescriptor = Object.getOwnPropertyDescriptor;
let nextIdentity = 1;

/** Only call for functions created by a literal/declaration in instrumented code. */
export function registerLiteralFunction(fn) {
    const descriptor = getDescriptor(fn, 'name');
    $wmSet(names, fn, typeof descriptor?.value === 'string' ? descriptor.value : '');
}

/** A property label is a safe fallback; never inspect an arbitrary callback. */
export function registerPropertyFunction(fn, key) {
    if (!$wmHas(names, fn)) $wmSet(names, fn, typeof key === 'string' ? key : '');
}

/** Safe even for revoked proxies: no property access or reflection on the value. */
export function functionName(fn) {
    return typeof fn === 'function' ? $wmGet(names, fn) ?? '' : '';
}

export function referenceLabel(value) {
    let id = $wmGet(identities, value);
    if (id === undefined) {
        id = nextIdentity++;
        $wmSet(identities, value, id);
    }
    return `[${typeof value === 'function' ? 'Function' : 'Object'} #${id}]`;
}
