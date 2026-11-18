"""Offline parent fixture: owns account scope, history and atomic commit policy."""
import json
import os
import selectors
import subprocess
import sys
import time

node, worker, streams, sdk = sys.argv[1:]
child = subprocess.Popen([node, worker, streams, sdk], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
pending = bytearray()
selector = selectors.DefaultSelector()
selector.register(child.stdout, selectors.EVENT_READ)

def receive():
    deadline = time.monotonic() + 5
    while b'\n' not in pending:
        assert selector.select(max(0, deadline - time.monotonic())), 'worker reply timed out'
        chunk = os.read(child.stdout.fileno(), 65536)
        assert chunk, 'unexpected detach'
        pending.extend(chunk)
        assert len(pending) <= 262145
    line, _, remaining = pending.partition(b'\n')
    pending[:] = remaining
    return json.loads(line)

try:
    ready = receive()
    assert ready['type'] == 'ready' and ready['providerAvailability'] == 'not-probed'
    common = {key: ready[key] for key in ('schemaVersion', 'protocol', 'nonce', 'scopeId')}
    def send(kind, request_id, **fields):
        child.stdin.write((json.dumps(dict(common, type=kind, requestId=request_id, **fields), ensure_ascii=False) + '\n').encode())
        child.stdin.flush()

    records = {'alpha': {'text': 'teh important qualifier stays', 'revision': 7}, 'beta': {'text': 'private other account', 'revision': 3}}
    receipts = set()
    history = []
    for number in (1, 2):
        request_id = f'request_python_{number:04d}'
        send('run', request_id, request={'input': [{'type': 'text', 'text': 'fix that draft please, keep the qualifier. dont save yet'}], 'history': history})
        accepted, read = receive(), receive()
        assert accepted['type'] == 'accepted' and read['type'] == 'read'
        assert read['scopeId'] == common['scopeId'] and read['requestId'] == request_id and read['name'] == 'draft_read'
        assert 'raw_provider_call_id' not in json.dumps(read)
        # Deliberately wrong-scope reply must not free the actual parent read.
        wrong = dict(common, scopeId='account_foreign_02', type='read_result', requestId=request_id, readId=read['readId'], value=records['beta'])
        child.stdin.write((json.dumps(wrong) + '\n').encode());child.stdin.flush()
        assert receive()['code'] == 'SCOPE_MISMATCH'
        send('read_result', request_id, readId=read['readId'], value=records['alpha'])
        result = receive()
        assert result['type'] == 'result' and result['requestId'] == request_id
        proposal = result['result']['proposal']
        assert proposal['text'] == 'the important qualifier stays' and proposal['revision'] == records['alpha']['revision']
        assert result['result']['usage'] == {'steps': 2, 'toolCalls': 1}
        assert records['alpha']['text'].startswith('teh' if number == 1 else 'the')
        # Only the parent commits, under an expected-revision/idempotency receipt.
        if request_id not in receipts:
            records['alpha'] = {'text': proposal['text'], 'revision': proposal['revision'] + 1}
            receipts.add(request_id)
        history = [{'role': 'assistant', 'text': proposal['reply']}]
    assert records['alpha']['revision'] == 9 and records['beta']['revision'] == 3
    child.stdin.close();assert child.wait(timeout=5) == 0
    assert child.stderr.read() == b''
    print(json.dumps({'passed': True, 'invocations': 2, 'reads': 2, 'hostCommits': 2, 'liveModels': 0, 'foreignAccountUnchanged': True}))
finally:
    selector.close()
    if child.poll() is None:
        child.kill();child.wait(timeout=5)
    for stream in (child.stdin, child.stdout, child.stderr):
        if stream and not stream.closed:
            stream.close()
