# API-Backed Complete Question Directory Design

## Summary

Replace the right-side question directory's DOM-only data source with the current ChatGPT conversation response. The directory continues to show only user messages, follows only the branch selected by the page, and keeps the existing visual interaction. DOM discovery remains available as a fallback and as a temporary source for newly submitted messages that the conversation response does not yet contain.

Clicking a directory item must also work when its message is not currently rendered. The extension will drive ChatGPT's scroll container until the host page renders the target message, then reuse the existing offset-corrected scroll behavior for final positioning.

## Goals

- Show every non-empty user message on the currently selected conversation branch.
- Exclude assistant, system, tool, hidden alternate-branch, and empty user messages.
- Keep the directory usable while a new user message is still being persisted.
- Automatically load and locate a selected message that is outside the currently rendered DOM window.
- Preserve the current sidebar presentation and active-item behavior.
- Fall back to the current DOM-derived directory when the internal conversation request fails.
- Keep conversation content and authentication material in memory only.

## Non-Goals

- Showing assistant replies in the right-side directory.
- Showing messages from inactive branches.
- Replacing the left-side AI response heading outline.
- Persisting or exporting conversations.
- Calling any third-party service.
- Mutating ChatGPT's private application state or rendering API response content into ChatGPT's message area.
- Providing a stable public API integration; the conversation endpoint is an internal site dependency.

## Current Behavior

`dom-adapter.js` scans the page's `main` element for user-message selectors, falls back to article and section heuristics, extracts the first meaningful text line, and assigns sequential question IDs. `index.js` treats the resulting elements as both the directory data source and scroll targets. This means a question cannot appear in the directory unless ChatGPT has rendered its message element.

The left-side message outline is independent. It selects the most visible assistant response and extracts its `h1` through `h6` elements; that flow remains unchanged except for shared route lifecycle handling.

## Selected Approach

Use a same-origin conversation request as the canonical directory source and bind response messages to rendered DOM elements by message ID. Keep the existing DOM scan as a degraded source. Do not intercept ChatGPT's `fetch`, inject a main-world bridge, or add a background service worker. If the same-origin request is proven impossible during implementation, stop and revise this design with the user instead of silently expanding the integration surface.

The internal endpoint dependency is isolated behind one module so a future endpoint or response-shape change does not affect sidebar rendering or navigation.

## Components

### `src/content/conversation-api.js`

Owns conversation identity, authentication, request execution, response validation, branch reconstruction, and user-question projection.

It exposes a namespace API with these responsibilities:

- Extract a conversation ID from ordinary and project conversation routes.
- Request `/backend-api/conversation/{conversationId}` with same-origin credentials.
- On an authentication failure, request `/api/auth/session`, retain any returned access token in local function scope only, and retry the conversation request once with an `Authorization: Bearer` header.
- Accept an `AbortSignal` and stop work immediately when the route changes or a newer refresh supersedes it.
- Validate that the response has a `mapping` object and a string `current_node` referencing a mapping entry.
- Follow each node's `parent` from `current_node` to the root, detect cycles, and reverse the result into chronological branch order.
- Preserve every branch node in an internal ordered representation so navigation can compare user targets with rendered assistant or system-message anchors.
- Project only non-empty `author.role === "user"` messages into question items.

### `src/content/message-navigator.js`

Owns cancellable navigation to rendered and unrendered messages.

It receives an ordered active branch, a target message ID, the scroll container, and DOM adapter callbacks. It never parses API responses or renders sidebar UI.

### `src/content/dom-adapter.js`

Retains ChatGPT DOM knowledge and scrolling primitives. Its complete-directory builder is replaced by narrower operations:

- Scan currently rendered user messages for degraded mode and pending-message merging.
- Find a rendered turn by response message ID.
- Collect rendered branch message IDs and their elements.
- Observe message rendering changes during navigation.
- Scroll the host container by an explicit amount or position.
- Perform final target scrolling and delayed offset correction.

Generated extension elements remain excluded from all scans.

### `src/content/index.js`

Owns application state and orchestration:

- Route lifecycle and request cancellation.
- API refresh scheduling and stale-response rejection.
- In-memory cache for the active conversation.
- Merge of canonical API questions with newly rendered DOM-only questions.
- Sidebar status and active-item state.
- Navigation lifecycle and cancellation.
- Existing assistant-outline refresh behavior.

### `src/content/sidebar.js`

Continues rendering the right-side rail and expanded list. Directory items no longer require an `element`. It accepts a small status model for loading, degraded sync, and navigation progress.

