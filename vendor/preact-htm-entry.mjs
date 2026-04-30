// ============================================
// Preact + htm Vendor Bundle Entry Point
// ============================================
// Built by esbuild during Docker image creation, alongside
// codemirror-bundle.js. Produces a single ESM file with Preact's
// public surface plus htm's preact-bound `html` template tag.
//
// Loaded by js/util/preact-mount.js with a CDN fallback for dev mode.
// First consumer: 1.3.0 Memory tab (Decision §9 — Preact + htm allowed
// for new state-heavy surfaces from 1.3.0 onward).
// ============================================

// Core
export { h, render, hydrate, Fragment, cloneElement, createContext, createRef, Component } from 'preact';

// Hooks (component authors will reach for at least useState / useEffect / useRef)
export { useState, useReducer, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useContext, useId } from 'preact/hooks';

// htm bound to Preact's h — gives the `html\`...\`` template tag without JSX/build
export { html } from 'htm/preact';
