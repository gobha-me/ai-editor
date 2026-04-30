// @ts-check
/**
 * Memory record validators — pure functions over the typedefs in
 * `contracts.js`. Returns `{ ok: true }` or `{ ok: false, errors: string[] }`
 * so the store layer decides whether to throw or surface the failure.
 *
 * `assertValid()` is the throwing wrapper used inside `store.create/update`.
 *
 * @module intelligence/memory/validation
 */

import {
    MEMORY_SCOPES,
    MEMORY_CATEGORIES,
    MEMORY_SOURCES,
    MEMORY_LIMITS,
} from './contracts.js';

/**
 * @typedef {{ ok: true }} ValidOk
 * @typedef {{ ok: false, errors: string[] }} ValidFail
 * @typedef {ValidOk | ValidFail} ValidResult
 */

/** @returns {ValidResult} */
export function validateScope(scope) {
    if (typeof scope !== 'string' || !MEMORY_SCOPES.includes(scope)) {
        return { ok: false, errors: [`scope must be one of ${MEMORY_SCOPES.join('|')}; got ${JSON.stringify(scope)}`] };
    }
    return { ok: true };
}

/** @returns {ValidResult} */
export function validateCategory(category) {
    if (typeof category !== 'string' || !MEMORY_CATEGORIES.includes(category)) {
        return { ok: false, errors: [`category must be one of ${MEMORY_CATEGORIES.join('|')}; got ${JSON.stringify(category)}`] };
    }
    return { ok: true };
}

/** @returns {ValidResult} */
export function validateSource(source) {
    if (typeof source !== 'string' || !MEMORY_SOURCES.includes(source)) {
        return { ok: false, errors: [`source must be one of ${MEMORY_SOURCES.join('|')}; got ${JSON.stringify(source)}`] };
    }
    return { ok: true };
}

/**
 * Key validation operates on the *canonical* form. Use
 * `canonicalizeKey()` first if untrusted input is involved.
 *
 * @returns {ValidResult}
 */
export function validateKey(key) {
    if (typeof key !== 'string') {
        return { ok: false, errors: [`key must be a string; got ${typeof key}`] };
    }
    if (key.length === 0) {
        return { ok: false, errors: ['key must not be empty'] };
    }
    if (key.length > MEMORY_LIMITS.KEY_MAX_LENGTH) {
        return { ok: false, errors: [`key must be ≤${MEMORY_LIMITS.KEY_MAX_LENGTH} chars; got ${key.length}`] };
    }
    if (key !== canonicalizeKey(key)) {
        return { ok: false, errors: [`key must be canonical (lowercase, trimmed); use canonicalizeKey() before validation`] };
    }
    return { ok: true };
}

/**
 * Canonicalize a key for storage and lookup. Idempotent: lowercase + trim.
 * Keys are case-insensitive within a scope per `DESIGN-memory.md` §"Data
 * Model" intent — enforced here, not in IDB indexes.
 *
 * @param {string} key
 * @returns {string}
 */
export function canonicalizeKey(key) {
    if (typeof key !== 'string') return '';
    return key.toLowerCase().trim();
}

/**
 * Full record validation. Checks required fields, types, enum
 * memberships, and a handful of cross-field invariants.
 *
 * Cross-field invariants enforced:
 *   - `id` is non-empty string.
 *   - `superseded_by !== id` (a record cannot supersede itself).
 *   - `created_at <= updated_at`.
 *   - `embedding`, when non-null, is a `number[]` of finite numbers.
 *   - `expires_at`, when non-null, is a finite epoch ms.
 *   - `actor.length <= ACTOR_MAX_LENGTH`.
 *
 * @param {*} rec
 * @returns {ValidResult}
 */