### `manifest.json`

Loads `conversation-api.js` and `message-navigator.js` before `index.js`. No background worker, persistent storage permission, or third-party host permission is added.

## Route and Request Flow

1. `index.js` detects a supported conversation route.
2. It derives the conversation ID and increments a request-generation counter.
3. It aborts any prior conversation request or target navigation.
4. It renders available DOM questions immediately so the existing directory does not disappear while loading.
5. It requests the conversation response.
6. It ignores the result if its generation is no longer current.
7. It reconstructs the selected branch from the response's `current_node` parent chain.
8. It projects branch user messages into canonical directory items.
9. It merges rendered DOM-only user messages that are not yet represented by a canonical message ID.
10. It renders the result and binds any currently available target elements.

The same flow runs after route changes, branch changes, edits, and newly submitted user messages. Mutation-driven refreshes are debounced by 500 milliseconds and coalesced so streaming assistant output does not produce a request storm.

## Active-Branch Reconstruction

Starting at `current_node`, the parser repeatedly reads `mapping[nodeId]` and follows `node.parent` until the parent is null. It records visited node IDs and rejects a cycle or missing referenced node as an invalid response. The collected nodes are reversed to chronological order.

Each internal branch entry contains:

```js
{
  nodeId,
  messageId,
  role,
  branchIndex,
  message
}
```

The user-facing question projection contains:

```js
{
  id: `question-${messageId}`,
  messageId,
  nodeId,
  title,
  branchIndex,
  element: null,
  source: "api"
}
```

Messages without a stable message ID use their mapping node ID as the stable key. Alternate children are never traversed, so inactive branches cannot enter the directory.

## Question Text Extraction

The parser reads textual content from the message's content parts in source order. String parts are included directly. Structured parts are included only when they expose an explicit textual value; image, audio, file, tool, and metadata parts are ignored.

The resulting text is trimmed and split into lines. Empty lines and standalone speaker labels are removed. The first meaningful line is whitespace-normalized and truncated to 120 Unicode code points. A user message with no meaningful text is excluded.

The existing DOM title extraction follows the same normalization rules so canonical and pending items do not visibly change title when synchronized.

## Canonical and Pending-Message Merge

API questions are authoritative and retain branch order. Rendered DOM questions are matched to them by `data-message-id` first. A DOM question without a known message ID is matched only when its normalized full text equals one unmatched API question near the end of the branch; otherwise it is treated as a pending local item.

Pending items are appended in DOM order and use a DOM-scoped temporary ID. On the next successful response, a matching canonical message replaces the pending item instead of producing a duplicate. A route change discards all pending items from the previous conversation.

## Navigation Algorithm

Only one navigation operation can run at a time. Starting a new one aborts the previous operation.

### Direct target

If the target's message ID is already represented by a rendered turn element, navigation uses the existing offset-aware scroll operation and delayed correction. The sidebar holds the selected item active until positioning settles or the navigation deadline expires.

### Unrendered target

If no target element exists:

1. Map all currently rendered message IDs to their active-branch indices.
2. Select the rendered anchor with the smallest absolute branch-index distance from the target.
3. If the target precedes the anchor, scroll upward by 80 percent of the visible container height. If it follows the anchor, scroll downward by the same amount.
4. If there is no recognized rendered anchor, estimate a scroll position from `target.branchIndex / (branch.length - 1)` and the container's available scroll range.
5. Wait for either a relevant DOM mutation, a scroll-settle frame, or 250 milliseconds, then rescan rendered IDs.
6. Repeat until the target appears, the user cancels, the route changes, a scroll boundary remains unchanged for three attempts, or ten seconds elapse.
7. When the target appears, perform direct target positioning and delayed offset correction.

Scrolling to a boundary intentionally gives ChatGPT's own lazy-loading behavior time to fetch and render older history. The extension does not inject response messages into ChatGPT's private UI tree.

### Navigation limits

An independently fetched conversation response does not guarantee that ChatGPT will accept or render every message. If the host stops supporting scroll-triggered history rendering, the directory can remain complete while navigation fails. After the bounded ten-second attempt, the sidebar reports that ChatGPT did not load the selected message and leaves the directory usable.

## Active Question Tracking

Rendered API questions continue using element geometry relative to the existing 160-pixel threshold. When the closest rendered element is an assistant or system entry, the active user question is the nearest preceding user entry on the active branch. Unrendered questions are never selected merely because of their estimated position.

