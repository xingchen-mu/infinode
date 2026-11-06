import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedHost } from '../server/http/hosts.ts';

test('local names and IP addresses are allowed', () => {
  for (const h of ['localhost', 'localhost:8787', '127.0.0.1:8787', '[::1]:8787', '192.168.1.20:8787', '10.0.0.5', 'app.localhost:5173']) {
    assert.equal(allowedHost(h), true, h);
  }
});

test('other domains are refused, including rebinding tricks', () => {
  for (const h of ['evil.example', 'evil.example:8787', '127.0.0.1.evil.example', 'localhost.evil.example', '', undefined]) {
    assert.equal(allowedHost(h), false, String(h));
  }
});

test('.local names only when shared on the LAN; extra names from ALLOWED_HOSTS', () => {
  assert.equal(allowedHost('my-mac.local:8787'), false);
  assert.equal(allowedHost('my-mac.local:8787', [], true), true);
  assert.equal(allowedHost('Canvas.Example.lan:443', ['canvas.example.lan']), true);
});
