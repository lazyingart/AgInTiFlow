# Concurrent restricted conversations and cancellation

An application binds a runner's read callbacks to one authenticated scope and
supplies that scope's authorized history. Multiple such runners can share a
stateless provider transport. Sharing a client does not authorize shared account
data, histories, controllers or persistence. The SDK remains a proposal loop;
the host owns authentication, session storage, quotas and any commit.

Cancellation returns no proposal. If a trusted callback ignores its aborted
signal, its runner's capacity remains charged until that callback settles.
Neither a late success nor a late rejection may become a cancelled result or
an unhandled rejection. Another scope's runner can complete independently.
Do not create fresh runners to evade `BUSY`; an application must also enforce
aggregate admission across its runner instances and drain old work before an
explicit provider continuation.

`npm run test:restricted-concurrency` exercises two gated, account-bound reads
against synthetic file-backed records and authorized histories. The records have
the same ID; scripted providers also reuse a tool-call ID across scopes. It
cancels one invocation, verifies its capacity remains charged, completes the
other, then settles the old read and explicitly continues with Pro using loaded
host history and the latest revision. Both late success and late failure pass.
The first two reads are concurrent, so their completion order is not asserted.
The tests use bounded gates, no timing sleeps, network, model or real user data.

## Live qualification

On 2026-11-05, the registry-installed `0.20.355-integration.0` passed the same
scenario with ordinary Chinese/English prompts. Two caller-bound SDK runners
shared one DeepSeek client. Five real requests completed in approximately 5.1
seconds: three Flash requests and two explicitly selected Pro requests.

- Both initial reads were in flight before cancellation. The cancelled scope
  returned `CANCELLED` with no proposal and rejected a new invocation as `BUSY`
  while its old read remained pending.
- The other account completed in English at revision 31 with its own source.
- The synthetic host advanced the first account from revision 5 to 6. The old
  read was allowed to settle and its result was discarded. A fresh Pro runner
  loaded that account's persisted history, read revision 6, and retained the
  Chinese language, subject and newly added remark.
- Individual captured requests contain only their own history marker and source
  data. SDK calls leave record bytes unchanged before and after the deliberate
  host edit. Parent abort listeners are removed and no unhandled rejection is
  observed. The response captures are completion-ordered; they are not paired
  with requests by array index.

The fixture owns synthetic state/history. It is not a production authentication
system, transaction store, native SessionStore, OS-process restart or aggregate
resource-admission qualification. Cancellation occurs during a gated host read
after a model tool response, not during live generation. These limits matter
when adapting the example to an application. No SDK defect or runtime change is
claimed, and this test/docs checkpoint does not require a new npm release.