During programmatic navigation, the target remains locked as active. The lock is released when final positioning settles, the deadline expires, the route changes, a different item is selected, or the user makes a scroll movement substantially different from the extension's requested movement.

## Refresh and Cache Policy

- Initial supported route: immediate request.
- Route change: abort, clear route-local pending state, and request immediately.
- User submission, edit, or branch-selection mutation: immediate DOM merge followed by a 500-millisecond debounced request.
- Authentication retry: one retry per refresh operation.
- Successful response: retained only in the active page's memory, keyed by conversation ID.
- Cached data can be rendered immediately when returning to a conversation, but a background refresh still runs.
- No conversation response or token is written to extension storage, Web Storage, IndexedDB, logs, or DOM attributes.

## Error Handling

- `401` or `403`: refresh session authentication once and retry once.
- `404`: treat the route as unavailable through the conversation endpoint and use DOM degraded mode.
- Network failure or timeout: keep the last successful canonical directory when available, merge current DOM questions, and mark sync as degraded.
- Invalid JSON, missing `mapping`, invalid `current_node`, broken parent reference, or cycle: reject the response without partially replacing canonical state.
- Stale request generation: silently discard the result.
- Navigation timeout or fixed scroll boundary: stop scrolling and show a non-blocking failure state.

Errors never remove a usable existing directory and never interrupt ChatGPT's normal input or response flow.

## Sidebar States

The sidebar supports these non-blocking states:

- `loading`: initial canonical synchronization is in progress.
- `ready`: canonical active-branch data is current.
- `degraded`: DOM or stale canonical data is being shown because synchronization failed.
- `navigating`: an unrendered target is being loaded and located.
- `navigation-error`: the selected target could not be rendered within the bounded attempt.

The collapsed rail remains usable in every state. Status text appears only in the expanded card and does not use modal dialogs or page-level notifications.

## Security and Privacy

- Requests are restricted to relative `chatgpt.com` endpoints.
- No third-party host permission or network destination is introduced.
- Access tokens are never persisted, attached to DOM nodes, included in thrown error messages, or logged.
- Full response bodies and full message text are not logged.
- Only normalized titles needed by the sidebar remain in application state after projection; raw response ownership remains scoped to parsing and the active branch model needed for navigation.
- DOM insertion continues to use `textContent`, not HTML interpretation.

## Testing Strategy

Add a development-only test setup using Node's built-in test runner. A DOM simulation library may be installed as a development dependency; runtime extension code remains dependency-free and is still loaded directly by Chrome.

Pure parser tests cover:

- Normal parent-chain reconstruction and chronological reversal.
- Exclusion of inactive branch children.
- Exclusion of assistant, system, tool, and empty user messages.
- Text and mixed-media content extraction.
- Missing nodes, invalid `current_node`, and parent cycles.
- Stable key fallback when a message ID is absent.
- Ordinary and project conversation route parsing.

Request lifecycle tests cover:

- Credentialed same-origin request.
- One authentication refresh and retry on `401` or `403`.
- Abort propagation.
- Timeout behavior.
- Stale response rejection.

Merge tests cover:

- Message-ID binding.
- Pending DOM append.
- Canonical replacement of a pending item.
- Duplicate-title messages remaining distinct.
- Pending-state reset on route change.

Navigation tests cover:

- Direct rendered-target positioning.
- Upward and downward virtualized loading.
- Proportional first positioning without a rendered anchor.
- Successful rescan after a DOM mutation.
- Cancellation by a new selection or route change.
- Scroll-boundary and ten-second termination.
- Final offset correction after delayed layout changes.

Manual Chrome verification covers ordinary conversations, project conversations, edited branches, branch switching, newly submitted messages, long virtualized histories, narrow viewports, and API-failure degraded mode.

## Acceptance Criteria

- The right directory shows all non-empty user messages on the response's current-node parent chain and no messages from inactive branches.
- A newly submitted user message appears without waiting for the canonical refresh and does not duplicate after synchronization.
- Clicking a rendered question retains the current accurate jump behavior.
- Clicking an unrendered question automatically drives loading and positions the target when ChatGPT exposes it through scrolling.
- Failed synchronization leaves a functional DOM-derived directory.
- Failed navigation terminates within ten seconds and does not leave automatic scrolling active.
- Switching routes or branches cannot display stale questions from the previous state.
- The left-side assistant heading outline retains its current behavior.
- No conversation content or authentication token is persisted or sent outside `chatgpt.com`.
