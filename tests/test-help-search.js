/**
 * Browser smoke tests for the Help search index (1.3.10).
 *
 * Pins the search contract:
 *   - Empty / 1-char query returns no results.
 *   - Title match outranks heading match outranks body match.
 *   - Snippets wrap the matched substring in <mark> with surrounding
 *     ellipsis when truncated.
 *   - Per-section results carry the correct doc + section breadcrumb.
 *
 * Bypasses the markdown-loader (which would fetch real docs) by
 * injecting a fixture index via the `_setIndex` test seam.
 */

import { search, _resetIndex, _setIndex } from '../js/help/search-index.js';

const { T } = window;

T.suite('Help search — 1.3.10 ranked substring index');

// ----- Fixture index -----

_resetIndex();
_setIndex({
    docs: [
        {
            id: 'commit-doc',
            title: 'Commit Workflow',
            group: 'Reference',
            sections: [
                { heading: 'Staging', text: 'Stage changes from the diff before pushing.' },
                { heading: 'Diff Review', text: 'The diff viewer commit modal opens with Ctrl+S.' },
            ],
        },
        {
            id: 'plugin-doc',
            title: 'Plugin SDK',
            group: 'Building',
            sections: [
                { heading: 'Manifest', text: 'Plugins ship a manifest JSON with id, version, and capabilities.' },
                { heading: 'Activation', text: 'The host calls activate(ctx) when a plugin is needed.' },
            ],
        },
        {
            id: 'memory-doc',
            title: 'Memory',
            group: 'Concepts',
            sections: [
                { heading: 'Promotion', text: 'Memory promotion happens at commit time.' },
            ],
        },
    ],
});

// ----- 1. Short queries return no results -----

T.eq(search('').length, 0, 'Empty query returns no results');
T.eq(search('a').length, 0, 'Single-char query returns no results');
T.eq(search('  ').length, 0, 'Whitespace-only query returns no results');

// ----- 2. Title match wins -----

const commitResults = search('commit');
T.assert(commitResults.length >= 3, `"commit" surfaces multiple hits (got ${commitResults.length})`);
const top = commitResults[0];
T.eq(top.docId, 'commit-doc', 'Top hit is the doc whose title contains the query');
T.eq(top.score, 10, 'Title-match score is 10');

// ----- 3. Heading match outranks body match -----

const manifestResults = search('manifest');
T.assert(manifestResults.length >= 1, '"manifest" surfaces at least one hit');
const manifestTop = manifestResults[0];
T.eq(manifestTop.section, 'Manifest', 'Heading-match result reports its heading as the section');
T.eq(manifestTop.score, 5, 'Heading-match score is 5');

const promotionResults = search('promotion');
const promotionTop = promotionResults[0];
T.assert(promotionTop.score >= 5, 'Heading match for "promotion" scores at least 5 (heading-rank)');

// ----- 4. Body-only match scores 1 -----

const stageResults = search('stage');
const stageBodyHit = stageResults.find(r => r.docId === 'commit-doc' && r.section === 'Staging');
T.assert(stageBodyHit && stageBodyHit.score >= 1, '"stage" body-match result is present at score>=1');

// ----- 5. Snippet wraps match in <mark> -----

const snippet = manifestTop.snippet;
T.assert(/<mark>[^<]+<\/mark>/.test(snippet), `Snippet contains a <mark>...</mark> wrap (got: ${snippet})`);
T.assert(snippet.toLowerCase().includes('manifest'), 'Snippet text includes the matched query');

// ----- 6. Snippet ellipsis on truncation -----

const longTextDoc = {
    docs: [{
        id: 'long-doc',
        title: 'Long Doc',
        group: '',
        sections: [{
            heading: 'Wide Section',
            text: 'a'.repeat(80) + ' needle ' + 'b'.repeat(80),
        }],
    }],
};
_setIndex(longTextDoc);
const longResults = search('needle');
T.assert(longResults.length === 1, '"needle" surfaces exactly one hit in fixture');
const longSnippet = longResults[0].snippet;
T.assert(longSnippet.startsWith('…') && longSnippet.endsWith('…'),
    'Snippet truncated on both sides shows ellipsis');
T.assert(longSnippet.includes('<mark>needle</mark>'), 'Truncated snippet still highlights the match');

// ----- 7. Results capped at 30 -----

const manyDocs = { docs: [] };
for (let i = 0; i < 50; i++) {
    manyDocs.docs.push({
        id: `doc-${i}`, title: `Doc ${i}`, group: '',
        sections: [{ heading: 'sec', text: 'find me here please' }],
    });
}
_setIndex(manyDocs);
const manyResults = search('find');
T.assert(manyResults.length <= 30, `Results capped at 30 (got ${manyResults.length})`);

// ----- 8. Reset -----

_resetIndex();
T.eq(search('anything').length, 0, 'After _resetIndex, search returns no results');
