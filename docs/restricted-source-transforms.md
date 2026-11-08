# Source-preserving text transformations

Use the restricted application SDK to propose edits to selected text. Keep
protected content, rendering and durable application state under host authority.
This supports translation, wording corrections and similar bounded document work
without giving a model shell, filesystem, image or database authority.

The entry points and limits are the existing [restricted application contract](restricted-application.md).
There is no new document API, runtime, schema version or tool. The fields below
are an example application-defined output schema, not `/agent/v1` RPC fields.

## Separate editable text from protected content

Represent the document with stable block identifiers. The authenticated host
selects editable text blocks and retains equations, image references/assets and
code independently. A model proposes only text replacements; it does not return
paths, protected bodies, provider settings or application permissions.

One possible proposal is:

```json
{
  "scopeDigest": "host-derived scope marker",
  "documentId": "caller-visible document identifier",
  "sourceRevision": 2,
  "sourceDigest": "digest of the current source snapshot",
  "translations": [
    {
      "blockId": "selected_text_block",
      "sourceDigest": "digest of that source paragraph",
      "text": "Proposed replacement text"
    }
  ]
}
```

Define a closed, bounded JSON schema for the actual fields and selected block
IDs. For a partial correction, accept only the selected IDs, exactly once each.
The host chooses the target language and authorized scope. A digest binds data;
it is neither an authentication token nor proof of ownership or storage safety.

## Bind a proposal to an observed current read

Register a read-only callback closed over the authenticated caller and authorized
document. Its arguments must not accept an account selector, path or endpoint.
Read current state when the callback executes. Return the selected text, current
revision/digests and any necessary protected-block identities. Do not send image
pixels or executable code when the text task does not need them.

If this task requires a fresh read, the host must retain the actual callback
receipt and require it before accepting the proposal. Compare its scope,
document, revision and digest with independently loaded current state. A model's
claim to have read something is insufficient. The generic SDK may return a
schema-valid proposal without calling a tool; it does not promise mandatory
reads or semantic source fidelity on behalf of the application.

Use host-authorized conversation history only. A fresh continuation must reread
changed source rather than trust an earlier proposal's revision or hash. The
optional native DeepSeek client chooses Flash or Pro explicitly from server
configuration; switching processes/providers here is an explicit host action,
not an automatic fallback.

## Validate and apply in the application

After SDK schema validation, the host still checks:

- The actual read receipt, caller ownership and current source tuple agree.
- Every requested text ID appears exactly once; there are no extra IDs or
  attempts to replace protected blocks.
- Each replacement binds the correct paragraph hash. A matching full-document
  hash alone does not establish the paragraph-to-ID association.
- Translation or correction content retains source meaning and caveats. Schema
  success does not establish linguistic accuracy or factual equivalence.
- Untouched text remains valid against current source. If another paragraph
  changed, do not silently retain a stale translation under a new revision.

Apply with the application's real revision/CAS, consent and idempotency
transaction. A lost response replays the original committed receipt; it must not
apply a replacement twice. A reused key with different content conflicts.
The example qualification's synthetic file fixture does not supply a production
database, cross-process locking, authentication or retained-descriptor authority.

Only a successful host commit permits a saved/applied UI state. SDK `completed`
means proposal generation. Do not present it as an application write or repair an
unsafe proposal by silently rewriting its content.

## Render protected content from host state

Merge accepted text into a host-owned template. Preserve protected source bodies
verbatim and render proposed text as text with the application's normal escaping
or sanitization. Do not treat model strings as trusted HTML, file instructions
or external resource URLs.

Verify output bytes independently: equations and code must retain their original
contents, protected blocks must not be duplicated, image references must resolve,
and the referenced image bytes must match their authorized digest. Packaging a
Markdown file without its relative image asset is not complete artifact delivery.
Private application assets still need the app's authenticated broker and deletion
policy; this pattern does not add one.

## Qualified example and limits

A November 8 test used the actual nine-file, zero-dependency private Lite
preview-10 package and native HTTPS client. Its synthetic note had two text
paragraphs plus a TeX equation, a PNG reference and code. Ordinary Chinese
requests asked for translation, then a correction only to the changed second
paragraph. Selected scope, output schema and authorized history were host inputs.

Flash used two requests and one read in about 2.44 seconds. A separate Pro process
used two requests and one current-revision read in about 3.82 seconds. Those are
observations from one short fixture, not a latency benchmark or service guarantee.
Semantic review confirmed the source's non-research, schematic and non-measurement
caveats. The correction changed colours to arrows indicating reading order, not
physical flow, and did not retain the stale colour statement.

An independent verifier checked source revisions 1/2, host output revisions
1/2/3, exact current digests, the untouched first translation, three protected
bodies occurring once, a valid byte-identical PNG at the exported relative link,
and unchanged foreign-account source. Seventeen host rejection controls and two
SDK denied-tool/selector controls ran offline. Both native clients closed without
owned TLS/socket/timer resources. No automatic retry/fallback occurred.

The host preserved protected bodies and image bytes; the model did not reproduce
them or inspect image pixels. This qualifies a scoped text-proposal and host
rendering pattern, not vision, code execution, typesetting, full-document
translation accuracy, native SessionStore, production account authorization,
multiwriter transactions or application deployment. No real private document,
application record, credential rollout or paid image generation was involved.
