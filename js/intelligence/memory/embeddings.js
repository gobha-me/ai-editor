// @ts-check
/**
 * Memory ↔ embeddings glue. The single owner of the canonicalization
 * format that converts a `MemoryRecord` into the string fed to the
 * embedding provider.
 *
 * Why one file owns this: PR #4's `memory_remember` LLM tool, PR #3's
 * `.aieditor/memory/*.md` reconciler, and any later self-healing path
 * all need to embed records. If they each compute the embed-input
 * differently, semantic search across them returns inconsistent results.
 * Centralizing here makes the format one decision, not three.
 *
 * The format itself is intentionally simple: `"${key}: ${value}"` with
 * the value JSON-stringified when not already a string. No prompt
 * engineering, no metadata injection — the embedder sees the same shape
 * a human reading the record would see.
 *
 * @module intelligence/memory/embeddings
 */

/**
 * Build the canonical text input for embedding a memory record.
 * Idempotent and pure — no I/O.
 *
 * @param {{ key: string, value: string|Object|null }} rec
 * @returns {string}
 */
export function canonicalEmbedText(rec) {
    if (!rec || typeof rec.key !== 'string') {
        throw new Error('canonicalEmbedText: record must have a string `key`');
    }
    const valueText = rec.value === null || rec.value === undefined
        ? ''
        : typeof rec.value === 'string'
            ? rec.value
            : safeStringify(rec.value);
    return `${rec.key}: ${valueText}`;
}

function safeStringify(v) {
    try {
        return JSON.stringify(v);
    } catch {
        // Circular or non-serializable — fall back to keys for embedding purposes.
        if (v && typeof v === 'object') return `[object ${Object.keys(v).join(',')}]`;
        return String(v);
    }
}

/**
 * Convenience: embed a record via the provided client. Caller owns the
 * client (typically `EmbeddingsClient` from `js/embeddings-client.js`)
 * so this glue stays decoupled from settings, init, and provider state.
 *
 * Returns the embedder's output unchanged (`number[] | null` per
 * `EmbeddingsClient.embed`'s contract). `null` is a valid result —
 * `MemoryRecord.embedding` is nullable and `searchSemantic` filters
 * null-embedding records from results.
 *
 * @param {{ embed: (text: string) => Promise<number[]|null> }} client
 * @param {{ key: string, value: string|Object|null }} rec
 * @returns {Promise<number[]|null>}
 */
export async function embedRecord(client, rec) {
    if (!client || typeof client.embed !== 'function') {
        throw new Error('embedRecord: client must implement async embed(text)');
    }
    const text = canonicalEmbedText(rec);
    return client.embed(text);
}