export function validateRecord(rec) {
    const errors = [];

    if (rec === null || typeof rec !== 'object') {
        return { ok: false, errors: [`record must be an object; got ${typeof rec}`] };
    }

    // Required string fields.
    if (typeof rec.id !== 'string' || rec.id.length === 0) {
        errors.push('id must be a non-empty string');
    }
    if (typeof rec.owner_id_or_workspace_id !== 'string' || rec.owner_id_or_workspace_id.length === 0) {
        errors.push('owner_id_or_workspace_id must be a non-empty string');
    }
    if (typeof rec.embedding_model_id !== 'string') {
        errors.push('embedding_model_id must be a string (use "" if no embedder configured)');
    }
    if (typeof rec.created_by !== 'string') {
        errors.push('created_by must be a string');
    }
    if (typeof rec.actor !== 'string') {
        errors.push('actor must be a string');
    } else if (rec.actor.length > MEMORY_LIMITS.ACTOR_MAX_LENGTH) {
        errors.push(`actor must be ≤${MEMORY_LIMITS.ACTOR_MAX_LENGTH} chars; got ${rec.actor.length}`);
    }

    // value: any JSON-serializable type. We don't deep-check (cheap pass);
    // structured-clone failure surfaces at IDB write time.
    if (rec.value === undefined) {
        errors.push('value must not be undefined (use null for absent values)');
    }

    // Enum fields.
    const scopeRes = validateScope(rec.scope);
    if (!scopeRes.ok) errors.push(...scopeRes.errors);
    const categoryRes = validateCategory(rec.category);
    if (!categoryRes.ok) errors.push(...categoryRes.errors);
    const sourceRes = validateSource(rec.source);
    if (!sourceRes.ok) errors.push(...sourceRes.errors);

    // Key — must already be canonical when stored.
    const keyRes = validateKey(rec.key);
    if (!keyRes.ok) errors.push(...keyRes.errors);

    // Timestamps.
    if (!Number.isFinite(rec.created_at) || rec.created_at < 0) {
        errors.push('created_at must be a finite non-negative number (epoch ms)');
    }
    if (!Number.isFinite(rec.updated_at) || rec.updated_at < 0) {
        errors.push('updated_at must be a finite non-negative number (epoch ms)');
    }
    if (Number.isFinite(rec.created_at) && Number.isFinite(rec.updated_at) && rec.created_at > rec.updated_at) {
        errors.push('created_at must be <= updated_at');
    }

    // Optional expires_at.
    if (rec.expires_at !== null && rec.expires_at !== undefined) {
        if (!Number.isFinite(rec.expires_at) || rec.expires_at < 0) {
            errors.push('expires_at must be null or a finite non-negative number (epoch ms)');
        }
    }

    // superseded_by — null or non-self id.
    if (rec.superseded_by !== null && rec.superseded_by !== undefined) {
        if (typeof rec.superseded_by !== 'string') {
            errors.push('superseded_by must be null or a string id');
        } else if (rec.superseded_by === rec.id) {
            errors.push('superseded_by must not equal id (no self-supersession)');
        }
    }

    // Embedding — null or number[] of finite values.
    if (rec.embedding !== null && rec.embedding !== undefined) {
        if (!Array.isArray(rec.embedding)) {
            errors.push('embedding must be null or number[] (Float32Array is not structured-clone-safe; use Array)');
        } else {
            for (let i = 0; i < rec.embedding.length; i++) {
                if (!Number.isFinite(rec.embedding[i])) {
                    errors.push(`embedding[${i}] must be a finite number`);
                    break;
                }
            }
        }
    }

    // md_path — null or string.
    if (rec.md_path !== null && rec.md_path !== undefined && typeof rec.md_path !== 'string') {
        errors.push('md_path must be null or a string');
    }

    return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Throwing wrapper. Used inside `store.js` mutation paths so a malformed
 * record never reaches IDB.
 *
 * @param {*} rec
 * @returns {void}
 * @throws {Error} when validation fails; message lists every error.
 */
export function assertValid(rec) {
    const res = validateRecord(rec);
    if (!res.ok) {
        const err = new Error(`Invalid memory record:\n  - ${res.errors.join('\n  - ')}`);
        // @ts-ignore — extension property for callers who want to surface errors structurally.
        err.errors = res.errors;
        throw err;
    }
}
