# Runs on the ComfyUI machine, piped into `python3 -` over SSH by server/models/remote.ts: downloads one model
# file (resuming a .part file), or checks a list of files before a download. The caller puts the job in ARGS
# (base64 JSON) on the first line, so no paths or tokens show up in the process list. Results are JSON lines
# on stdout. Standard library only, Python 3.6+.
import base64
import json
import os
import shutil
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

JOB = json.loads(base64.b64decode(ARGS).decode('utf-8'))  # noqa: F821 (ARGS is prepended by the caller)
UA = 'infinode-model-download'
TIMEOUT = 30
# Per address: CDNs resolve to several, and from some networks a few of them never answer.
CONNECT_TIMEOUT = 5
CHUNK = 256 * 1024
# Keep some room on the disk after the file is written.
MARGIN = 256 * 1024 * 1024


def emit(event, **data):
    data['event'] = event
    sys.stdout.write(json.dumps(data) + '\n')
    sys.stdout.flush()


class Fail(Exception):
    def __init__(self, code, detail='', status=None, partial=False, **extra):
        Exception.__init__(self, detail)
        self.code = code
        self.detail = detail
        self.status = status
        self.partial = partial
        self.extra = extra


class Redirects(urllib.request.HTTPRedirectHandler):
    """Follows 301/302/303/307/308 for GET (Python < 3.11 refuses 308), keeping Range and dropping the token
    when the redirect leaves the host it was meant for (Hugging Face sends files on to its CDN)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if code not in (301, 302, 303, 307, 308):
            return None
        newurl = newurl.replace(' ', '%20')
        kept = dict((k, v) for k, v in req.headers.items() if k.lower() not in ('content-length', 'content-type'))
        if urllib.parse.urlsplit(newurl).netloc != urllib.parse.urlsplit(req.full_url).netloc:
            kept.pop('Authorization', None)
        return urllib.request.Request(newurl, headers=kept, origin_req_host=req.origin_req_host, unverifiable=True)

    http_error_308 = urllib.request.HTTPRedirectHandler.http_error_302


def create_connection(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None):
    """socket.create_connection, but moving on to the next address after CONNECT_TIMEOUT instead of waiting
    the whole read timeout on each address that does not answer (no happy eyeballs in urllib)."""
    host, port = address
    err = None
    for af, socktype, proto, _, sa in socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM):
        sock = None
        try:
            sock = socket.socket(af, socktype, proto)
            sock.settimeout(CONNECT_TIMEOUT)
            if source_address:
                sock.bind(source_address)
            sock.connect(sa)
            sock.settimeout(None if timeout is socket._GLOBAL_DEFAULT_TIMEOUT else timeout)
            return sock
        except OSError as e:
            err = e
            if sock is not None:
                sock.close()
    raise err or OSError('getaddrinfo returned no addresses for %s' % host)


# http.client picks this up when it opens each connection; the script runs in its own process.
socket.create_connection = create_connection
OPENER = urllib.request.build_opener(Redirects)


def open_url(url, token=None, start=0, probe=False):
    headers = {'User-Agent': UA}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if probe:
        headers['Range'] = 'bytes=0-0'
    elif start:
        headers['Range'] = 'bytes=%d-' % start
    try:
        return OPENER.open(urllib.request.Request(url, headers=headers), timeout=TIMEOUT)
    except urllib.error.HTTPError as e:
        if e.code == 416 and start:
            return None  # the partial file is already complete
        raise Fail('http', str(e.reason), status=e.code)
    except (urllib.error.URLError, socket.timeout, OSError) as e:
        raise Fail('network', str(getattr(e, 'reason', e)))


def total_of(resp, start):
    cr = resp.headers.get('Content-Range')
    if cr and '/' in cr:
        t = cr.rsplit('/', 1)[1].strip()
        if t.isdigit():
            return int(t)
    cl = resp.headers.get('Content-Length')
    if cl and cl.strip().isdigit():
        return int(cl) + start
    return None


def existing_parent(path):
    p = os.path.dirname(path)
    while p and not os.path.isdir(p):
        q = os.path.dirname(p)
        if q == p:
            break
        p = q
    return p or '/'


def check_folder(folder):
    # The models folder may not exist yet, but the folder holding it must: otherwise this is the wrong machine.
    if not os.path.isdir(os.path.dirname(folder.rstrip('/'))):
        raise Fail('folder', folder)


def best(errors):
    for e in errors:
        if e.code == 'http':
            return e
    return errors[-1] if errors else Fail('network', 'no source')


def fetch(cand, part, dest, token):
    start = os.path.getsize(part) if os.path.isfile(part) else 0
    resp = open_url(cand['url'], token, start)
    if resp is None:
        os.replace(part, dest)
        emit('done', size=os.path.getsize(dest), url=cand['url'])
        return
    with resp:
        resumed = resp.getcode() == 206 and start > 0
        base = start if resumed else 0
        total = total_of(resp, base)
        received = base
        free = shutil.disk_usage(os.path.dirname(dest)).free
        if total is not None and free < total - received + MARGIN:
            raise Fail('disk', need=total - received, free=free)
        last = 0.0
        with open(part, 'ab' if resumed else 'wb') as f:
            while True:
                try:
                    chunk = resp.read(CHUNK)
                except (socket.timeout, OSError) as e:
                    raise Fail('network', str(e), partial=received > base)
                if not chunk:
                    break
                f.write(chunk)
                received += len(chunk)
                now = time.time()
                if now - last >= 0.5:
                    emit('progress', received=received, total=total, url=cand['url'])
                    last = now
    if total is not None and received < total:
        raise Fail('network', 'connection closed early', partial=True)
    os.replace(part, dest)
    emit('done', size=received, url=cand['url'])


def download(job):
    dest = job['dest']
    if os.path.isfile(dest):
        emit('done', size=os.path.getsize(dest), existed=True)
        return
    check_folder(job['folder'])
    try:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
    except OSError as e:
        raise Fail('folder', job['folder'], reason=str(e))
    part = dest + '.part'
    errors = []
    for cand in job['candidates']:
        try:
            fetch(cand, part, dest, job.get('token') if cand.get('auth') else None)
            return
        except Fail as e:
            # Once bytes came in, retry this file rather than switching sources halfway.
            if e.code != 'http' and e.code != 'network' or e.partial:
                raise
            errors.append(e)
    raise best(errors)


def probe_one(item, token):
    if item.get('dest') and os.path.isfile(item['dest']):
        return {'exists': True, 'size': os.path.getsize(item['dest'])}
    errors = []
    for cand in item['candidates']:
        try:
            resp = open_url(cand['url'], token if cand.get('auth') else None, probe=True)
            with resp:
                # 206 carries the full size in Content-Range; a server ignoring Range sends the whole length.
                partial_without_range = resp.getcode() == 206 and not resp.headers.get('Content-Range')
                return {'size': None if partial_without_range else total_of(resp, 0), 'url': cand['url']}
        except Fail as e:
            errors.append(e)
    e = best(errors)
    return {'error': e.code, 'status': e.status, 'detail': e.detail}


def probe(job):
    token = job.get('token')
    with ThreadPoolExecutor(4) as pool:
        files = list(pool.map(lambda item: probe_one(item, token), job['files']))
    free = None
    folder_ok = True
    for item in job['files']:
        if item.get('folder'):
            try:
                check_folder(item['folder'])
            except Fail:
                folder_ok = False
            if free is None:
                try:
                    free = shutil.disk_usage(existing_parent(item['dest'])).free
                except OSError:
                    pass
    emit('probe', files=files, free=free, folderOk=folder_ok)


def main():
    try:
        if JOB.get('op') == 'probe':
            probe(JOB)
        else:
            download(JOB)
    except Fail as e:
        out = {'code': e.code, 'detail': e.detail, 'status': e.status, 'partial': e.partial}
        out.update(e.extra)
        emit('error', **out)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
    except BrokenPipeError:
        # The caller went away (cancelled): stop quietly, keeping the .part file for a later resume.
        sys.exit(1)
    except Exception as e:  # noqa: BLE001
        emit('error', code='runner', detail='%s: %s' % (type(e).__name__, e))
        sys.exit(1)


main()
