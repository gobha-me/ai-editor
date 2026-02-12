/**
 * Tests for EventBus — on, off, emit, unsubscribe, error isolation.
 */
import { EventBus } from '../js/core.js';

const { T } = window;

T.suite('EventBus — on/emit');

let received = null;
const handler = (data) => { received = data; };
EventBus.on('test:basic', handler);
EventBus.emit('test:basic', { msg: 'hello' });
T.eq(received.msg, 'hello', 'emit delivers data to listener');

// Multiple listeners
let count = 0;
const h1 = () => count++;
const h2 = () => count++;
EventBus.on('test:multi', h1);
EventBus.on('test:multi', h2);
EventBus.emit('test:multi');
T.eq(count, 2, 'emit calls all registered listeners');

// Emit with no listeners is a no-op
EventBus.emit('test:noop', { data: 'ignored' });
T.assert(true, 'emit with no listeners does not throw');

T.suite('EventBus — off');

let offCount = 0;
const offHandler = () => offCount++;
EventBus.on('test:off', offHandler);
EventBus.emit('test:off');
T.eq(offCount, 1, 'Listener called before off');

EventBus.off('test:off', offHandler);
EventBus.emit('test:off');
T.eq(offCount, 1, 'Listener NOT called after off');

// off on non-existent event is a no-op
EventBus.off('test:nonexistent', () => {});
T.assert(true, 'off on non-existent event does not throw');

T.suite('EventBus — Return-Value Unsubscribe');

let unsubCount = 0;
const unsub = EventBus.on('test:unsub', () => unsubCount++);
EventBus.emit('test:unsub');
T.eq(unsubCount, 1, 'Listener called before unsubscribe');

unsub(); // Call the returned unsubscribe function
EventBus.emit('test:unsub');
T.eq(unsubCount, 1, 'Listener NOT called after return-value unsubscribe');

T.suite('EventBus — Error Isolation');

let isolatedCalled = false;
EventBus.on('test:error', () => { throw new Error('intentional test error'); });
EventBus.on('test:error', () => { isolatedCalled = true; });

// Suppress console.error for this test
const origError = console.error;
console.error = () => {};
EventBus.emit('test:error');
console.error = origError;

T.eq(isolatedCalled, true, 'Second listener still called after first throws');

T.suite('EventBus — Data Passing');

let passedData = null;
EventBus.on('test:data', (d) => { passedData = d; });

EventBus.emit('test:data', null);
T.eq(passedData, null, 'null data passed through');

EventBus.emit('test:data', 0);
T.eq(passedData, 0, 'falsy number data passed through');

EventBus.emit('test:data', '');
T.eq(passedData, '', 'empty string data passed through');

EventBus.emit('test:data', { nested: { arr: [1, 2] } });
T.eq(passedData.nested.arr[1], 2, 'complex nested data passed through');

// Cleanup: remove all test listeners
for (const event of Object.keys(EventBus._listeners)) {
    if (event.startsWith('test:')) {
        delete EventBus._listeners[event];
    }
}
